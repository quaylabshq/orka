package server

import (
	"errors"
	"net/http/httptest"
	"testing"
)

func TestProjectDenialMatchesTheProjectState(t *testing.T) {
	at := "2026-01-01T00:00:00.000Z"
	for _, tt := range []struct {
		name string
		row  Object
		want projectDenial
	}{
		{"no project or no membership", nil, deniedNotMember},
		{"live project", Object{"archived_at": nil, "deleted_at": nil}, ""},
		{"archived project", Object{"archived_at": at, "deleted_at": nil}, deniedProjectArchived},
		{"deleted inside the restore window", Object{"archived_at": at, "deleted_at": at}, deniedProjectDeleted},
	} {
		t.Run(tt.name, func(t *testing.T) {
			if got := denialOf(tt.row); got != tt.want {
				t.Fatalf("denialOf = %q, want %q", got, tt.want)
			}
		})
	}
}

func TestProjectDenialKeepsTheStatusAndMessageAndAddsACode(t *testing.T) {
	q := &Queries{}
	deniedProjectArchived.refuse(q)
	var failure *HTTPError
	if !errors.As(q.Err(), &failure) || failure.Status != 403 || failure.Message != projectAccessDenied || failure.Code != "project_archived" {
		t.Fatalf("unexpected refusal: %#v", q.Err())
	}
	// The refusal is terminal: later checks keep the first failure and its code.
	if q.Require(false, 400, "Later check") || q.Err() != failure {
		t.Fatalf("refusal was replaced: %#v", q.Err())
	}
}

func TestWriteErrorAddsACodeOnlyWhenTheErrorCarriesOne(t *testing.T) {
	for _, tt := range []struct{ name, code, want string }{
		{"coded", "not_member", `{"code":"not_member","error":"Project access denied"}`},
		{"uncoded", "", `{"error":"Project access denied"}`},
	} {
		t.Run(tt.name, func(t *testing.T) {
			w := httptest.NewRecorder()
			writeError(w, &HTTPError{Status: 403, Code: tt.code, Message: projectAccessDenied})
			if w.Code != 403 || w.Body.String() != tt.want {
				t.Fatalf("got %d %s, want 403 %s", w.Code, w.Body, tt.want)
			}
		})
	}
}
