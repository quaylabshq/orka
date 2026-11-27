package server

import (
	"context"
	"errors"
	"io"
	"log"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"
)

type Authenticate func(context.Context, string) (string, error)
type API struct {
	Store        *Store
	Settings     AuthSettings
	AuthURL      string
	Environment  map[string]string
	Authenticate Authenticate
	Repositories *GitHub
}

func NewAPI(store *Store, settings AuthSettings, authURL string) *API {
	a := &API{Store: store, Settings: settings, AuthURL: authURL, Environment: processEnv()}
	a.Authenticate = a.accountAuthenticate
	a.Repositories = &GitHub{Store: store}
	return a
}
func readBytes(w http.ResponseWriter, r *http.Request, limit int64) ([]byte, error) {
	data, err := io.ReadAll(http.MaxBytesReader(w, r.Body, limit))
	var oversized *http.MaxBytesError
	if errors.As(err, &oversized) {
		return nil, &HTTPError{Status: 413, Message: "Request exceeds size limit"}
	}
	return data, err
}
func readJSON(w http.ResponseWriter, r *http.Request) (any, error) {
	data, err := readBytes(w, r, 8000000)
	if err != nil {
		return nil, err
	}
	return decode(data)
}
func writeError(w http.ResponseWriter, err error) {
	status, message, code := 500, "Service unavailable", ""
	var failure *HTTPError
	if errors.As(err, &failure) {
		status, code = failure.Status, failure.Code
		if status != 500 {
			message = failure.Message
		}
	}
	w.WriteHeader(status)
	body := Object{"error": message}
	if code != "" {
		body["code"] = code
	}
	_, _ = w.Write(jsonBytes(body))
	if status == 500 {
		log.Print("request_failed")
	}
}
func (a *API) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Referrer-Policy", "no-referrer")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'")
	defer func() {
		if recover() != nil {
			writeError(w, errors.New("unexpected request failure"))
		}
	}()
	if path, ok := strings.CutPrefix(r.URL.Path, dashboardBridgePrefix); ok && (path == "" || strings.HasPrefix(path, "/")) {
		bridge := a.Settings.dashboardRequest(r, path)
		if bridge == nil {
			writeError(w, &HTTPError{Status: 404, Message: "Not found"})
			return
		}
		r = bridge
	}
	result, handled, err := a.handle(w, r)
	if err != nil {
		writeError(w, err)
		return
	}
	if !handled {
		_, _ = w.Write(jsonBytes(result))
	}
}
func (a *API) handle(w http.ResponseWriter, r *http.Request) (any, bool, error) {
	path, method, s := r.URL.Path, r.Method, a.Store
	if strings.HasPrefix(path, "/mcp/source/") && method == http.MethodGet {
		return nil, true, a.connectorSource(w, r)
	}
	if isMCPPath(path) || strings.HasPrefix(path, "/v2/plugin/connection") {
		w.WriteHeader(http.StatusGone)
		return Object{"error": "desktop_required", "error_description": "Open Orka desktop and reconnect the Orka plugin. The desktop account is the only connector login."}, false, nil
	}
	if path == "/v2/instance" && method == http.MethodGet {
		auth := Object{"password": a.Settings.Password, "github": a.Settings.GitHub, "magicLink": a.Settings.MagicLink, "profileRedirect": true, "emailCode": a.Settings.MagicLink}
		instance := Object{"version": 1, "onboarding": 1, "invites": Object{"email": a.invitationEmailAvailable()}, "profile": Object{"version": 2, "jobRole": true, "avatarUpload": true, "conditionalSave": 1}, "mode": a.Settings.Mode, "repositories": Object{"github": choose(a.Repositories.Settings.Enabled, 1, 0)}, "auth": auth}
		instance["desktopConnector"] = 1
		if a.Settings.DashboardURL != "" {
			auth["browserOrigin"] = a.Settings.DashboardURL
			if fromDashboard(r) {
				auth["browserBridge"] = true
			}
		}
		return instance, false, nil
	}
	if path == "/integrations/github/webhook" && method == http.MethodPost {
		raw, err := readBytes(w, r, 1_000_000)
		if err != nil {
			return nil, false, err
		}
		result, err := a.Repositories.Webhook(r.Context(), raw, r.Header.Get("X-Hub-Signature-256"), r.Header.Get("X-GitHub-Delivery"), r.Header.Get("X-GitHub-Event"))
		return result, false, err
	}
	if path == "/auth/hooks/send-email" && method == http.MethodPost && a.Settings.EmailProvider == "resend" {
		data, err := readBytes(w, r, 64000)
		if err != nil {
			return nil, false, err
		}
		return Object{}, false, a.emailHook(r.Context(), data, r.Header)
	}
	if path == "/email-template" && method == http.MethodGet {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		body := desktopEmailHTML("{{ .ConfirmationURL }}", "{{ .Token }}")
		_, err := io.WriteString(w, body.document())
		return nil, true, err
	}
	if path == "/health" {
		result, err := s.read(r.Context(), func(q *Queries) any { q.One("select 1"); return Object{"ok": true, "version": 2} })
		return result, false, err
	}
	if strings.HasPrefix(path, "/join/") && a.Settings.PublicURL != "" {
		return nil, true, a.invitePage(w, r)
	}
	if path == "/v2/invites/preview" {
		result, err := a.previewInvite(w, r)
		return result, false, err
	}
	if path == "/auth/confirm" && a.AuthURL != "" {
		if method == http.MethodGet && a.Settings.DashboardURL != "" {
			http.Redirect(w, r, a.Settings.DashboardURL+r.URL.RequestURI(), http.StatusTemporaryRedirect)
			return nil, true, nil
		}
		return nil, true, a.confirmEmail(w, r)
	}
	if strings.HasPrefix(path, "/auth/") && a.AuthURL != "" {
		return nil, true, a.proxyAuth(w, r, r.URL, method)
	}
	authorization := r.Header.Get("Authorization")
	if !strings.HasPrefix(authorization, "Bearer ") || len(authorization) == 7 {
		return nil, false, &HTTPError{Status: 401, Message: "Sign in required"}
	}
	user, err := a.Authenticate(r.Context(), strings.TrimPrefix(authorization, "Bearer "))
	if err != nil {
		return nil, false, err
	}
	if !validUUID(user) {
		return nil, false, bad("Invalid request")
	}
	var parsed any
	parsedBody := false
	body := func() (any, error) {
		if !parsedBody {
			var err error
			parsed, err = readJSON(w, r)
			if err != nil {
				return nil, err
			}
			parsedBody = true
		}
		return parsed, nil
	}
	scoped := []string{"/v2/sync/push", "/v2/sharing/selected", "/v2/sessions/resolve", "/v2/sessions/copy", "/v2/presence", "/v2/env/action", "/v2/governance/action", "/v2/projects/action", "/v2/projects/sources", "/v2/projects/sources/remove", "/v2/invites", "/v2/invites/revoke", "/v2/github/action"}
	project := r.URL.Query().Get("projectId")
	if strings.HasPrefix(path, "/v2/blobs/") {
		parts := strings.Split(path, "/")
		if len(parts) > 3 {
			project = parts[3]
		}
	}
	if method == http.MethodPost && includes(scoped, path) {
		v, e := body()
		if e != nil {
			return nil, false, e
		}
		project = text(field(v, "projectId"))
		if project == "" {
			project = text(field(field(v, "input"), "projectId"))
		}
		if project == "" {
			project = text(field(field(field(v, "call"), "input"), "projectId"))
		}
		if project == "" {
			project = text(field(field(field(field(field(v, "call"), "input"), "version"), "manifest"), "projectId"))
		}
	}
	if project != "" && r.Header.Get("X-Orka-Governance") != "1" {
		if !validUUID(project) {
			return nil, false, bad("Invalid request")
		}
		_, err = s.read(r.Context(), func(q *Queries) any {
			row := q.One("select 1 from orka.projects p join orka.members m on m.project_id=p.id where p.id=$1 and m.user_id=$2 and p.governed and p.archived_at is null", project, user)
			q.Require(row == nil, 409, "Update Orka to use this project's resource permissions")
			return nil
		})
		if err != nil {
			return nil, false, err
		}
	}
	read := func(fn func(*Queries) any) (any, bool, error) {
		result, err := s.read(r.Context(), fn)
		return result, false, err
	}
	tx := func(fn func(*Queries) any) (any, bool, error) {
		result, err := s.transaction(r.Context(), fn)
		return result, false, err
	}
	parse := func(shape map[string]Field) (Object, error) {
		v, err := body()
		if err != nil {
			return nil, err
		}
		return parseObject(v, shape)
	}
	contract := func(name string) (Object, error) {
		v, err := body()
		if err != nil {
			return nil, err
		}
		parsed, err := ValidateContract(name, v)
		return object(parsed), err
	}
	switch {
	case path == "/v2/connector/tools" && method == http.MethodGet:
		return Object{"tools": connectorTools}, false, nil
	case path == "/v2/connector/tools" && method == http.MethodPost:
		input, err := parse(map[string]Field{"name": strField(1, 80), "arguments": {Kind: "any"}})
		if err != nil {
			return nil, false, err
		}
		result, err := a.connectorTool(r.Context(), user, text(input["name"]), input["arguments"])
		return result, false, err

	case path == "/v2/github/action" && method == http.MethodPost:
		raw, err := body()
		if err != nil {
			return nil, false, err
		}
		result, err := a.Repositories.Action(r.Context(), user, raw)
		return result, false, err
	case path == "/v2/env/capabilities" && method == http.MethodGet:
		return Object{"format": 1, "maxPlaintextBytes": 1000000}, false, nil
	case path == "/v2/env/action" && method == http.MethodPost:
		input, err := contract("envSignedCall")
		if err != nil {
			return nil, false, err
		}
		return tx(func(q *Queries) any { return s.envAction(q, user, input) })
	case path == "/v2/profile" && method == http.MethodGet:
		return read(func(q *Queries) any { return s.getProfile(q, user) })
	case path == "/v2/profile" && method == http.MethodPut:
		raw, err := body()
		if err != nil {
			return nil, false, err
		}
		input, err := parseProfile(raw)
		if err != nil {
			return nil, false, err
		}
		return tx(func(q *Queries) any { return s.putProfile(q, user, input) })
	case path == "/v2/projects/capabilities" && method == http.MethodGet:
		return read(func(q *Queries) any {
			return Object{"lifecycle": 1, "softDelete": 1, "projectTombstones": 1, "projectRestoreWindowDays": projectRestoreWindowDays(q), "governance": 1, "sources": 1, "sourcesRemoval": 1, "rename": 1, "rolePolicies": 1, "policyOperations": 1, "deviceHardware": 1, "selectedSharing": 1, "resourceDeletion": 1, "sessionLatestOnly": 1, "sessionUploadReconcile": 1}
		})
	case path == "/v2/projects/sources/remove" && method == http.MethodPost:
		input, err := contract("removeProjectSource")
		if err != nil {
			return nil, false, err
		}
		return tx(func(q *Queries) any { return s.removeSource(q, user, input) })
	case path == "/v2/projects/sources" && method == http.MethodPost:
		input, err := contract("addProjectSources")
		if err != nil {
			return nil, false, err
		}
		return tx(func(q *Queries) any { return s.addSources(q, user, input) })
	case path == "/v2/governance/action" && method == http.MethodPost:
		v, err := parse(map[string]Field{"action": strField(0, 0), "input": {Kind: "any"}})
		if err != nil {
			return nil, false, err
		}
		input := object(v["input"])
		if !validUUID(text(input["projectId"])) {
			return nil, false, bad("Invalid request")
		}
		return tx(func(q *Queries) any { return s.governance(q, user, text(v["action"]), input) })
	case path == "/v2/projects/action" && method == http.MethodPost:
		raw, err := body()
		if err != nil {
			return nil, false, err
		}
		action := text(field(raw, "action"))
		var input Object
		if action == "set-remote" {
			input, err = parseObject(raw, map[string]Field{"action": enumField("set-remote"), "projectId": uuidField(), "remoteKey": contractField("digest")})
		} else {
			input, err = contract("projectLifecycleAction")
		}
		if err != nil {
			return nil, false, err
		}
		if (action == "rename") != (input["name"] != nil) {
			return nil, false, bad("Invalid request")
		}
		result, handled, err := tx(func(q *Queries) any { return s.mutateProject(q, user, input) })
		if err == nil && action == "purge" {
			s.cleanupBlobs(r.Context())
		}
		return result, handled, err
	case path == "/v2/projects" && method == http.MethodGet:
		return read(func(q *Queries) any {
			return values(s.projectCatalog(q, user, r.URL.Query().Get("includeArchived") == "true", r.URL.Query().Get("projectLifecycle") == "1"))
		})
	case path == "/v2/projects" && method == http.MethodPost:
		one := intField(1)
		one.Max = 1
		input, err := parse(map[string]Field{"name": trimmed(strField(1, 100)), "governance": optional(one), "remoteKey": optional(contractField("digest")), "requestId": optional(uuidField()), "rolePolicies": optional(one)})
		if err != nil {
			return nil, false, err
		}
		return tx(func(q *Queries) any {
			return Object{"id": s.createProject(q, user, text(input["name"]), number(input["governance"]) == 1, input["remoteKey"], input["requestId"], true)}
		})
	case path == "/v2/invites" && method == http.MethodPost:
		input, err := parse(scopeShape(map[string]Field{"email": optional(trimmed(strField(1, 254)))}))
		if err != nil {
			return nil, false, err
		}
		email := ""
		if input["email"] != nil {
			email, err = normalizeInvitationEmail(text(input["email"]))
			if err != nil {
				return nil, false, err
			}
		}
		result, err := s.transaction(r.Context(), func(q *Queries) any { return a.createInvite(q, user, text(input["projectId"]), email) })
		if err != nil || email == "" {
			return result, false, err
		}
		// Provider acceptance must never precede the invitation's database commit.
		invitation := object(result)
		token := text(invitation["token"])
		expiresAt, err := time.Parse(time.RFC3339Nano, text(invitation["expiresAt"]))
		if err != nil {
			return nil, false, err
		}
		invite := invitationEmail{To: email, Project: text(invitation["projectName"]), Link: a.Settings.PublicURL + "/join/" + token, InviterName: text(invitation["inviterName"]), InviterEmail: text(invitation["inviterEmail"]), ExpiresAt: expiresAt}
		hash := bytesHash([]byte(token))
		deliveryErr := a.sendInvitation(r.Context(), invite, hash)
		if previous := stringsOf(invitation["previousInviteHashes"]); len(previous) > 0 {
			remove := previous
			if deliveryErr != nil {
				var rejection *invitationDeliveryRejected
				if !errors.As(deliveryErr, &rejection) {
					return nil, false, deliveryErr
				}
				remove = []string{hash}
			}
			// Finish a confirmed delivery or rejection even if the caller disconnects.
			ctx, cancel := context.WithTimeout(context.WithoutCancel(r.Context()), 5*time.Second)
			defer cancel()
			_, cleanupErr := s.transaction(ctx, func(q *Queries) any {
				q.Exec("delete from orka.invites where token_hash=any($1)", remove)
				return nil
			})
			if cleanupErr != nil {
				if deliveryErr == nil {
					return nil, false, cleanupErr
				}
				log.Print("rejected_invite_cleanup_failed")
			}
		}
		if deliveryErr != nil {
			return nil, false, deliveryErr
		}
		return Object{"sent": true, "email": email}, false, nil
	case path == "/v2/invites/revoke" && method == http.MethodPost:
		input, err := contract("revokeInvite")
		if err != nil {
			return nil, false, err
		}
		email, err := normalizeInvitationEmail(text(input["email"]))
		if err != nil {
			return nil, false, err
		}
		return tx(func(q *Queries) any { return s.revokeInvites(q, user, text(input["projectId"]), email) })
	case path == "/v2/join" && method == http.MethodPost:
		input, err := parse(map[string]Field{"token": strField(48, 48)})
		if err != nil || !inviteToken.MatchString(text(input["token"])) {
			return nil, false, bad("Invalid request")
		}
		return tx(func(q *Queries) any {
			return s.joinProject(q, user, text(input["token"]), r.Header.Get("X-Orka-Governance") == "1", func() (string, error) {
				return a.invitationAccountEmail(r.Context(), strings.TrimPrefix(authorization, "Bearer "), user)
			})
		})
	case path == "/v2/devices" && method == http.MethodPost:
		input, err := parse(map[string]Field{"id": uuidField(), "name": strField(1, 100), "hardwareFamily": optional(enumField("laptop", "all-in-one", "mac-mini", "mac-studio", "mac-pro", "generic"))})
		if err != nil {
			return nil, false, err
		}
		return read(func(q *Queries) any {
			s.device(q, user, text(input["id"]), text(input["name"]), input["hardwareFamily"])
			return Object{"ok": true}
		})
	case path == "/v2/devices" && method == http.MethodGet:
		return read(func(q *Queries) any {
			return values(q.Rows(`select id,name,last_seen as seen_at,hardware_family as "hardwareFamily" from orka.devices where owner=$1 order by name`, user))
		})
	case path == "/v2/sync/push" && method == http.MethodPost:
		input, err := contract("change")
		if err != nil {
			return nil, false, err
		}
		return tx(func(q *Queries) any { return s.change(q, user, input, ChangeOptions{}) })
	case path == "/v2/sessions/resolve" && method == http.MethodPost:
		input, err := contract("resolution")
		if err != nil {
			return nil, false, err
		}
		return tx(func(q *Queries) any { return s.resolve(q, user, input) })
	case path == "/v2/sessions/copy" && method == http.MethodPost:
		input, err := contract("sessionCopy")
		if err != nil {
			return nil, false, err
		}
		return tx(func(q *Queries) any { return s.copySession(q, user, input) })
	case path == "/v2/sessions/reconcile" && method == http.MethodPost:
		input, err := parse(scopeShape(map[string]Field{"deviceId": uuidField(), "id": uuidField()}))
		if err != nil {
			return nil, false, err
		}
		return tx(func(q *Queries) any { return s.reconcileSessionUpload(q, user, input) })
	case path == "/v2/sharing/selected" && method == http.MethodPost:
		input, err := contract("change")
		if err != nil {
			return nil, false, err
		}
		result, err := s.shareSelected(r.Context(), user, input)
		return result, false, err
	case path == "/v2/sync/pull" && method == http.MethodGet:
		project := r.URL.Query().Get("projectId")
		if !validUUID(project) {
			return nil, false, bad("Invalid request")
		}
		cursorText := r.URL.Query().Get("cursor")
		if cursorText == "" {
			cursorText = "0"
		}
		cursor, err := strconv.ParseInt(cursorText, 10, 64)
		if err != nil || cursor < 0 || cursor > 9007199254740991 {
			return nil, false, bad("Invalid request")
		}
		policy, _ := strconv.ParseInt(r.URL.Query().Get("policyRevision"), 10, 64)
		if _, exists := r.URL.Query()["policyRevision"]; !exists {
			policy = -1
		}
		result, _, err := tx(func(q *Queries) any {
			return s.pull(q, user, project, cursor, policy, r.URL.Query().Get("governance") == "1")
		})
		if err == nil {
			if _, updateErr := s.transaction(r.Context(), func(q *Queries) any {
				q.Exec("update orka.projects set last_sync_at=now() where id=$1", project)
				return nil
			}); updateErr != nil {
				log.Print("project_last_sync_update_failed")
			}
		}
		return result, false, err
	case path == "/v2/presence" && method == http.MethodPost:
		input, err := parse(scopeShape(map[string]Field{"deviceId": uuidField(), "sessions": listField(uuidField(), 0, 100)}))
		if err != nil {
			return nil, false, err
		}
		return tx(func(q *Queries) any {
			project := text(input["projectId"])
			q.Exec("select id from orka.projects where id=$1 for share", project)
			s.member(q, user, project)
			s.checkDevice(q, user, text(input["deviceId"]))
			q.Exec("delete from orka.presence where project_id=$1 and device_id=$2", project, input["deviceId"])
			for _, id := range stringsOf(input["sessions"]) {
				p := s.projectAccess(q, project, user)
				if !q.Require(!flag(p["governed"]) || s.canRead(q, user, project, id), 403, "Session access denied") {
					return nil
				}
				q.Exec("insert into orka.presence values($1,$2,$3,$4,now())", project, id, input["deviceId"], user)
			}
			return Object{"ok": true}
		})
	}
	if regexp.MustCompile(`^/v2/blobs/[^/]+/[^/]+$`).MatchString(path) {
		parts := strings.Split(path, "/")
		project, hash := parts[3], parts[4]
		if !validUUID(project) || !validDigest(hash) {
			return nil, false, bad("Invalid request")
		}
		if method == http.MethodPut {
			content, err := readBytes(w, r, 128*1024*1024)
			if err != nil {
				return nil, false, err
			}
			if bytesHash(content) != hash {
				return nil, false, bad("Blob hash mismatch")
			}
			return tx(func(q *Queries) any {
				q.Exec("select id from orka.projects where id=$1 for share", project)
				s.member(q, user, project)
				s.putBlob(q, project, content)
				q.Exec("insert into orka.blob_uploads values($1,$2,$3) on conflict do nothing", project, hash, user)
				q.Exec("insert into orka.blobs(project_id,hash,size) values($1,$2,$3) on conflict(project_id,hash) do update set created_at=now()", project, hash, len(content))
				return Object{"hash": hash}
			})
		}
		if method == http.MethodGet {
			var content []byte
			_, err := s.transaction(r.Context(), func(q *Queries) any {
				q.Exec("select id from orka.projects where id=$1 for share", project)
				s.member(q, user, project)
				if !q.Require(q.One("select 1 from orka.blobs where project_id=$1 and hash=$2", project, hash) != nil, 404, "Blob not found") || !q.Require(s.blobReadable(q, user, project, hash), 404, "Blob not found") {
					return nil
				}
				content = s.readBlob(q, project, hash)
				return nil
			})
			if err != nil {
				return nil, false, err
			}
			w.Header().Set("Content-Type", "application/octet-stream")
			_, err = w.Write(content)
			return nil, true, err
		}
	}
	return nil, false, &HTTPError{Status: 404, Message: "Not found"}
}
func (a *API) createInvite(q *Queries, user, project, email string) any {
	s, origin := a.Store, a.Settings.PublicURL
	p := q.One("select name from orka.projects where id=$1 for update", project)
	s.member(q, user, project)
	if !q.Require(s.managesInvites(q, user, project), 403, "Only project owners can invite members") {
		return nil
	}
	if email != "" {
		if !q.Require(a.invitationEmailAvailable(), 409, "Email invitations are unavailable on this service. Use a joining link.") {
			return nil
		}
		if !q.Require(q.One("select 1 from orka.members m join orka.env_profiles p on p.user_id=m.user_id where m.project_id=$1 and lower(p.email)=$2", project, email) == nil, 409, email+" is already a member of this project.") {
			return nil
		}
		q.Exec("delete from orka.invitation_deliveries where project_id=$1 and created_at<=now()-interval '1 hour'", project)
		recent := q.One("select 1 from orka.invitation_deliveries where project_id=$1 and email_hash=$2 and created_at>now()-interval '60 seconds'", project, bytesHash([]byte(email)))
		if !q.Require(recent == nil, 429, "An invite was just sent to this address. Wait a minute before sending it again.") {
			return nil
		}
		volume := q.One("select count(*) as count from orka.invitation_deliveries where project_id=$1", project)
		if !q.Require(number(volume["count"]) < 30, 429, "This project reached its hourly limit for email invites. Try again later or use a joining link.") {
			return nil
		}
	}
	token, err := randomToken(24)
	if !q.Check(err) {
		return nil
	}
	hash := bytesHash([]byte(token))
	invite := q.One("insert into orka.invites(token_hash,project_id,expires_at,email) values($1,$2,now()+interval '1 day',$3) returning expires_at", hash, project, choose(email == "", nil, email))
	if email != "" {
		q.Exec("insert into orka.invitation_deliveries(token_hash,project_id,email_hash) values($1,$2,$3)", hash, project, bytesHash([]byte(email)))
	}
	s.appendLog(q, project, Object{"action": "invite.created", "actor": user}, true, nil)
	if email != "" {
		inviter := q.One("select coalesce(profile.display_name,p.label) as name,p.email from orka.members m left join orka.env_profiles p on p.user_id=m.user_id left join orka.profiles profile on profile.user_id=m.user_id where m.user_id=$1 and m.project_id=$2", user, project)
		// Remember which links this send can replace without touching later invites.
		previous := q.One("select array(select token_hash from orka.invites where project_id=$1 and email=$2 and token_hash<>$3) as hashes", project, email, hash)
		return Object{"token": token, "projectName": p["name"], "inviterName": inviter["name"], "inviterEmail": inviter["email"], "expiresAt": invite["expires_at"], "previousInviteHashes": previous["hashes"]}
	}
	result := Object{"token": token}
	if origin != "" {
		result["url"] = origin + "/join/" + token
	}
	return result
}

