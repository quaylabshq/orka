package server

import (
	"bytes"
	"context"
	"io"
	"mime"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"net/mail"
	"regexp"
	"strings"
	"testing"
	"time"
)

func TestInvitationEmailValidation(t *testing.T) {
	value, err := normalizeInvitationEmail(" Person@Example.com ")
	if err != nil || value != "person@example.com" {
		t.Fatalf("normalization: %q %v", value, err)
	}
	for _, value := range []string{"", "invalid", "Name <person@example.com>", "person@example.com\r\nBcc: other@example.com", "a@b", strings.Repeat("a", 255) + "@example.com"} {
		if _, err := normalizeInvitationEmail(value); err == nil {
			t.Errorf("accepted invalid address %q", value)
		}
	}
}

func TestInvitationMailContent(t *testing.T) {
	link := "https://team.example/join/" + strings.Repeat("ab", 24)
	for _, name := range []string{"Alex", "", "  "} {
		inviter := "Alex"
		if strings.TrimSpace(name) == "" {
			inviter = "alex@example.com"
		}
		invite := invitationEmail{To: "person@example.com", Project: `<Team & "project"><script>`, Link: link, InviterName: name, InviterEmail: "alex@example.com", ExpiresAt: time.Date(2026, 11, 25, 16, 0, 0, 0, time.FixedZone("UTC+2", 2*60*60))}
		raw, from, err := invitationMessage("Orka <invite@example.com>", invite)
		if err != nil || from != "invite@example.com" {
			t.Fatalf("message: %s %v", from, err)
		}
		message, err := mail.ReadMessage(bytes.NewReader(raw))
		if err != nil {
			t.Fatal(err)
		}
		subject, err := new(mime.WordDecoder).DecodeHeader(message.Header.Get("Subject"))
		if err != nil {
			t.Fatal(err)
		}
		if subject != inviter+` invited you to <Team & "project"><script> on Orka` {
			t.Errorf("subject: %q", subject)
		}
		_, parameters, err := mime.ParseMediaType(message.Header.Get("Content-Type"))
		if err != nil {
			t.Fatal(err)
		}
		parts := multipart.NewReader(message.Body, parameters["boundary"])
		for i := 0; i < 2; i++ {
			part, err := parts.NextPart()
			if err != nil {
				t.Fatal(err)
			}
			raw, err := io.ReadAll(part)
			if err != nil {
				t.Fatal(err)
			}
			body := string(raw)
			if !strings.Contains(body, link) || !strings.Contains(body, "person@example.com") || !strings.Contains(body, inviter) || !strings.Contains(body, "25 Nov 2026 at 14:00 UTC") || !strings.Contains(body, "You need an account on this Orka service with person@example.com to accept.") {
				t.Errorf("incomplete invitation: %s", body)
			}
			if i == 0 && !strings.Contains(body, invite.Project) {
				t.Errorf("missing project: %s", body)
			}
			if i == 1 {
				assertEmailDocument(t, body)
				if !strings.Contains(body, "&lt;Team &amp; &quot;project&quot;&gt;&lt;script&gt;") || strings.Contains(body, "<Team") || strings.Contains(body, "<script>") {
					t.Errorf("unescaped HTML: %s", body)
				}
			}
		}
	}
}

func TestInvitationSubjectLineLengths(t *testing.T) {
	for _, tc := range []struct{ name, character string }{{"CJK", "界"}, {"emoji", "😀"}, {"ASCII", "a"}} {
		t.Run(tc.name, func(t *testing.T) {
			invite := invitationEmail{
				To:          "person@example.com",
				InviterName: strings.Repeat(tc.character, 80),
				Project:     strings.Repeat(tc.character, 100),
			}
			raw, _, err := invitationMessage("invite@example.com", invite)
			if err != nil {
				t.Fatal(err)
			}
			inSubject := false
			for i, line := range strings.Split(string(raw), "\r\n") {
				if len(line) > 998 {
					t.Errorf("line %d has %d bytes, over the 998-byte limit", i+1, len(line))
				}
				inSubject = strings.HasPrefix(line, "Subject:") || inSubject && strings.HasPrefix(line, " ")
				if inSubject && len(line) > 78 {
					t.Errorf("subject line %d has %d bytes, want at most 78", i+1, len(line))
				}
			}
			message, err := mail.ReadMessage(bytes.NewReader(raw))
			if err != nil {
				t.Fatal(err)
			}
			subject, err := new(mime.WordDecoder).DecodeHeader(message.Header.Get("Subject"))
			want := invite.InviterName + " invited you to " + invite.Project + " on Orka"
			if err != nil || subject != want {
				t.Errorf("decoded subject = %q, %v; want %q", subject, err, want)
			}
		})
	}
}

