package server

import (
	"crypto/subtle"
	"fmt"
	"net/http"
	"slices"
)

const (
	liveStart     = "/v2/live-sessions/start"
	liveStatus    = "/v2/live-sessions/status"
	liveStop      = "/v2/live-sessions/stop"
	liveAuthorize = "/internal/live-sessions/authorize"
)

func liveSessionSecret(env map[string]string) (string, error) {
	switch env["ORKA_EXPERIMENTAL_LIVE_SESSIONS"] {
	case "", "0":
		return "", nil
	case "1":
		secret := env["ORKA_LIVE_SESSION_RELAY_SECRET"]
		if len(secret) >= 32 {
			return secret, nil
		}
		return "", fmt.Errorf("ORKA_LIVE_SESSION_RELAY_SECRET needs at least 32 characters when live sessions are enabled")
	default:
		return "", fmt.Errorf("ORKA_EXPERIMENTAL_LIVE_SESSIONS must be 0 or 1")
	}
}

var liveContracts = map[string]string{
	liveStart: "liveSessionStart", liveStop: "liveSessionStop", liveStatus: "liveSessionStatus", liveAuthorize: "liveSessionAuthorize",
}

func isLiveSessionRoute(path string) bool { _, ok := liveContracts[path]; return ok }

func (a *API) liveSessionRouteAvailable(path, method string, r *http.Request) bool {
	secret := a.Settings.liveSessionRelaySecret
	return secret != "" && method == http.MethodPost && (path != liveAuthorize ||
		subtle.ConstantTimeCompare([]byte(secret), []byte(r.Header.Get("X-Orka-Live-Relay-Secret"))) == 1)
}

func (a *API) liveSessionRequest(w http.ResponseWriter, r *http.Request, user string) (any, error) {
	path := r.URL.Path
	bytes, err := readBytes(w, r, 16*1024)
	if err != nil {
		return nil, err
	}
	raw, err := decode(bytes)
	if err != nil {
		return nil, err
	}
	value, err := ValidateContract(liveContracts[path], raw)
	if err != nil {
		return nil, err
	}
	input := object(value)
	// A provenance fence must be committed even though the attempted write is refused.
	var fenceError error
	result, err := a.Store.transaction(r.Context(), func(q *Queries) any {
		project, id := text(input["projectId"]), text(input["resourceId"])
		if path == liveStart || path == liveStop {
			q.One("select id from orka.projects where id=$1 for update", project)
		} else {
			q.One("select id from orka.projects where id=$1 for share", project)
		}
		a.Store.member(q, user, project)
		resource := a.Store.resource(q, project, id)
		if !q.Require(resource != nil && resource["kind"] == "session" && includes([]string{"codex", "claude"}, text(resource["source"])), 404, "Session unavailable") {
			return nil
		}
		if path == liveStop {
			return a.Store.stopLiveSession(q, user, resource, input)
		}
		if !q.Require(!flag(resource["deleted"]), 404, "Session unavailable") || !a.Store.requireActiveSource(q, project, resource["sourceId"]) {
			return nil
		}
		if path == liveStart {
			return a.Store.startLiveSession(q, user, resource, input)
		}
		a.Store.requireAccess(q, user, project, resource, "read", false)
		if q.Err() != nil {
			return nil
		}
		// Read, writer eligibility and episode membership are resolved together under the project lock.
		query := "select episode_id,owner_id,device_id from orka.live_sessions where project_id=$1 and resource_id=$2 and stopped_at is null and expires_at>now()"
		if input["action"] == "write" {
			query += " for update"
		}
		episode := q.One(query, project, id)
		if path == liveStatus && episode == nil {
			return Object{"episodeId": nil}
		}
		if !q.RequireCode(episode != nil && (path == liveStatus || episode["episode_id"] == input["episodeId"]), 409, "live_episode_inactive", "Live episode is no longer active") {
			return nil
		}
		owner := text(episode["owner_id"])
		if !q.Require(resource["owner"] == owner, 403, "Session owner changed") {
			return nil
		}
		a.Store.requireAccess(q, owner, project, resource, "publish", false)
		a.Store.checkDevice(q, owner, text(episode["device_id"]))
		if q.Err() != nil {
			return nil
		}
		scope := Object{"episodeId": episode["episode_id"], "revision": resource["revision"], "deviceId": episode["device_id"]}
		if path == liveStatus {
			return scope
		}
		role := "reader"
		if input["action"] == "write" {
			if !q.Require(user == owner && input["deviceId"] == episode["device_id"], 403, "Only the starting session owner and device may write live updates") {
				return nil
			}
			if !liveSourcesKnown(resource, input) {
				q.Exec("update orka.live_sessions set stopped_at=now() where project_id=$1 and resource_id=$2 and episode_id=$3", project, id, input["episodeId"])
				fenceError = &HTTPError{Status: 409, Code: "live_context_changed", Message: "Session context changed; publish the new provenance before starting live sharing again"}
				return nil
			}
			role = "writer"
		}
		return merge(scope, Object{"projectId": project, "resourceId": id, "userId": user, "source": resource["source"], "role": role})
	})
	if err != nil {
		return nil, err
	}
	return result, fenceError
}

