package livesessions

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

type AuthRequest struct {
	Key
	Action  string    `json:"action"`
	Device  string    `json:"deviceId,omitempty"`
	Sources *[]string `json:"contextSources,omitempty"`
}
type Authorize func(context.Context, string, AuthRequest) int

// Only the operator controls the core origin. Redirects could disclose either credential.
func CoreAuthority(origin, secret string) (Authorize, error) {
	base, e := url.Parse(origin)
	if e != nil || (base.Scheme != "https" && base.Scheme != "http") || base.Host == "" || base.User != nil ||
		(base.Path != "" && base.Path != "/") || base.RawQuery != "" || base.Fragment != "" || len(secret) < 32 {
		return nil, errors.New("invalid live session core origin or relay secret")
	}
	base.Path = "/internal/live-sessions/authorize"
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.Proxy = nil
	client := &http.Client{Transport: transport, Timeout: 3 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	return func(ctx context.Context, bearer string, scope AuthRequest) int {
		data, e := json.Marshal(scope)
		if e != nil {
			return 503
		}
		req, e := http.NewRequestWithContext(ctx, "POST", base.String(), bytes.NewReader(data))
		if e != nil {
			return 503
		}
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Authorization", bearer)
		req.Header.Set("X-Orka-Live-Relay-Secret", secret)
		res, e := client.Do(req)
		if e != nil {
			return 503
		}
		defer res.Body.Close()
		if res.StatusCode != 200 {
			if res.StatusCode == 409 {
				var terminal struct {
					Code string `json:"code"`
				}
				if json.NewDecoder(io.LimitReader(res.Body, 4096)).Decode(&terminal) == nil && (terminal.Code == "live_episode_inactive" || terminal.Code == "live_context_changed") {
					return http.StatusGone
				}
			}
			switch res.StatusCode {
			case 400, 401, 403, 404, 409, 410, 429:
				return res.StatusCode
			}
			return 503
		}
		var claim struct {
			Key
			User         string `json:"userId"`
			Device       string `json:"deviceId"`
			Role, Source string
			Revision     int64
		}
		b, e := io.ReadAll(io.LimitReader(res.Body, 4097))
		if e != nil || len(b) > 4096 || json.Unmarshal(b, &claim) != nil ||
			claim.Key != scope.Key || !uuid.MatchString(claim.User) || !uuid.MatchString(claim.Device) || claim.Revision < 1 ||
			(claim.Source != "codex" && claim.Source != "claude") {
			return 503
		}
		if scope.Action == "write" && (claim.Role != "writer" || claim.Device != scope.Device) {
			return 403
		}
		if scope.Action == "read" && claim.Role != "reader" {
			return 403
		}
		return 200
	}, nil
}
func bearer(r *http.Request) string {
	vals := r.Header.Values("Authorization")
	if len(vals) != 1 {
		return ""
	}
	b, ok := strings.CutPrefix(vals[0], "Bearer ")
	if !ok || b == "" || len(b) > 8192 || strings.ContainsAny(b, " \r\n\t") {
		return ""
	}
	return vals[0]
}
