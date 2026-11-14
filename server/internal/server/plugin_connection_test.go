package server

import (
	"context"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestDesktopConsentPageModelsAndFallback(t *testing.T) {
	o := &OAuth{Origin: "https://service.example", Settings: AuthSettings{Password: true, MagicLink: true}}
	request := httptest.NewRequest("GET", "https://dashboard.example/authorize", nil)
	request = request.WithContext(context.WithValue(request.Context(), dashboardContextKey{}, true))
	for _, pending := range []bool{false, true} {
		response := httptest.NewRecorder()
		link := ""
		if pending {
			link = "orka://mcp/authorize?handoff=opaque&service=https%3A%2F%2Fservice.example"
		}
		o.page(response, request, "transaction", "Fixture", "", "", 200, "https://client.example/callback", []string{mcpScope}, link, pending)
		value, err := decode(response.Body.Bytes())
		page := object(value)
		if err != nil || page["desktopAvailable"] != true || page["desktopPending"] != pending || page["desktopUrl"] != link {
			t.Fatalf("invalid desktop page model: %s (%v)", response.Body.String(), err)
		}
		if len(stringsOf(page["scopes"])) != 1 || stringsOf(page["scopes"])[0] != mcpScope {
			t.Fatal("desktop consent changed the requested scopes")
		}
		response = httptest.NewRecorder()
		o.page(response, httptest.NewRequest("GET", "https://service.example/authorize", nil), "transaction", "<fixture>", "", "", 200, "https://client.example/callback", []string{mcpScope}, link, pending)
		html := response.Body.String()
		if strings.Contains(html, "{{") || !strings.Contains(html, "&lt;fixture&gt;") {
			t.Fatal("fallback template contains an unescaped client or unresolved field")
		}
		if pending {
			if !strings.Contains(html, `value="complete"`) || strings.Contains(html, `name="password"`) || strings.Contains(html, `value="connect"`) {
				t.Fatal("pending desktop fallback must complete the approved identity")
			}
		} else if !strings.Contains(html, `value="desktop"`) || !strings.Contains(html, `value="connect"`) {
			t.Fatal("initial fallback must offer desktop and cloud-only consent")
		}
	}
}

func TestDesktopConnectionCapabilityRequiresMCP(t *testing.T) {
	api := NewAPI(nil, AuthSettings{}, "")
	for _, enabled := range []bool{false, true} {
		if enabled {
			api.MCP = &MCP{}
		}
		response := httptest.NewRecorder()
		api.ServeHTTP(response, httptest.NewRequest("GET", "https://service.example/v2/instance", nil))
		value, err := decode(response.Body.Bytes())
		capability := field(value, "pluginConnection")
		if response.Code != 200 || err != nil || enabled && number(capability) != 1 || !enabled && capability != nil {
			t.Fatalf("MCP enabled=%v advertised incorrect capability: %s (%v)", enabled, response.Body.String(), err)
		}
	}
}
