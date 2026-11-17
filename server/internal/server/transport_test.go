package server

import (
	"testing"
)

func TestPublicURLAcceptsBrowserLoopbackForms(t *testing.T) {
	for _, input := range []string{"http://LOCALHOST:080", "http://127.1", "http://2130706433", "http://0x7f000001", "http://0177.0.0.1"} {
		if _, err := SettingsFromEnv(map[string]string{"PUBLIC_URL": input}, false); err != nil {
			t.Errorf("browser loopback rejected %q: %v", input, err)
		}
	}
}

func TestPaginatedSessionOrdinalsAreSafeIntegers(t *testing.T) {
	for _, tt := range []struct {
		name, first, second string
		valid               bool
	}{
		{"valid", "0", "1", true}, {"fractional", "0.5", "1.5", false},
		{"strings", `"0"`, `"1"`, false}, {"boolean", "false", "true", false},
		{"null", "null", "1", false}, {"unsafe", "9007199254740992", "9007199254740993", false},
	} {
		t.Run(tt.name, func(t *testing.T) {
			const project = "12345678-1234-4123-8123-123456789012"
			data := []byte(`{"type":"session_meta","ordinal":` + tt.first + `,"payload":{"id":"thread","history_mode":"paginated"}}` + "\n" + `{"type":"response_item","ordinal":` + tt.second + `,"payload":{"role":"user","content":"Hello"}}` + "\n")
			store := &Store{Blobs: &Blobs{Root: t.TempDir()}}
			hash, err := store.Blobs.Put(project, data)
			if err != nil {
				t.Fatal(err)
			}
			q := &Queries{}
			messages := store.readSession(q, Object{"kind": "session", "source": "codex", "projectId": project, "files": []Object{{"path": "session.jsonl", "hash": hash, "size": len(data)}}})
			if tt.valid {
				if q.Err() != nil || len(messages) != 1 {
					t.Fatalf("valid history: %v %v", messages, q.Err())
				}
			} else if e, ok := q.Err().(*HTTPError); !ok || e.Status != 422 {
				t.Fatalf("invalid history accepted: %v", q.Err())
			}
		})
	}
}
