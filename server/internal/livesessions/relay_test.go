package livesessions

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

var testKey = Key{id(1), id(2), id(3)}

func id(n int) string { return fmt.Sprintf("00000000-0000-4000-8000-%012x", n) }

const first = "{\"role\":\"user\",\"text\":\"First\"}\n"
const second = "{\"role\":\"assistant\",\"text\":\"Second\"}\n"

func mutation(idNum int, base Position, records, all string) Mutation {
	return Mutation{Request: id(idNum), Device: id(4), Sources: []string{}, Base: &base.Cursor, BaseHash: base.Hash, Hash: digest([]byte(all)), Records: records}
}

type exchange struct {
	code int
	body []byte
}

func call(t *testing.T, h http.Handler, k Key, op, method, bearer string, body any) exchange {
	t.Helper()
	raw, e := json.Marshal(body)
	if e != nil {
		t.Fatal(e)
	}
	url := "/v1/live/rooms/" + k.Project + "/" + k.Resource + "/" + k.Episode + "/" + op
	req := httptest.NewRequest(method, url, bytes.NewReader(raw))
	req.Header.Set("Authorization", "Bearer "+bearer)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)
	if w.Header().Get("Cache-Control") != "no-store" {
		t.Error("response cacheable")
	}
	return exchange{w.Code, w.Body.Bytes()}
}
func (x exchange) require(t *testing.T, status int, out any) {
	t.Helper()
	if x.code != status {
		t.Fatalf("want %d, got %d: %s", status, x.code, x.body)
	}
	if out != nil {
		if e := json.Unmarshal(x.body, out); e != nil {
			t.Fatal(e)
		}
	}
}

type content struct {
	Position
	Reset   bool
	Records string
}

func TestRelayChecksScopeDigestRetryRewriteAndRecovery(t *testing.T) {
	var stopped atomic.Bool
	dir := t.TempDir()
	authorize := func(_ context.Context, b string, a AuthRequest) int {
		if a.Key != testKey || stopped.Load() {
			return 410
		}
		if b != "Bearer owner" && b != "Bearer peer" {
			return 403
		}
		if a.Action == "write" && (b != "Bearer owner" || a.Device != id(4) || a.Sources == nil) {
			return 403
		}
		return 200
	}
	store, e := Open(dir)
	if e != nil {
		t.Fatal(e)
	}
	h := New(store, authorize)
	empty := Position{Hash: emptyHash}
	cp := mutation(11, empty, first, first)
	var one, two, after Position
	call(t, h, testKey, "checkpoint", "PUT", "peer", cp).require(t, 403, nil)
	call(t, h, testKey, "checkpoint", "PUT", "owner", cp).require(t, 200, &one)
	if one.Cursor != 1 || one.Hash != digest([]byte(first)) {
		t.Fatal(one)
	}
	call(t, h, testKey, "content", "GET", "stranger", nil).require(t, 403, nil)
	fragment := mutation(12, one, second, first+second)
	damaged := fragment
	damaged.Hash = emptyHash
	call(t, h, testKey, "append", "POST", "owner", damaged).require(t, 409, nil)
	call(t, h, testKey, "append", "POST", "owner", fragment).require(t, 200, &two)
	call(t, h, testKey, "append", "POST", "owner", fragment).require(t, 200, &after)
	if after != two || two.Cursor != 2 {
		t.Fatal(two, after)
	}
	call(t, h, testKey, "checkpoint", "PUT", "owner", cp).require(t, 200, &after)
	if after != one {
		t.Fatal("prior receipt was lost", after)
	}
	stale := mutation(22, one, second, first+second)
	call(t, h, testKey, "append", "POST", "owner", stale).require(t, 409, nil)
	var c content
	call(t, h, testKey, "content?cursor=1&hash="+one.Hash, "GET", "peer", nil).require(t, 200, &c)
	if c.Reset || c.Records != second || c.Position != two {
		t.Fatal(c)
	}
	call(t, h, testKey, "content?cursor=1&hash="+emptyHash, "GET", "peer", nil).require(t, 200, &c)
	if !c.Reset || c.Records != first+second {
		t.Fatal(c)
	}
	call(t, h, testKey, "content?cursor=0&hash="+emptyHash, "GET", "peer", nil).require(t, 200, &c)
	if !c.Reset || c.Records != first+second {
		t.Fatal(c)
	}
	// A partial last write may occur before fsync. Previously acknowledged records survive.
	store.Close()
	f, e := os.OpenFile(filepath.Join(dir, testKey.name()), os.O_APPEND|os.O_WRONLY, 0)
	if e != nil {
		t.Fatal(e)
	}
	if _, e = f.Write([]byte{0, 0, 0, 30, '{'}); e != nil {
		t.Fatal(e)
	}
	f.Close()
	store, e = Open(dir)
	if e != nil {
		t.Fatal(e)
	}
	h = New(store, authorize)
	call(t, h, testKey, "append", "POST", "owner", fragment).require(t, 200, &after)
	if after != two {
		t.Fatal(after)
	}
	rewrite := mutation(13, two, second, second)
	call(t, h, testKey, "checkpoint", "PUT", "owner", rewrite).require(t, 200, &after)
	if after.Cursor != 3 {
		t.Fatal(after)
	}
	call(t, h, testKey, "content?cursor=2&hash="+two.Hash, "GET", "peer", nil).require(t, 200, &c)
	if !c.Reset || c.Records != second {
		t.Fatal(c)
	}
	store.Close()
	store, e = Open(dir)
	if e != nil {
		t.Fatal(e)
	}
	defer store.Close()
	h = New(store, authorize)
	call(t, h, testKey, "checkpoint", "PUT", "owner", rewrite).require(t, 200, &after)
	if after.Cursor != 3 {
		t.Fatal(after)
	}
	stopped.Store(true)
	x := call(t, h, testKey, "content", "GET", "peer", nil)
	x.require(t, 410, nil)
	if bytes.Contains(x.body, []byte("Second")) {
		t.Fatal("revoked content")
	}
	if _, e := os.Stat(filepath.Join(dir, testKey.name())); !os.IsNotExist(e) {
		t.Fatalf("terminal journal still exists: %v", e)
	}
	call(t, h, testKey, "append", "POST", "owner", fragment).require(t, 410, nil)
}

