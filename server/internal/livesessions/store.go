// Package livesessions stores the experimental relay's redacted presentation
// records. Authorization and episode lifetime are owned by the core API.
package livesessions

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"hash"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"syscall"
	"time"
	"unicode/utf8"
)

const (
	maxSession   = 16 << 20
	maxAppend    = 256 << 10
	maxRooms     = 16
	maxBytes     = 64 << 20
	historyLimit = 128
	retention    = 25 * time.Hour // Core authorizes an episode for at most 24 hours.
)

var uuid = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)
var digestPattern = regexp.MustCompile(`^[0-9a-f]{64}$`)
var emptyHash = digest(nil)
var errCapacity = errors.New("live session capacity reached")
var errConflict = errors.New("cursor or request conflict")

func digest(b []byte) string { sum := sha256.Sum256(b); return hex.EncodeToString(sum[:]) }

type Key struct {
	Project  string `json:"projectId"`
	Resource string `json:"resourceId"`
	Episode  string `json:"episodeId"`
}

func (k Key) valid() bool {
	return uuid.MatchString(k.Project) && uuid.MatchString(k.Resource) && uuid.MatchString(k.Episode)
}
func (k Key) name() string { return k.Project + "_" + k.Resource + "_" + k.Episode + ".wal" }

type Position struct {
	Cursor int64  `json:"cursor"`
	Hash   string `json:"hash"`
}
type Mutation struct {
	Request  string   `json:"requestId"`
	Device   string   `json:"deviceId"`
	Sources  []string `json:"contextSources"`
	Base     *int64   `json:"baseCursor"`
	BaseHash string   `json:"baseHash"`
	Hash     string   `json:"hash"`
	Records  string   `json:"records"`
}

func validRows(records string) bool {
	if records == "" {
		return true
	}
	if !utf8.ValidString(records) || !strings.HasSuffix(records, "\n") {
		return false
	}
	for line := range strings.SplitSeq(strings.TrimSuffix(records, "\n"), "\n") {
		if len(line) == 0 || len(line)+1 > maxAppend {
			return false
		}
		dec := json.NewDecoder(strings.NewReader(line))
		if tok, e := dec.Token(); e != nil || tok != json.Delim('{') {
			return false
		}
		role, text := false, false
		for dec.More() {
			k, e := dec.Token()
			if e != nil {
				return false
			}
			var v *string
			if e = dec.Decode(&v); e != nil || v == nil {
				return false
			}
			switch k {
			case "role":
				if role || (*v != "user" && *v != "assistant") {
					return false
				}
				role = true
			case "text":
				if text {
					return false
				}
				text = true
			default:
				return false
			}
		}
		if tok, e := dec.Token(); e != nil || tok != json.Delim('}') || !role || !text {
			return false
		}
		if _, e := dec.Token(); e != io.EOF {
			return false
		}
	}
	return true
}

type receipt struct {
	Position
	ID    string `json:"id"`
	Proof string `json:"proof"`
}
type mark struct {
	Position
	End int
}
type room struct {
	mu       sync.Mutex
	body     []byte
	sum      hash.Cloner
	head     Position
	frames   int // physical frames in the current journal
	marks    []mark
	receipts []receipt
	changed  chan struct{}
	watchers int
	fault    bool
	// The store mutex protects lifecycle and admission fields.
	retired   bool
	users     int
	touched   time.Time
	inspected time.Time
}

func newRoom() *room {
	return &room{sum: sha256.New().(hash.Cloner), head: Position{Hash: emptyHash}, changed: make(chan struct{}), touched: time.Now()}
}

type Store struct {
	dir            string
	lock           *os.File
	stop           chan struct{}
	done           chan struct{}
	mu             sync.Mutex
	rooms          map[Key]*room
	bytes          int
	lastInspection time.Time
}