func TestInvitationSenderIdentity(t *testing.T) {
	for _, tc := range []struct{ name, email, subject, plain, html string }{
		{"", "", "A teammate", "A teammate", "A teammate"},
		{"  ", "  ", "A teammate", "A teammate", "A teammate"},
		{"Alex", "alex@example.com", "Alex", "Alex (alex@example.com)", "Alex (alex@example.com)"},
		{"Orka Security <script>", "alex&team@example.com", "Orka Security <script>", "Orka Security <script> (alex&team@example.com)", "Orka Security &lt;script&gt; (alex&amp;team@example.com)"},
		{"", "alex@example.com", "alex@example.com", "alex@example.com", "alex@example.com"},
	} {
		t.Run(tc.subject+tc.email, func(t *testing.T) {
			invite := invitationEmail{Project: "Harbor", InviterName: tc.name, InviterEmail: tc.email}
			subject, plain, html := invite.content()
			if subject != tc.subject+" invited you to Harbor on Orka" {
				t.Errorf("subject: %q", subject)
			}
			if !strings.HasPrefix(plain, tc.plain+" invited you to join Harbor on Orka.") {
				t.Errorf("plain sender identity: %s", plain)
			}
			if !strings.HasPrefix(string(html), "<p>"+tc.html+" invited you to join <strong>Harbor</strong> on Orka.</p>") {
				t.Errorf("HTML sender identity: %s", html)
			}
		})
	}
}

func TestInvitationSubjectHeaderInjection(t *testing.T) {
	invite := invitationEmail{To: "person@example.com", Project: "Harbor\r\nBcc: attacker@example.com", InviterName: "Alex"}
	raw, _, err := invitationMessage("invite@example.com", invite)
	if err != nil {
		t.Fatal(err)
	}
	headers, _, _ := strings.Cut(string(raw), "\r\n\r\n")
	inSubject := false
	for _, line := range strings.Split(headers, "\r\n") {
		value, startsSubject := strings.CutPrefix(line, "Subject:")
		inSubject = startsSubject || inSubject && strings.HasPrefix(line, " ")
		if inSubject {
			for _, word := range strings.Fields(value) {
				if !strings.HasPrefix(word, "=?utf-8?q?") || !strings.HasSuffix(word, "?=") {
					t.Errorf("unencoded content on subject line: %q", line)
				}
			}
		} else if strings.HasPrefix(line, "Bcc:") || strings.HasPrefix(line, " ") || strings.HasPrefix(line, "\t") {
			t.Errorf("injected or continued header: %q", line)
		}
	}
	message, err := mail.ReadMessage(bytes.NewReader(raw))
	if err != nil {
		t.Fatal(err)
	}
	subject, err := new(mime.WordDecoder).DecodeHeader(message.Header.Get("Subject"))
	if err != nil || subject != "Alex invited you to "+invite.Project+" on Orka" || message.Header.Get("Bcc") != "" {
		t.Fatalf("subject/header injection: %q %v", subject, err)
	}
}

func invitationReplyToCases() []struct{ name, email, want string } {
	return []struct{ name, email, want string }{
		{"valid", "Alex+team@example.com", "Alex+team@example.com"},
		{"missing", "", ""},
		{"invalid", "not an address", ""},
		{"non-ASCII local part", "ü@example.com", ""},
		{"non-ASCII domain", "alex@exämple.com", ""},
		{"injection", "alex@example.com\r\nBcc: other@example.com", ""},
		{"carriage return", "alex@example.com\r", ""},
		{"line feed", "alex@example.com\n", ""},
	}
}

func TestInvitationSMTPHeaders(t *testing.T) {
	wellFormed := regexp.MustCompile(`^<[A-Za-z0-9_-]+@mail\.example\.com>$`)
	seen := map[string]bool{}
	for _, tc := range invitationReplyToCases() {
		t.Run(tc.name, func(t *testing.T) {
			invite := invitationEmail{To: "person@example.com", InviterName: "Alex", InviterEmail: tc.email}
			raw, _, err := invitationMessage("Orka <invite@mail.example.com>", invite)
			if err != nil {
				t.Fatal(err)
			}
			message, err := mail.ReadMessage(bytes.NewReader(raw))
			if err != nil {
				t.Fatal(err)
			}
			if ids := message.Header["Message-Id"]; len(ids) != 1 || !wellFormed.MatchString(ids[0]) {
				t.Errorf("expected one Message-ID for mail.example.com, got %q", ids)
			} else if seen[ids[0]] {
				t.Errorf("reused Message-ID %q", ids[0])
			} else {
				seen[ids[0]] = true
			}
			replies, present := message.Header["Reply-To"]
			if tc.want == "" {
				if present {
					t.Errorf("unexpected Reply-To: %q", replies)
				}
			} else if addresses, err := message.Header.AddressList("Reply-To"); len(replies) != 1 || err != nil || len(addresses) != 1 || addresses[0].Address != tc.want {
				t.Errorf("expected one Reply-To for %s, got %q (%v)", tc.want, replies, err)
			}
			if _, present := message.Header["Bcc"]; present {
				t.Error("injected Bcc header")
			}
		})
	}
}

