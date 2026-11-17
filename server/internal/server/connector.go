package server

import (
	"context"
	_ "embed"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
)

//go:embed mcp-tools.json
var toolBytes []byte

var connectorTools []Object

func init() {
	if err := json.Unmarshal(toolBytes, &connectorTools); err != nil {
		panic(err)
	}
	connectorTools = append([]Object{{"name": "get_profile", "description": "Identify the account currently signed in to Orka desktop.", "scope": "orka.read", "inputSchema": Object{"type": "object", "properties": Object{}, "additionalProperties": false}}}, connectorTools...)
	for _, tool := range connectorTools {
		readOnly := text(tool["scope"]) == "orka.read"
		tool["annotations"] = Object{"readOnlyHint": readOnly, "destructiveHint": !readOnly, "idempotentHint": true, "openWorldHint": !readOnly}
	}
}

// The desktop authenticates this request with its current session. Connector
// approvals stay on that Mac; project authorization is rechecked by Reader.
func (a *API) connectorTool(ctx context.Context, user, name string, input any) (any, error) {
	if _, known := contracts["mcp:"+name]; !known {
		return nil, bad("Unknown Orka tool")
	}
	parsed, err := ValidateContract("mcp:"+name, input)
	if err != nil {
		return nil, bad("Invalid tool arguments. Check the tool schema.")
	}
	if name == "get_project_context" && !validMCPScope(text(field(parsed, "scope"))) {
		return nil, bad("Invalid tool arguments. Check the tool schema.")
	}
	origin, err := canonicalOrigin(a.Settings.PublicURL)
	if err != nil {
		return nil, &HTTPError{Status: 503, Message: "Configure the Orka service PUBLIC_URL before using desktop connectors"}
	}
	answer, err := (Reader{a.Store, user, origin}).run(ctx, name, object(parsed))
	if err != nil {
		return nil, err
	}
	structured := answer
	switch answer.(type) {
	case []Object, []any:
		structured = Object{"items": answer}
	}
	return Object{"content": []Object{{"type": "text", "text": string(jsonBytes(structured))}}, "structuredContent": structured}, nil
}

// Historical source links open the desktop without exposing any resource data
// or providing another connector authentication path.
func (a *API) connectorSource(w http.ResponseWriter, r *http.Request) error {
	parts := strings.Split(strings.TrimPrefix(r.URL.Path, "/mcp/source/"), "/")
	if len(parts) != 2 || !validUUID(parts[0]) || !validUUID(parts[1]) {
		return bad("Invalid source link")
	}
	if a.Settings.DashboardURL != "" && !fromDashboard(r) {
		http.Redirect(w, r, a.Settings.DashboardURL+r.URL.Path, http.StatusTemporaryRedirect)
		return nil
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("X-Robots-Tag", "noindex, nofollow, noarchive")
	_, err := fmt.Fprintf(w, `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Orka source</title><h1>Open this source in Orka</h1><p>Sign in to the matching Orka service to view this project resource.</p><a href="orka://project/%s/%s">Open Orka</a><p>Project: %s<br>Resource: %s</p></html>`, parts[0], parts[1], parts[0], parts[1])
	return err
}

func validMCPScope(s string) bool {
	if s == "" {
		return true
	}
	if strings.HasPrefix(s, "/") || strings.Contains(s, "\\") {
		return false
	}
	for _, part := range strings.Split(s, "/") {
		if part == "" || part == "." || part == ".." {
			return false
		}
	}
	return true
}
