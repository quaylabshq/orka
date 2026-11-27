package server

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
)

func TestPullSucceedsEvenIfLastSyncUpdateFails(t *testing.T) {
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("set TEST_DATABASE_URL to run PostgreSQL-backed pull last_sync_at test")
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
		project = store.createProject(q, user, "Last Sync Test", false, nil, nil, false)
		return nil
	}); err != nil {
		t.Fatal(err)
	}

	// Simulate a failure when updating last_sync_at (e.g. read-only replica or transient write error).
	if _, err := store.Pool.Exec(ctx, `
		create or replace function orka.fail_last_sync_update() returns trigger as $$
		begin
			raise exception 'simulated read-only / update failure';
		end;
		$$ language plpgsql;
		drop trigger if exists trg_fail_last_sync on orka.projects;
		create trigger trg_fail_last_sync before update of last_sync_at on orka.projects
		for each row execute function orka.fail_last_sync_update();
	`); err != nil {
		t.Fatal(err)
	}

	api := NewAPI(store, AuthSettings{}, "")
	api.Authenticate = func(context.Context, string) (string, error) { return user, nil }

	req := httptest.NewRequest(http.MethodGet, "/v2/sync/pull?projectId="+project+"&cursor=0", nil)
	req.Header.Set("Authorization", "Bearer test-token")
	res := httptest.NewRecorder()
	api.ServeHTTP(res, req)
	if res.Code != 200 {
		t.Fatalf("GET /v2/sync/pull failed when last_sync_at update errored: %d %s", res.Code, res.Body.String())
	}
}