func TestNotificationsCoalesceAndRecheckAuthorization(t *testing.T) {
	store, e := Open(t.TempDir())
	if e != nil {
		t.Fatal(e)
	}
	defer store.Close()
	var denied atomic.Bool
	h := New(store, func(_ context.Context, b string, a AuthRequest) int {
		if b == "Bearer peer" && denied.Load() {
			return 403
		}
		return 200
	})
	var pos Position
	call(t, h, testKey, "checkpoint", "PUT", "owner", mutation(11, Position{Hash: emptyHash}, first, first)).require(t, 200, &pos)
	// Once watchers reaches one, the subscriber has passed its online admission check.
	waiter := func(cursor int64) chan exchange {
		ch := make(chan exchange, 1)
		go func() { ch <- call(t, h, testKey, fmt.Sprintf("wait?cursor=%d", cursor), "GET", "peer", nil) }()
		r, release, e := store.acquire(testKey)
		if e != nil {
			t.Fatal(e)
		}
		defer release()
		deadline := time.Now().Add(time.Second)
		for time.Now().Before(deadline) {
			r.mu.Lock()
			watching := r.watchers
			r.mu.Unlock()
			if watching > 0 {
				return ch
			}
			time.Sleep(time.Millisecond)
		}
		t.Fatal("subscriber did not enter wait")
		return nil
	}
	ch := waiter(1)
	call(t, h, testKey, "append", "POST", "owner", mutation(12, pos, second, first+second)).require(t, 200, &pos)
	call(t, h, testKey, "append", "POST", "owner", mutation(13, pos, second, first+second+second)).require(t, 200, &pos)
	var hint map[string]any
	select {
	case value := <-ch:
		value.require(t, 200, &hint)
	case <-time.After(time.Second):
		t.Fatal("notification stalled")
	}
	if len(hint) != 1 || hint["cursor"] != float64(3) {
		t.Fatal("unexpected hint", hint)
	}
	ch = waiter(3)
	denied.Store(true)
	call(t, h, testKey, "append", "POST", "owner", mutation(14, pos, second, first+second+second+second)).require(t, 200, &pos)
	select {
	case value := <-ch:
		value.require(t, 403, nil)
		if bytes.Contains(value.body, []byte("cursor")) {
			t.Fatal("revoked hint")
		}
	case <-time.After(time.Second):
		t.Fatal("revocation stalled")
	}
}
func TestHeldAndOutgoingCapacity(t *testing.T) {
	store, e := Open(t.TempDir())
	if e != nil {
		t.Fatal(e)
	}
	defer store.Close()
	h := New(store, func(context.Context, string, AuthRequest) int { return 200 })
	var head Position
	call(t, h, testKey, "checkpoint", "PUT", "owner", mutation(11, Position{Hash: emptyHash}, first, first)).require(t, 200, &head)
	r, release, e := store.acquire(testKey)
	if e != nil {
		t.Fatal(e)
	}
	defer release()
	r.watchers = 8
	call(t, h, testKey, "wait?cursor=1", "GET", "peer", nil).require(t, 429, nil)
	r.watchers = 0
	h.sending = maxSession
	call(t, h, testKey, "content", "GET", "peer", nil).require(t, 429, nil)
	h.sending = 0
	for i := 1; i < maxRooms; i++ {
		k := testKey
		k.Episode = id(100 + i)
		_, done, e := store.acquire(k)
		if e != nil {
			t.Fatal(e)
		}
		done()
	}
	k := testKey
	k.Episode = id(1000)
	call(t, h, k, "checkpoint", "PUT", "owner", mutation(21, Position{Hash: emptyHash}, first, first)).require(t, 429, nil)
	bad := mutation(12, head, "{\"role\":\"assistant\",\"text\":\"x\",\"tool\":\"hidden\"}\n", "")
	call(t, h, testKey, "append", "POST", "owner", bad).require(t, 400, nil)
}
func TestAuthorityBindsScopeAndRejectsRedirects(t *testing.T) {
	var mode atomic.Int32
	var unexpected atomic.Bool
	other := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { unexpected.Store(true) }))
	defer other.Close()
	secret := strings.Repeat("x", 32)
	core := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/internal/live-sessions/authorize" || r.Header.Get("Authorization") != "Bearer test" || r.Header.Get("X-Orka-Live-Relay-Secret") != secret {
			http.Error(w, "untrusted", 401)
			return
		}
		raw, e := io.ReadAll(r.Body)
		if e != nil {
			t.Error(e)
			return
		}
		if bytes.Contains(raw, []byte("records")) {
			t.Error("transcript sent to authority")
		}
		var scope AuthRequest
		json.Unmarshal(raw, &scope)
		switch mode.Load() {
		case 1:
			http.Redirect(w, r, other.URL, 307)
			return
		case 2:
			scope.Episode = id(199)
		case 3:
			reply(w, 409, map[string]string{"code": "live_episode_inactive"})
			return
		case 4:
			reply(w, 409, map[string]string{"error": "transient conflict"})
			return
		}
		reply(w, 200, map[string]any{"projectId": scope.Project, "resourceId": scope.Resource, "episodeId": scope.Episode, "userId": id(8), "deviceId": id(4), "source": "codex", "role": "reader", "revision": 2})
	}))
	defer core.Close()
	auth, e := CoreAuthority(core.URL, secret)
	if e != nil {
		t.Fatal(e)
	}
	for i, want := range []int{200, 503, 503, 410, 409} {
		mode.Store(int32(i))
		if got := auth(context.Background(), "Bearer test", AuthRequest{Key: testKey, Action: "read"}); got != want {
			t.Fatal(i, got, want)
		}
	}
	if unexpected.Load() {
		t.Fatal("credentials followed redirect")
	}
}