// managesInvites reports whether user may send and revoke the project's
// invites: the owner, or an admin when role policies are on.
func (s *Store) managesInvites(q *Queries, user, project string) bool {
	return q.One("select 1 from orka.members m join orka.projects p on p.id=m.project_id where m.project_id=$1 and m.user_id=$2 and (m.role='owner' or (m.role='admin' and p.role_policies is not null))", project, user) != nil
}

// revokeInvites deletes every invite sent to email in project. Revoking an
// address with no invites succeeds with a count of zero so retries are safe.
func (s *Store) revokeInvites(q *Queries, user, project, email string) any {
	q.One("select id from orka.projects where id=$1 for update", project)
	s.member(q, user, project)
	if !q.Require(s.managesInvites(q, user, project), 403, "Only project owners can revoke invites.") {
		return nil
	}
	row := q.One("with removed as (delete from orka.invites where project_id=$1 and email=$2 returning expires_at) select count(*) filter (where expires_at>now()) as count from removed", project, email)
	revoked := number(row["count"])
	if revoked > 0 {
		s.appendLog(q, project, Object{"action": "invite.revoked", "actor": user}, true, nil)
	}
	return Object{"email": email, "revoked": revoked}
}

// Invite states shared by the join API and the /join page.
const (
	inviteUsed               = "This invite was already used or is no longer valid. Ask the project owner for a new invite."
	inviteExpired            = "This invite has expired. Ask the project owner for a new invite."
	inviteArchived           = "This project is archived, so its invites no longer work."
	invitePreviewUnavailable = "This invite is no longer valid. Ask the project owner for a new invite."
)