func Open(dir string) (*Store, error) {
	if e := os.MkdirAll(dir, 0700); e != nil {
		return nil, e
	}
	lock, e := os.OpenFile(filepath.Join(dir, ".lock"), os.O_CREATE|os.O_RDWR, 0600)
	if e != nil {
		return nil, e
	}
	if e = syscall.Flock(int(lock.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); e != nil {
		lock.Close()
		return nil, errors.New("live journal is already in use")
	}
	s := &Store{dir: dir, lock: lock, rooms: make(map[Key]*room)}
	if e = s.restore(); e != nil {
		lock.Close()
		return nil, e
	}
	s.stop = make(chan struct{})
	s.done = make(chan struct{})
	go func() {
		defer close(s.done)
		tick := time.NewTicker(time.Minute)
		defer tick.Stop()
		for {
			select {
			case <-s.stop:
				return
			case <-tick.C:
				s.mu.Lock()
				s.prune()
				s.mu.Unlock()
			}
		}
	}()
	return s, nil
}
func (s *Store) Close() error { close(s.stop); <-s.done; return s.lock.Close() }
func (s *Store) retire(k Key) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if r := s.rooms[k]; r != nil {
		r.retired = true
		s.prune()
	}
}
func (s *Store) prune() error {
	for old, r := range s.rooms {
		if r.users == 0 && (r.retired || time.Since(r.touched) > retention) {
			if e := os.Remove(filepath.Join(s.dir, old.name())); e != nil && !errors.Is(e, os.ErrNotExist) {
				return e
			}
			s.bytes -= len(r.body)
			delete(s.rooms, old)
		}
	}
	return nil
}
func (s *Store) restore() error {
	files, e := os.ReadDir(s.dir)
	if e != nil {
		return e
	}
	for _, file := range files {
		name := file.Name()
		if strings.HasSuffix(name, ".wal.pending") {
			if e = os.Remove(filepath.Join(s.dir, name)); e != nil {
				return e
			}
			continue
		}
		if !strings.HasSuffix(name, ".wal") {
			continue
		}
		parts := strings.Split(strings.TrimSuffix(name, ".wal"), "_")
		if len(parts) != 3 {
			return errors.New("invalid live journal name")
		}
		k := Key{parts[0], parts[1], parts[2]}
		info, e := file.Info()
		if e != nil {
			return e
		}
		if !k.valid() || !info.Mode().IsRegular() {
			return errors.New("invalid live journal file")
		}
		if time.Since(info.ModTime()) > retention {
			if e = os.Remove(filepath.Join(s.dir, name)); e != nil {
				return e
			}
			continue
		}
		if len(s.rooms) >= maxRooms {
			return errCapacity
		}
		r := newRoom()
		if e = restoreRoom(filepath.Join(s.dir, name), r); e != nil {
			return fmt.Errorf("read live journal: %w", e)
		}
		s.bytes += len(r.body)
		if s.bytes > maxBytes {
			return errCapacity
		}
		r.touched = info.ModTime()
		s.rooms[k] = r
	}
	return nil
}

// Recheck no more than one idle retained episode per second when a new room
// would exceed a limit. Prefer the same resource, then retry other idle rooms.
func (s *Store) reclaimCandidate(k Key) (Key, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.rooms[k] != nil || len(s.rooms) < maxRooms && s.bytes < maxBytes-maxSession || time.Since(s.lastInspection) < time.Second {
		return Key{}, false
	}
	var candidate Key
	var selected *room
	for key, r := range s.rooms {
		if r.users != 0 || r.retired || time.Since(r.inspected) < time.Second {
			continue
		}
		// The oldest uninspected room wins. Same-resource ties are most
		// likely to be visible to the current writer after a recent stop.
		if selected == nil || r.inspected.Before(selected.inspected) || r.inspected.Equal(selected.inspected) && key.Project == k.Project && key.Resource == k.Resource {
			candidate, selected = key, r
		}
	}
	if selected == nil {
		return Key{}, false
	}
	s.lastInspection = time.Now()
	selected.inspected = s.lastInspection
	return candidate, true
}

