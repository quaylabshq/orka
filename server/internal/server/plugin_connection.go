package server

import (
	"context"
	"net/url"
	"regexp"
	"strings"
)

var connectionSecretPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{43}$`)

// A desktop approval binds one OAuth grant to the current native account
// generation. It never changes the identity of an existing grant.
func (o *OAuth) desktopRequest(ctx context.Context, user, handoff string) (any, error) {
	if !connectionSecretPattern.MatchString(handoff) {
		return nil, bad("Invalid connection request")
	}
	return o.Store.read(ctx, func(q *Queries) any {
		row := q.One("select payload,expires_at from orka.mcp_pending where payload->>'desktopHandoffHash'=$1 and expires_at>now()", tokenHash(handoff))
		if !q.Require(row != nil && !flag(field(row["payload"], "desktopCancelled")), 404, "Connection expired. Start again from your assistant.") {
			return nil
		}
		pending := object(row["payload"])
		client, params := object(pending["client"]), object(pending["params"])
		scopes := strings.Fields(normalizedScopes(text(params["scope"])))
		descriptions := []string{}
		for _, scope := range scopes {
			descriptions = append(descriptions, mcpPermissionDescriptions[scope])
		}
		name := text(client["client_name"])
		if name == "" {
			name = "Connected assistant"
		}
		return Object{"client": Object{"id": client["client_id"], "name": name}, "accountId": user, "serviceOrigin": o.Origin, "scopes": scopes, "permissionDescriptions": descriptions, "expiresAt": row["expires_at"]}
	})
}

func (o *OAuth) approveDesktop(ctx context.Context, user string, input Object) (any, error) {
	return o.Store.transaction(ctx, func(q *Queries) any {
		row := q.One("select hash,payload from orka.mcp_pending where payload->>'desktopHandoffHash'=$1 and expires_at>now() for update", tokenHash(text(input["handoff"])))
		if !q.Require(row != nil && !flag(field(row["payload"], "desktopCancelled")), 404, "Connection expired. Start again from your assistant.") {
			return nil
		}
		pending := object(row["payload"])
		if !q.Require(pending["desktopApproval"] == nil, 409, "This connection was already approved") {
			return nil
		}
		if text(input["action"]) == "cancel" {
			pending["desktopCancelled"] = true
			q.Exec("update orka.mcp_pending set payload=$2 where hash=$1", row["hash"], pending)
			return Object{"cancelled": true}
		}
		device := q.One("select id from orka.devices where id=$1 and owner=$2", input["deviceId"], user)
		if !q.Require(device != nil, 403, "Connect this Mac to the current Orka account before approving") {
			return nil
		}
		pending["desktopApproval"] = Object{"userId": user, "deviceId": input["deviceId"], "generation": input["generation"]}
		q.Exec("update orka.mcp_pending set payload=$2 where hash=$1", row["hash"], pending)
		return Object{"approved": true}
	})
}

func (o *OAuth) desktopHandoff(ctx context.Context, tx string) (string, error) {
	handoff := oauthSecret()
	_, err := o.Store.transaction(ctx, func(q *Queries) any {
		row := q.One("select payload from orka.mcp_pending where hash=$1 and expires_at>now() for update", tokenHash(tx))
		if !q.Require(row != nil, 409, "Connection expired. Start again from your assistant.") {
			return nil
		}
		pending := object(row["payload"])
		if !q.Require(pending["desktopApproval"] == nil && !flag(pending["desktopCancelled"]), 409, "Start a fresh connection from your assistant") {
			return nil
		}
		pending["desktopHandoffHash"] = tokenHash(handoff)
		q.Exec("update orka.mcp_pending set payload=$2 where hash=$1", tokenHash(tx), pending)
		return nil
	})
	if err != nil {
		return "", err
	}
	return "orka://mcp/authorize?" + url.Values{"handoff": {handoff}, "service": {o.Origin}}.Encode(), nil
}

func (o *OAuth) completeDesktop(ctx context.Context, tx string) (string, error) {
	code := oauthSecret()
	_, err := o.Store.transaction(ctx, func(q *Queries) any {
		row := q.One("select payload from orka.mcp_pending where hash=$1 and expires_at>now() for update", tokenHash(tx))
		pending := object(row["payload"])
		approval := object(pending["desktopApproval"])
		if !q.Require(approval != nil && !flag(pending["desktopCancelled"]), 409, "This connection was completed or cancelled. Start again from your assistant.") {
			return nil
		}
		params, client := object(pending["params"]), object(pending["client"])
		q.Exec("delete from orka.mcp_pending where hash=$1", tokenHash(tx))
		q.Exec("insert into orka.mcp_codes values($1,$2,now()+interval '5 minutes')", tokenHash(code), Object{"clientId": client["client_id"], "redirectUri": params["redirectUri"], "codeChallenge": params["codeChallenge"], "userId": approval["userId"], "resource": o.resource(), "scope": normalizedScopes(text(params["scope"])), "desktopBinding": Object{"deviceId": approval["deviceId"], "generation": approval["generation"]}})
		return nil
	})
	return code, err
}

func (o *OAuth) connectionProfile(ctx context.Context, user, token string, profile Object) (any, error) {
	return o.Store.transaction(ctx, func(q *Queries) any {
		row := q.One("select desktop_binding,access_expires_at from orka.mcp_tokens where access_hash=$1 and user_id=$2 and resource=$3 and not revoked and access_expires_at>now()", tokenHash(token), user, o.resource())
		if !q.Require(row != nil, 401, "Orka connection expired or was revoked") {
			return nil
		}
		profile["desktopLinked"] = row["desktop_binding"] != nil
		if row["desktop_binding"] == nil {
			return profile
		}
		proof := oauthSecret()
		q.Exec("delete from orka.mcp_connection_proofs where expires_at<now()")
		expiry := q.One("insert into orka.mcp_connection_proofs(hash,access_hash,expires_at) values($1,$2,least(now()+interval '5 minutes',$3::timestamptz)) returning expires_at", tokenHash(proof), tokenHash(token), row["access_expires_at"])
		profile["connectionProof"] = proof
		profile["connectionProofExpiresAt"] = expiry["expires_at"]
		return profile
	})
}

func (o *OAuth) verifyConnection(ctx context.Context, user string, input Object) (any, error) {
	return o.Store.read(ctx, func(q *Queries) any {
		row := q.One("select t.family,t.user_id,t.desktop_binding,t.scopes,p.expires_at from orka.mcp_connection_proofs p join orka.mcp_tokens t on t.access_hash=p.access_hash where p.hash=$1 and p.expires_at>now() and t.access_expires_at>now() and not t.revoked and t.resource=$2", tokenHash(text(input["proof"])), o.resource())
		if !q.Require(row != nil && row["desktop_binding"] != nil, 401, "Orka connection expired. Reconnect Orka in your assistant.") {
			return nil
		}
		binding := object(row["desktop_binding"])
		if !q.Require(text(row["user_id"]) == user && binding["deviceId"] == input["deviceId"], 403, "Connect the same Orka account and Mac in your assistant") {
			return nil
		}
		if !q.Require(binding["generation"] == input["generation"], 409, "Your desktop account changed. Reconnect Orka in your assistant.") {
			return nil
		}
		device := q.One("select id from orka.devices where id=$1 and owner=$2", input["deviceId"], user)
		if !q.Require(device != nil, 403, "Connect this Mac to the current Orka account") {
			return nil
		}
		return Object{"connectionId": row["family"], "accountId": user, "serviceOrigin": o.Origin, "deviceId": binding["deviceId"], "generation": binding["generation"], "scopes": strings.Fields(text(row["scopes"])), "expiresAt": row["expires_at"]}
	})
}