// storedInvite is an invite token's row and its project's state.
type storedInvite struct {
	Project, Name, Email, ExpiresAt string
	Found, Expired, Archived        bool
}

func (s *Store) storedInvite(q *Queries, token string) storedInvite {
	row := q.One("select i.project_id,i.email,p.name,i.expires_at,i.expires_at<=now() as expired,p.archived_at is not null as archived from orka.invites i join orka.projects p on p.id=i.project_id where i.token_hash=$1", bytesHash([]byte(token)))
	return storedInvite{Project: text(row["project_id"]), Name: text(row["name"]), Email: text(row["email"]), ExpiresAt: text(row["expires_at"]), Found: row != nil, Expired: flag(row["expired"]), Archived: flag(row["archived"])}
}

// preview is the signed-out project view of a usable invite.
func (i storedInvite) preview() (Object, error) {
	if i.unavailable() != "" {
		return nil, &HTTPError{Status: 410, Message: invitePreviewUnavailable}
	}
	return Object{"projectName": i.Name, "expiresAt": i.ExpiresAt}, nil
}

func (a *API) previewInvite(w http.ResponseWriter, r *http.Request) (any, error) {
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", http.MethodPost)
		return nil, &HTTPError{Status: 405, Message: "Method not allowed"}
	}
	raw, err := readJSON(w, r)
	if err != nil {
		return nil, err
	}
	input, err := parseObject(raw, map[string]Field{"token": strField(48, 48)})
	if err != nil || !inviteToken.MatchString(text(input["token"])) {
		return nil, bad("Invalid request")
	}
	result, err := a.Store.read(r.Context(), func(q *Queries) any {
		return a.Store.storedInvite(q, text(input["token"]))
	})
	if err != nil {
		return nil, err
	}
	return result.(storedInvite).preview()
}