func (s *Store) acquire(k Key) (*room, func(), error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if e := s.prune(); e != nil {
		return nil, nil, e
	}
	r := s.rooms[k]
	if r == nil {
		if len(s.rooms) >= maxRooms {
			return nil, nil, errCapacity
		}
		r = newRoom()
		s.rooms[k] = r
	}
	if r.retired {
		return nil, nil, errors.New("live episode retired")
	}
	r.users++
	r.touched = time.Now()
	return r, func() {
		s.mu.Lock()
		r.users--
		if r.retired {
			s.prune()
		}
		s.mu.Unlock()
	}, nil
}
func (s *Store) reserve(n int) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if n > 0 && s.bytes+n > maxBytes {
		return false
	}
	s.bytes += n
	return true
}
func (r *room) tail(cursor int64, hash string) (int, bool) {
	for i := len(r.marks) - 1; i >= 0; i-- {
		m := r.marks[i]
		if m.Cursor == cursor && m.Hash == hash {
			return m.End, false
		}
	}
	if r.head.Cursor == 0 && cursor == 0 && hash == emptyHash {
		return 0, false
	}
	return 0, true
}
func appendRecent[T any](list []T, item T) []T {
	if len(list) >= historyLimit {
		copy(list, list[len(list)-historyLimit+1:])
		list = list[:historyLimit-1]
	}
	return append(list, item)
}
func (s *Store) mutate(k Key, r *room, m Mutation, checkpoint bool) (Position, error) {
	// Digest the semantic request, including its authoring scope and operation.
	h := sha256.New()
	key := struct {
		Reset          bool
		Device         string
		Sources        []string
		Base           int64
		BaseHash, Hash string
	}{checkpoint, m.Device, m.Sources, *m.Base, m.BaseHash, m.Hash}
	b, _ := json.Marshal(key)
	h.Write(b)
	h.Write([]byte(m.Records))
	proof := hex.EncodeToString(h.Sum(nil))
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.fault {
		return Position{}, errors.New("live journal unavailable")
	}
	for _, old := range r.receipts {
		if old.ID == m.Request {
			if old.Proof == proof {
				return old.Position, nil
			}
			return r.head, errConflict
		}
	}
	if *m.Base != r.head.Cursor || m.BaseHash != r.head.Hash || (!checkpoint && r.head.Cursor == 0) {
		return r.head, errConflict
	}
	n := len(m.Records)
	if !checkpoint {
		n += len(r.body)
	}
	if n > maxSession {
		return r.head, errCapacity
	}
	delta := n - len(r.body)
	// Hold positive growth until completion. Credit shrinking writes only after commit.
	if delta > 0 && !s.reserve(delta) {
		return r.head, errCapacity
	}
	reserved := delta > 0
	defer func() {
		if reserved {
			s.reserve(-delta)
		}
	}()
	var sum hash.Cloner
	if checkpoint {
		sum = sha256.New().(hash.Cloner)
	} else {
		var e error
		sum, e = r.sum.Clone()
		if e != nil {
			return r.head, e
		}
	}
	sum.Write([]byte(m.Records))
	if hex.EncodeToString(sum.Sum(nil)) != m.Hash {
		return r.head, errConflict
	}
	next := receipt{Position: Position{r.head.Cursor + 1, m.Hash}, ID: m.Request, Proof: proof}
	reset := checkpoint || r.frames >= historyLimit
	data := []byte(m.Records)
	if reset && !checkpoint {
		data = bytes.Join([][]byte{r.body, data}, nil)
	}
	frame := journalFrame{Receipt: next, Reset: reset, Bytes: len(data)}
	if reset {
		frame.Prior = r.receipts
		if len(frame.Prior) >= historyLimit {
			frame.Prior = frame.Prior[1:]
		}
		// A physical compaction preserves the checked suffixes since the
		// last actual rewrite. Their hashes already exist in the receipts.
		if !checkpoint {
			count := min(len(r.marks), len(frame.Prior))
			for _, m := range r.marks[len(r.marks)-count:] {
				frame.Ends = append(frame.Ends, m.End)
			}
		}
	}
	if e := saveFrame(s.dir, k.name(), frame, data); e != nil {
		r.fault = true
		close(r.changed)
		return r.head, e
	}
	if reset {
		r.body = data
		r.frames = 0
	} else {
		r.body = append(r.body, data...)
	}
	if checkpoint {
		r.marks = nil
	}
	r.frames++
	r.sum = sum
	r.head = next.Position
	r.receipts = appendRecent(r.receipts, next)
	r.marks = appendRecent(r.marks, mark{r.head, len(r.body)})
	close(r.changed)
	r.changed = make(chan struct{})
	reserved = false
	if delta < 0 {
		s.reserve(delta)
	}
	return r.head, nil
}