func TestContentIsFixedBeforeFinalAuthorityCheck(t *testing.T) {
	store, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	var reads atomic.Int32
	entered, complete := make(chan struct{}), make(chan struct{})
	h := New(store, func(_ context.Context, _ string, scope AuthRequest) int {
		if scope.Action == "read" {
			if reads.Add(1) == 1 {
				close(entered)
			}
			<-complete
		}
		return 200
	})
	var head Position
	call(t, h, testKey, "checkpoint", "PUT", "owner", mutation(11, Position{Hash: emptyHash}, first, first)).require(t, 200, &head)
	done := make(chan exchange, 1)
	go func() { done <- call(t, h, testKey, "content", "GET", "peer", nil) }()
	select {
	case <-entered:
	case <-time.After(time.Second):
		close(complete)
		t.Fatal("content authorization was not requested")
	}
	change := call(t, h, testKey, "append", "POST", "owner", mutation(12, head, second, first+second))
	close(complete)
	change.require(t, 200, nil)
	var view content
	(<-done).require(t, 200, &view)
	if view.Records != first || view.Position != head || reads.Load() != 1 {
		t.Fatal("unexpected authorized content or auth count", view, reads.Load())
	}
}

func TestPresentationRecordFields(t *testing.T) {
	for _, row := range []string{
		`{"text":"hello","role":"assistant"}`,
		`{"role":"user","text":""}`,
	} {
		if !validRows(row + "\n") {
			t.Fatalf("valid row rejected: %s", row)
		}
	}
	for _, row := range []string{
		`{"role":"user","text":"one","text":"two"}`,
		`{"role":"tool","role":"user","text":"x"}`,
		`{"Role":"user","text":"x"}`,
		`{"role":"user","Text":"x"}`,
		`{"role":"user","text":null}`,
		`{"role":"user","text":4}`,
		`{"role":"user","text":"x","tool":"private"}`,
		`{"role":"user","text":"x"} true`,
	} {
		if validRows(row + "\n") {
			t.Fatalf("invalid row accepted: %s", row)
		}
	}
}