// unavailable says why the invite can't be used, or "" when it can.
func (i storedInvite) unavailable() string {
	switch {
	case !i.Found:
		return inviteUsed
	case i.Expired:
		return inviteExpired
	case i.Archived:
		return inviteArchived
	}
	return ""
}

func (s *Store) joinProject(q *Queries, user, token string, supported bool, verifiedEmail func() (string, error)) any {
	hash := bytesHash([]byte(token))
	invite := s.storedInvite(q, token)
	// Expiry comes before the email binding; project state comes after it so only the bound account learns it.
	if !q.Require(invite.Found && !invite.Expired, 400, invite.unavailable()) {
		return nil
	}
	if invite.Email != "" {
		address, err := verifiedEmail()
		if !q.Check(err) || !q.Require(address == invite.Email, 403, "This invite was sent to "+invite.Email+". Sign in with that verified email address to join.") {
			return nil
		}
	}
	project := invite.Project
	if !q.Require(!invite.Archived, 400, inviteArchived) {
		return nil
	}
	p := q.One("select id,governed from orka.projects where id=$1 and archived_at is null for update", project)
	if !q.Require(p != nil, 400, inviteArchived) || !q.Require(!flag(p["governed"]) || supported, 409, "Update Orka to join a project with resource permissions") {
		return nil
	}
	// Joins serialize on the project lock, so this sees any redemption that committed while waiting.
	if !q.Require(q.One("select 1 from orka.invites where token_hash=$1 and expires_at>now()", hash) != nil, 400, inviteUsed) {
		return nil
	}
	// Existing members keep the invite unused so it stays valid for its recipient and for retries.
	if q.One("select 1 from orka.members where project_id=$1 and user_id=$2", project, user) != nil {
		return Object{"id": project}
	}
	q.Exec("delete from orka.invites where token_hash=$1", hash)
	q.Exec("insert into orka.members values($1,$2,'member') on conflict do nothing", project, user)
	s.appendLog(q, project, Object{"action": "member.joined", "actor": user, "subject": user}, true, nil)
	q.Exec("update orka.projects set policy_revision=policy_revision+1 where id=$1 and governed", project)
	return Object{"id": project}
}
func (s *Store) shareSelected(ctx context.Context, user string, input Object) (any, error) {
	if flag(field(input["resource"], "deleted")) {
		return nil, bad("Select a snapshot to share, not a deletion")
	}
	var pending bool
	_, err := s.read(ctx, func(q *Queries) any {
		pending = q.One("select 1 from orka.review_requests where project_id=$1 and id=$2", input["projectId"], input["id"]) != nil
		return nil
	})
	if err != nil {
		return nil, err
	}
	if !pending {
		receipt, err := s.transaction(ctx, func(q *Queries) any { return s.change(q, user, input, ChangeOptions{}) })
		if err == nil {
			status := "published"
			if flag(field(receipt, "conflict")) {
				status = "conflict"
			}
			return Object{"status": status, "receipt": receipt}, nil
		}
		var failure *HTTPError
		if !errors.As(err, &failure) || failure.Status != 403 {
			return nil, err
		}
	}
	request, err := s.transaction(ctx, func(q *Queries) any {
		return s.governance(q, user, "submit", Object{"projectId": input["projectId"], "change": input})
	})
	return Object{"status": "approval_required", "request": request}, err
}
func isMCPPath(path string) bool {
	return path == "/mcp" || strings.HasPrefix(path, "/mcp/") || includes([]string{"/authorize", "/register", "/token", "/revoke", "/.well-known/oauth-authorization-server", "/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"}, path)
}