func liveSourcesKnown(resource, input Object) bool {
	known := stringsOf(resource["contextSources"])
	for _, id := range stringsOf(input["contextSources"]) {
		if !slices.Contains(known, id) {
			return false
		}
	}
	return true
}

func (s *Store) startLiveSession(q *Queries, user string, resource, input Object) Object {
	project, id := text(input["projectId"]), text(input["resourceId"])
	s.requireAccess(q, user, project, resource, "publish", false)
	s.checkDevice(q, user, text(input["deviceId"]))
	if !q.Require(resource["owner"] == user, 403, "Only the session owner may start live sharing") ||
		!q.Require(liveSourcesKnown(resource, input), 409, "Publish the session context before starting live sharing") ||
		!q.Require(q.One("select 1 from orka.conflicts where project_id=$1 and resource_id=$2 and not resolved limit 1", project, id) == nil, 409, "Resolve session versions before starting live sharing") {
		return nil
	}
	q.Exec("update orka.live_sessions set stopped_at=expires_at where project_id=$1 and resource_id=$2 and stopped_at is null and expires_at<=now()", project, id)
	prior := q.One("select start_request, stopped_at from orka.live_sessions where project_id=$1 and resource_id=$2 and episode_id=$3", project, id, input["episodeId"])
	if prior != nil {
		if !q.Require(prior["stopped_at"] == nil && prior["start_request"] == Hash(input), 409, "Live start request is stale or changed") {
			return nil
		}
	} else {
		if !q.Require(number(resource["revision"]) == number(input["expectedRevision"]), 409, "Session changed; refresh before starting live sharing") ||
			!q.Require(q.One("select 1 from orka.live_sessions where project_id=$1 and resource_id=$2 and stopped_at is null and expires_at>now()", project, id) == nil, 409, "Session already has a live episode") {
			return nil
		}
		q.Exec("insert into orka.live_sessions(project_id,resource_id,episode_id,owner_id,device_id,start_request) values($1,$2,$3,$4,$5,$6)", project, id, input["episodeId"], user, input["deviceId"], Hash(input))
	}
	return Object{"episodeId": input["episodeId"], "revision": resource["revision"], "deviceId": input["deviceId"]}
}

func (s *Store) stopLiveSession(q *Queries, user string, resource, input Object) Object {
	project, id := text(input["projectId"]), text(input["resourceId"])
	s.checkDevice(q, user, text(input["deviceId"]))
	if !q.Require(resource["owner"] == user, 403, "Only the session owner may stop live sharing") {
		return nil
	}
	// Timed-out starts can arrive after a stop. Remember that specific episode ID;
	// a delayed stop for it never affects a newer episode.
	q.Exec(`insert into orka.live_sessions(project_id,resource_id,episode_id,owner_id,device_id,stopped_at)
		values($1,$2,$3,$4,$5,now()) on conflict(project_id,resource_id,episode_id)
		do update set stopped_at=coalesce(orka.live_sessions.stopped_at,excluded.stopped_at)`, project, id, input["episodeId"], user, input["deviceId"])
	return Object{"episodeId": nil}
}
