package server

import (
	"bytes"
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
)

type probeBlobStore struct {
	BlobStore
	onRead func()
}

func (p *probeBlobStore) Read(project, hash string) ([]byte, error) {
	if p.onRead != nil {
		p.onRead()
	}
	return p.BlobStore.Read(project, hash)
}

func TestBlobGetDoesNotHoldDBTransactionDuringDiskRead(t *testing.T) {
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("set TEST_DATABASE_URL to run PostgreSQL-backed blob transaction test")
	}
	ctx := context.Background()
	store, err := Open(ctx, dsn, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer store.Pool.Close()
	if err := store.Migrate(ctx, false); err != nil {
		t.Fatal(err)
	}

	user := newID()
	var project string
	if _, err := store.transaction(ctx, func(q *Queries) any {
		project = store.createProject(q, user, "Blob TX Test", false, nil, nil, false)
		return nil
	}); err != nil {
		t.Fatal(err)
	}

	var acquiredDuringRead int32
	store.Blobs = &probeBlobStore{
		BlobStore: store.Blobs,
		onRead: func() {
			acquiredDuringRead = store.Pool.Stat().AcquiredConns()
		},
	}

	api := NewAPI(store, AuthSettings{}, "")
	api.Authenticate = func(context.Context, string) (string, error) { return user, nil }

	payload := []byte("synthetic blob payload")
	hash := bytesHash(payload)

	putReq := httptest.NewRequest(http.MethodPut, "/v2/blobs/"+project+"/"+hash, bytes.NewReader(payload))
	putReq.Header.Set("Authorization", "Bearer test-token")
	putRes := httptest.NewRecorder()
	api.ServeHTTP(putRes, putReq)
	if putRes.Code != 200 {
		t.Fatalf("PUT blob failed: %d %s", putRes.Code, putRes.Body.String())
	}

	getReq := httptest.NewRequest(http.MethodGet, "/v2/blobs/"+project+"/"+hash, nil)
	getReq.Header.Set("Authorization", "Bearer test-token")
	getRes := httptest.NewRecorder()
	api.ServeHTTP(getRes, getReq)
	if getRes.Code != 200 {
		t.Fatalf("GET blob failed: %d %s", getRes.Code, getRes.Body.String())
	}
	if !bytes.Equal(getRes.Body.Bytes(), payload) {
		t.Fatalf("GET blob body mismatch: got %q, want %q", getRes.Body.Bytes(), payload)
	}
	if acquiredDuringRead != 0 {
		t.Fatalf("GET /v2/blobs held %d DB pool connection(s) open during disk read; expected 0", acquiredDuringRead)
	}
}