func TestFullRelayReclaimsOnlyVerifiedTerminalRooms(t *testing.T) {
	for _, status := range []int{200, 403, 404, 410, 503} {
		t.Run(fmt.Sprint(status), func(t *testing.T) {
			s, err := Open(t.TempDir())
			if err != nil {
				t.Fatal(err)
			}
			defer s.Close()
			for i := range maxRooms {
				key := Key{id(i + 100), id(i + 200), id(i + 300)}
				if i == 0 {
					key = testKey
				}
				_, release, err := s.acquire(key)
				if err != nil {
					t.Fatal(err)
				}
				release()
			}
			var probes int
			h := New(s, func(_ context.Context, _ string, scope AuthRequest) int {
				if scope.Action == "read" {
					probes++
					if scope.Key != testKey {
						t.Error("did not probe previous episode", scope.Key)
					}
					return status
				}
				return 200
			})
			next := Key{testKey.Project, testKey.Resource, id(600)}
			cp := mutation(11, Position{Hash: emptyHash}, first, first)
			want := 429
			if status == 410 {
				want = 200
			}
			call(t, h, next, "checkpoint", "PUT", "owner", cp).require(t, want, nil)
			call(t, h, next, "checkpoint", "PUT", "owner", cp).require(t, want, nil)
			if probes != 1 {
				t.Fatal("unexpected pressure probes", probes)
			}
		})
	}
}

func TestFiveWarmReadersStayIncrementalAcrossJournalCompaction(t *testing.T) {
	dir := t.TempDir()
	store, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { store.Close() }()
	allow := func(context.Context, string, AuthRequest) int { return 200 }
	h := New(store, allow)
	// One KiB per turn makes retransfers and envelope overhead visible.
	line := fmt.Sprintf("{\"role\":\"assistant\",\"text\":\"%s\"}\n", strings.Repeat("x", 1024-len("{\"role\":\"assistant\",\"text\":\"\"}\n")))
	base := strings.Repeat(line, 1024)
	total := base
	head := Position{Hash: emptyHash}
	call(t, h, testKey, "checkpoint", "PUT", "owner", mutation(10, head, base, base)).require(t, 200, &head)
	// The last append here fills the first physical journal.
	for i := 1; i < historyLimit; i++ {
		total += line
		change := mutation(10+i, head, line, total)
		call(t, h, testKey, "append", "POST", "owner", change).require(t, 200, &head)
	}
	old := head
	for i := range 5 {
		var start content
		call(t, h, testKey, "content", "GET", fmt.Sprint(i), nil).require(t, 200, &start)
		if start.Records != total || start.Position != old {
			t.Fatal("could not warm reader", i)
		}
	}
	total += line
	call(t, h, testKey, "append", "POST", "owner", mutation(10+historyLimit, head, line, total)).require(t, 200, &head)
	readFive := func() {
		t.Helper()
		route := fmt.Sprintf("content?cursor=%d&hash=%s", old.Cursor, old.Hash)
		var bytes int
		for i := range 5 {
			var tail content
			reply := call(t, h, testKey, route, "GET", fmt.Sprint(i), nil)
			reply.require(t, 200, &tail)
			if tail.Reset || tail.Records != line || tail.Position != head {
				t.Fatalf("reader %d lost warm cursor", i)
			}
			bytes += len(reply.body)
		}
		t.Logf("five checked warm tails: %d useful bytes, %d HTTP body bytes", 5*len(line), bytes)
	}
	readFive()
	store.Close()
	store, err = Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	h = New(store, allow)
	readFive()
	// A semantic rewrite still fences the earlier suffixes.
	call(t, h, testKey, "checkpoint", "PUT", "owner", mutation(11+historyLimit, head, second, second)).require(t, 200, &head)
	var reset content
	call(t, h, testKey, fmt.Sprintf("content?cursor=%d&hash=%s", old.Cursor, old.Hash), "GET", "peer", nil).require(t, 200, &reset)
	if !reset.Reset || reset.Records != second {
		t.Fatal("rewrite kept obsolete cursor")
	}
}
