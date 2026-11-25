package livesessions

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"
)

type Relay struct {
	store                      *Store
	auth                       Authorize
	requests, writers, waiters chan struct{}
	mu                         sync.Mutex
	sending                    int
}

func New(store *Store, auth Authorize) *Relay {
	return &Relay{store: store, auth: auth, requests: make(chan struct{}, 48), writers: make(chan struct{}, 2), waiters: make(chan struct{}, 32)}
}
func admit(slots chan struct{}) bool {
	select {
	case slots <- struct{}{}:
		return true
	default:
		return false
	}
}
func reply(w http.ResponseWriter, code int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	enc := json.NewEncoder(w)
	enc.SetEscapeHTML(false)
	_ = enc.Encode(value)
}
func refuse(w http.ResponseWriter, code int) {
	reply(w, code, map[string]string{"error": http.StatusText(code)})
}
func (h *Relay) allowed(w http.ResponseWriter, r *http.Request, b string, scope AuthRequest) bool {
	code := h.auth(r.Context(), b, scope)
	if code == 200 {
		return true
	}
	if code == 410 {
		h.store.retire(scope.Key)
	}
	refuse(w, code)
	return false
}
func (h *Relay) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	if r.URL.EscapedPath() != r.URL.Path {
		refuse(w, 404)
		return
	}
	route, ok := strings.CutPrefix(r.URL.Path, "/v1/live/rooms/")
	parts := strings.Split(route, "/")
	if !ok || len(parts) != 4 {
		refuse(w, 404)
		return
	}
	k := Key{parts[0], parts[1], parts[2]}
	if !k.valid() {
		refuse(w, 404)
		return
	}
	b := bearer(r)
	if b == "" {
		refuse(w, 401)
		return
	}
	if !admit(h.requests) {
		refuse(w, 429)
		return
	}
	defer func() { <-h.requests }()
	op := parts[3]
	var mutation Mutation
	auth := AuthRequest{Key: k, Action: "read"}
	switch {
	case (op == "checkpoint" && r.Method == "PUT") || (op == "append" && r.Method == "POST"):
		if !admit(h.writers) {
			refuse(w, 429)
			return
		}
		defer func() { <-h.writers }()
		limit := maxAppend
		if op == "checkpoint" {
			limit = maxSession
		}
		dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, int64(2*limit+32768)))
		dec.DisallowUnknownFields()
		wire := struct {
			*Mutation
			Records *string `json:"records"`
		}{Mutation: &mutation}
		if e := dec.Decode(&wire); e != nil {
			var tooLarge *http.MaxBytesError
			if errors.As(e, &tooLarge) {
				refuse(w, 413)
			} else {
				refuse(w, 400)
			}
			return
		}
		if wire.Records == nil {
			refuse(w, 400)
			return
		}
		mutation.Records = *wire.Records
		if dec.Decode(new(any)) != io.EOF || mutation.Base == nil || *mutation.Base < 0 || !digestPattern.MatchString(mutation.BaseHash) || !digestPattern.MatchString(mutation.Hash) ||
			!uuid.MatchString(mutation.Request) || !uuid.MatchString(mutation.Device) || mutation.Sources == nil || len(mutation.Sources) > 256 || (op == "append" && mutation.Records == "") {
			refuse(w, 400)
			return
		}
		if len(mutation.Records) > limit {
			refuse(w, 413)
			return
		}
		for _, s := range mutation.Sources {
			if !uuid.MatchString(s) {
				refuse(w, 400)
				return
			}
		}
		auth.Action = "write"
		auth.Device = mutation.Device
		auth.Sources = &mutation.Sources
	case (op == "content" || op == "wait") && r.Method == "GET":
	default:
		refuse(w, 404)
		return
	}
	if !h.allowed(w, r, b, auth) {
		return
	}
	room, release, e := h.store.acquire(k)
	if e != nil {
		if errors.Is(e, errCapacity) {
			refuse(w, 429)
		} else {
			refuse(w, 503)
		}
		return
	}
	defer release()
	if auth.Action == "write" {
		if !validRows(mutation.Records) {
			refuse(w, 400)
			return
		}
		pos, e := h.store.mutate(k, room, mutation, op == "checkpoint")
		switch {
		case errors.Is(e, errConflict):
			reply(w, 409, map[string]any{"code": "live_cursor_mismatch", "cursor": pos.Cursor, "hash": pos.Hash})
		case errors.Is(e, errCapacity):
			refuse(w, 413)
		case e != nil:
			refuse(w, 503)
		default:
			reply(w, 200, pos)
		}
		return
	}
	q := r.URL.Query()
	cursor := int64(-1)
	if values, ok := q["cursor"]; ok {
		cursor, e = strconv.ParseInt(q.Get("cursor"), 10, 64)
		if e != nil || cursor < 0 || len(values) != 1 {
			refuse(w, 400)
			return
		}
	}
	if op == "wait" {
		if cursor < 0 {
			refuse(w, 400)
			return
		}
		h.wait(w, r, room, cursor, b, auth)
		return
	}
	hash := q.Get("hash")
	if (cursor >= 0 && (len(q["hash"]) != 1 || !digestPattern.MatchString(hash))) || (cursor < 0 && len(q["hash"]) != 0) {
		refuse(w, 400)
		return
	}
	room.mu.Lock()
	if room.fault {
		room.mu.Unlock()
		refuse(w, 503)
		return
	}
	offset, reset := room.tail(cursor, hash)
	size := len(room.body) - offset
	head := room.head
	h.mu.Lock()
	if h.sending+size > maxSession {
		h.mu.Unlock()
		room.mu.Unlock()
		refuse(w, 429)
		return
	}
	h.sending += size
	h.mu.Unlock()
	defer func() { h.mu.Lock(); h.sending -= size; h.mu.Unlock() }()
	data := string(room.body[offset:])
	room.mu.Unlock()
	if !h.allowed(w, r, b, auth) {
		return
	}
	reply(w, 200, struct {
		Position
		Reset   bool   `json:"reset"`
		Records string `json:"records"`
	}{head, reset, data})
}
func (h *Relay) wait(w http.ResponseWriter, r *http.Request, room *room, cursor int64, b string, scope AuthRequest) {
	if !admit(h.waiters) {
		refuse(w, 429)
		return
	}
	defer func() { <-h.waiters }()
	room.mu.Lock()
	if room.fault || room.watchers >= 8 {
		fault := room.fault
		room.mu.Unlock()
		if fault {
			refuse(w, 503)
		} else {
			refuse(w, 429)
		}
		return
	}
	room.watchers++
	notify := room.changed
	pending := cursor != room.head.Cursor
	room.mu.Unlock()
	defer func() { room.mu.Lock(); room.watchers--; room.mu.Unlock() }()
	if !pending {
		select {
		case <-r.Context().Done():
			return
		case <-notify:
			pending = true
		case <-time.After(10 * time.Second):
		}
	}
	if pending {
		select {
		case <-r.Context().Done():
			return
		case <-time.After(100 * time.Millisecond):
		}
	}
	// Permission can change during the held request. Hints reveal activity and
	// must be authorized again before sending even an empty timeout response.
	room.mu.Lock()
	cursor = room.head.Cursor
	fault := room.fault
	room.mu.Unlock()
	if fault {
		refuse(w, 503)
		return
	}
	if !h.allowed(w, r, b, scope) {
		return
	}
	reply(w, 200, map[string]int64{"cursor": cursor})
}