func TestInvitationSMTPMessageIDWithNonASCIIDomain(t *testing.T) {
	invite := invitationEmail{To: "person@example.com"}
	raw, from, err := invitationMessage("Orka <invite@exämple.com>", invite)
	if err != nil || from != "invite@exämple.com" {
		t.Fatalf("message: %s %v", from, err)
	}
	message, err := mail.ReadMessage(bytes.NewReader(raw))
	if err != nil {
		t.Fatal(err)
	}
	wellFormed := regexp.MustCompile(`^<[A-Za-z0-9_-]+@orka\.invalid>$`)
	if ids := message.Header["Message-Id"]; len(ids) != 1 || !wellFormed.MatchString(ids[0]) {
		t.Errorf("expected one Message-ID for orka.invalid, got %q", ids)
	}
}

func TestInvitationResendReplyTo(t *testing.T) {
	for _, tc := range invitationReplyToCases() {
		t.Run(tc.name, func(t *testing.T) {
			provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				raw, _ := io.ReadAll(r.Body)
				value, err := decode(raw)
				if err != nil {
					t.Error(err)
					return
				}
				reply, present := object(value)["reply_to"]
				if present != (tc.want != "") || present && reply != tc.want {
					t.Errorf("reply_to: got %v (present: %t), want %q", reply, present, tc.want)
				}
			}))
			defer provider.Close()
			api := &API{Settings: AuthSettings{EmailProvider: "resend"}, Environment: map[string]string{"RESEND_API_URL": provider.URL}}
			invite := invitationEmail{To: "person@example.com", InviterName: "Alex", InviterEmail: tc.email}
			if err := api.sendInvitation(context.Background(), invite, "hash"); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestInvitationResendAndFallback(t *testing.T) {
	api := &API{Settings: AuthSettings{PublicURL: "https://team.example", EmailProvider: "resend"}, Environment: map[string]string{}}
	if api.invitationEmailAvailable() {
		t.Fatal("unconfigured email was advertised")
	}
	fail := false
	inviter := "Alex"
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer re_fixture" || r.Header.Get("Idempotency-Key") != "orka-invite-hash" {
			t.Error("missing provider authentication/idempotency")
		}
		raw, _ := io.ReadAll(r.Body)
		value, _ := decode(raw)
		if text(field(value, "subject")) != inviter+" invited you to <script> on Orka" {
			t.Errorf("subject: %v", field(value, "subject"))
		}
		for _, kind := range []string{"text", "html"} {
			body := text(field(value, kind))
			for _, want := range []string{inviter, "person@example.com", "25 Nov 2026 at 14:00 UTC", "You need an account on this Orka service with person@example.com to accept.", "https://team.example/join/token"} {
				if !strings.Contains(body, want) {
					t.Errorf("%s missing %q: %s", kind, want, body)
				}
			}
			if kind == "html" {
				assertEmailDocument(t, body)
			}
			if kind == "html" && (!strings.Contains(body, "&lt;script&gt;") || strings.Contains(body, "<script>")) || kind == "text" && !strings.Contains(body, "<script>") {
				t.Errorf("project in %s: %s", kind, body)
			}
		}
		if fail {
			w.WriteHeader(429)
		} else {
			w.WriteHeader(200)
		}
	}))
	defer provider.Close()
	api.Environment = map[string]string{"RESEND_API_KEY": "re_fixture", "RESEND_FROM": "invite@example.com", "RESEND_API_URL": provider.URL}
	if !api.invitationEmailAvailable() {
		t.Fatal("configured email unavailable")
	}
	invite := invitationEmail{To: "person@example.com", Project: "<script>", Link: "https://team.example/join/token", InviterName: "Alex", InviterEmail: "alex@example.com", ExpiresAt: time.Date(2026, 11, 25, 14, 0, 0, 0, time.UTC)}
	if err := api.sendInvitation(context.Background(), invite, "hash"); err != nil {
		t.Fatal(err)
	}
	invite.InviterName = ""
	inviter = "alex@example.com"
	if err := api.sendInvitation(context.Background(), invite, "hash"); err != nil {
		t.Fatal(err)
	}
	fail = true
	if err := api.sendInvitation(context.Background(), invite, "hash"); err == nil || !strings.Contains(err.Error(), "joining link") {
		t.Fatalf("missing delivery failure: %v", err)
	}
	api.Settings.PublicURL = ""
	if api.invitationEmailAvailable() {
		t.Fatal("email advertised without public origin")
	}
}
