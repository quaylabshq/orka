package server

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestInvitePreviewUsableInviteReturnsNameAndExpiry(t *testing.T) {
	result, err := (storedInvite{Found: true, Name: "Team", ExpiresAt: "2026-01-02T03:04:05.000Z"}).preview()
	if err != nil {
		t.Fatal(err)
	}
	if len(result) != 2 || result["projectName"] != "Team" || result["expiresAt"] != "2026-01-02T03:04:05.000Z" {
		t.Fatalf("preview = %v", result)
	}
}

func TestInvitePreviewUnusableStatesShareOne410Response(t *testing.T) {
	const expires = "2026-01-02T03:04:05.000Z"
	for _, tc := range []struct {
		name   string
		invite storedInvite
	}{
		{"unknown token", storedInvite{}},
		{"used token", storedInvite{}},
		{"revoked token", storedInvite{}},
		{"deleted project", storedInvite{}},
		{"expired token", storedInvite{Found: true, Name: "Team", ExpiresAt: expires, Expired: true}},
		{"archived project", storedInvite{Found: true, Name: "Team", ExpiresAt: expires, Archived: true}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			result, err := tc.invite.preview()
			if err == nil || result != nil {
				t.Fatal("unusable invite was previewed")
			}
			failure, ok := err.(*HTTPError)
			if !ok || failure.Status != http.StatusGone {
				t.Fatalf("error = %v", err)
			}
			recorder := httptest.NewRecorder()
			writeError(recorder, err)
			want := string(jsonBytes(Object{"error": invitePreviewUnavailable}))
			if recorder.Code != http.StatusGone || recorder.Body.String() != want {
				t.Fatalf("response = %d %s", recorder.Code, recorder.Body)
			}
		})
	}
}

func TestInvitePreviewRequiresPost(t *testing.T) {
	api := NewAPI(nil, AuthSettings{}, "")
	for _, method := range []string{http.MethodGet, http.MethodHead, http.MethodPut} {
		request := httptest.NewRequest(method, "/v2/invites/preview", nil)
		recorder := httptest.NewRecorder()
		api.ServeHTTP(recorder, request)
		if recorder.Code != http.StatusMethodNotAllowed || recorder.Header().Get("Allow") != http.MethodPost {
			t.Errorf("%s: HTTP %d Allow %q", method, recorder.Code, recorder.Header().Get("Allow"))
		}
	}
}

func TestInvitePreviewWorksSignedOut(t *testing.T) {
	api := NewAPI(nil, AuthSettings{}, "")
	for _, body := range []string{
		`{"token":"short"}`,
		`{"token":"` + strings.Repeat("z", 48) + `"}`,
		`{"token":"` + strings.Repeat("a", 47) + `"}`,
		`{}`,
		`{"token":42}`,
		`not json`,
	} {
		request := httptest.NewRequest(http.MethodPost, "/v2/invites/preview", strings.NewReader(body))
		recorder := httptest.NewRecorder()
		api.ServeHTTP(recorder, request)
		if recorder.Code != http.StatusBadRequest {
			t.Errorf("%s: HTTP %d %s", body, recorder.Code, recorder.Body)
		}
	}
}
