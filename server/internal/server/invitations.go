package server

import (
	"bytes"
	"context"
	"crypto/tls"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"mime"
	"mime/multipart"
	"mime/quotedprintable"
	"net"
	"net/http"
	"net/mail"
	"net/smtp"
	"net/textproto"
	"strconv"
	"strings"
	"time"
	"unicode"
)

func normalizeInvitationEmail(value string) (string, error) {
	value = strings.ToLower(strings.TrimSpace(value))
	address, err := mail.ParseAddress(value)
	_, domain, _ := strings.Cut(value, "@")
	if err != nil || address.Address != value || len(value) > 254 || !strings.Contains(domain, ".") {
		return "", bad("Enter a valid email address")
	}
	return value, nil
}

func (a *API) invitationEmailAvailable() bool {
	if a.Settings.PublicURL == "" {
		return false
	}
	if a.Settings.EmailProvider == "resend" {
		return a.Environment["RESEND_API_KEY"] != "" && a.Environment["RESEND_FROM"] != ""
	}
	return a.Environment["SMTP_HOST"] != "" && a.Environment["SMTP_FROM"] != ""
}

type invitationEmail struct {
	To, Project, Link, InviterName, InviterEmail string
	ExpiresAt                                    time.Time
}

func isASCII(value string) bool {
	for i := 0; i < len(value); i++ {
		if value[i] > unicode.MaxASCII {
			return false
		}
	}
	return true
}

func (invite invitationEmail) replyTo() string {
	if !isASCII(invite.InviterEmail) || strings.ContainsAny(invite.InviterEmail, "\r\n") {
		return ""
	}
	email := strings.TrimSpace(invite.InviterEmail)
	address, err := mail.ParseAddress(email)
	if err != nil || address.Address != email {
		return ""
	}
	return email
}

func (invite invitationEmail) content() (string, string, emailHTML) {
	inviter, email := strings.TrimSpace(invite.InviterName), strings.TrimSpace(invite.InviterEmail)
	if inviter == "" {
		inviter = email
	}
	if inviter == "" {
		inviter = "A teammate"
	}
	subject := fmt.Sprintf("%s invited you to %s on Orka", inviter, invite.Project)
	if email != "" && inviter != email {
		inviter += " (" + email + ")"
	}
	expiry := invite.ExpiresAt.UTC().Format("02 Jan 2006 at 15:04 UTC")
	account := "You need an account on this Orka service with " + invite.To + " to accept."
	plain := fmt.Sprintf("%s invited you to join %s on Orka.\n\n%s\n\n%s\nSign in with %s, then review and confirm joining in Orka.\n\nThis invite expires on %s and can be used once. If you weren't expecting it, ignore this email.", inviter, invite.Project, invite.Link, account, invite.To, expiry)
	content := `<p>` + escapeHTML(inviter) + ` invited you to join <strong>` + escapeHTML(invite.Project) + `</strong> on Orka.</p><p><a href="` + escapeHTML(invite.Link) + `">Join project</a></p><p>` + escapeHTML(account) + `</p><p>Sign in with ` + escapeHTML(invite.To) + `, then review and confirm joining in Orka.</p><p>This invite expires on ` + escapeHTML(expiry) + ` and can be used once. If you weren't expecting it, ignore this email.</p>`
	return subject, plain, emailHTML(content)
}

func foldInvitationSubject(subject string) string {
	const firstLineLimit = 78 - len("Subject: ")
	encoded := mime.QEncoding.Encode("utf-8", subject)
	if len(encoded) <= firstLineLimit {
		return " " + encoded
	}

	var words []string
	if encoded == subject {
		// Encode long ASCII too, so unbroken names and repeated spaces survive folding.
		for len(subject) > 0 {
			n := min(len(subject), 42) // 56 base64 bytes plus 12 for the encoded-word wrapper.
			words = append(words, "=?utf-8?b?"+base64.StdEncoding.EncodeToString([]byte(subject[:n]))+"?=")
			subject = subject[n:]
		}
	} else {
		words = strings.Split(encoded, " ")
	}

	prefix := " "
	if len(words[0]) > firstLineLimit {
		prefix = "\r\n "
	}
	return prefix + strings.Join(words, "\r\n ")
}

func invitationMessage(from string, invite invitationEmail) ([]byte, string, error) {
	sender, err := mail.ParseAddress(from)
	if err != nil {
		return nil, "", err
	}
	id, err := randomToken(16)
	if err != nil {
		return nil, "", err
	}
	domain := sender.Address[strings.LastIndexByte(sender.Address, '@')+1:]
	if !isASCII(domain) {
		domain = "orka.invalid"
	}
	subject, plain, content := invite.content()
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	for _, part := range []struct{ kind, content string }{{"text/plain", plain}, {"text/html", content.document()}} {
		headers := textproto.MIMEHeader{"Content-Type": {part.kind + `; charset="utf-8"`}, "Content-Transfer-Encoding": {"quoted-printable"}}
		output, err := writer.CreatePart(headers)
		if err != nil {
			return nil, "", err
		}
		encoded := quotedprintable.NewWriter(output)
		if _, err = encoded.Write([]byte(part.content)); err != nil {
			return nil, "", err
		}
		if err = encoded.Close(); err != nil {
			return nil, "", err
		}
	}
	if err = writer.Close(); err != nil {
		return nil, "", err
	}
	header := fmt.Sprintf("Date: %s\r\nFrom: %s\r\nTo: %s\r\nSubject:%s\r\nMessage-ID: <%s@%s>\r\n", time.Now().Format(time.RFC1123Z), sender.String(), invite.To, foldInvitationSubject(subject), id, domain)
	if reply := invite.replyTo(); reply != "" {
		header += "Reply-To: " + reply + "\r\n"
	}
	header += fmt.Sprintf("MIME-Version: 1.0\r\nContent-Type: multipart/alternative; boundary=%q\r\n\r\n", writer.Boundary())
	return append([]byte(header), body.Bytes()...), sender.Address, nil
}

type invitationDeliveryRejected struct{ *HTTPError }

func (e *invitationDeliveryRejected) Unwrap() error { return e.HTTPError }

func (a *API) sendInvitation(ctx context.Context, invite invitationEmail, hash string) error {
	fail := &HTTPError{Status: 503, Message: "Invitation email delivery could not be confirmed. Try again in a minute or use a joining link."}
	if a.Settings.EmailProvider == "resend" {
		base := a.Environment["RESEND_API_URL"]
		if base == "" {
			base = "https://api.resend.com"
		}
		subject, plain, content := invite.content()
		payload := Object{"from": a.Environment["RESEND_FROM"], "to": invite.To, "subject": subject, "text": plain, "html": content.document()}
		if reply := invite.replyTo(); reply != "" {
			payload["reply_to"] = reply
		}
		response, err := requestHTTP(ctx, http.MethodPost, strings.TrimSuffix(base, "/")+"/emails", jsonBytes(payload), http.Header{"Authorization": {"Bearer " + a.Environment["RESEND_API_KEY"]}, "Content-Type": {"application/json"}, "Idempotency-Key": {"orka-invite-" + hash}}, 10*time.Second)
		if err != nil {
			return fail
		}
		defer response.Body.Close()
		if response.StatusCode < 200 || response.StatusCode >= 300 {
			return &invitationDeliveryRejected{fail}
		}
		return nil
	}
	if err := a.sendSMTPInvitation(ctx, invite); err != nil {
		var rejection *textproto.Error
		if errors.As(err, &rejection) && rejection.Code >= 400 && rejection.Code < 600 {
			return &invitationDeliveryRejected{fail}
		}
		return fail
	}
	return nil
}

func (a *API) sendSMTPInvitation(ctx context.Context, invite invitationEmail) error {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	host, port := a.Environment["SMTP_HOST"], a.Environment["SMTP_PORT"]
	if port == "" {
		port = "587"
	}
	n, err := strconv.Atoi(port)
	if err != nil || n < 1 || n > 65535 {
		return fmt.Errorf("invalid SMTP port")
	}
	message, from, err := invitationMessage(a.Environment["SMTP_FROM"], invite)
	if err != nil {
		return err
	}
	conn, err := (&net.Dialer{}).DialContext(ctx, "tcp", net.JoinHostPort(host, port))
	if err != nil {
		return err
	}
	defer conn.Close()
	deadline, _ := ctx.Deadline()
	if err = conn.SetDeadline(deadline); err != nil {
		return err
	}
	tlsConfig := &tls.Config{ServerName: host, MinVersion: tls.VersionTLS12}
	if port == "465" {
		secured := tls.Client(conn, tlsConfig)
		if err = secured.HandshakeContext(ctx); err != nil {
			return err
		}
		conn = secured
	}
	client, err := smtp.NewClient(conn, host)
	if err != nil {
		return err
	}
	defer client.Close()
	if port != "465" {
		if ok, _ := client.Extension("STARTTLS"); ok {
			if err = client.StartTLS(tlsConfig); err != nil {
				return err
			}
		}
	}
	if user := a.Environment["SMTP_USER"]; user != "" {
		if err = client.Auth(smtp.PlainAuth("", user, a.Environment["SMTP_PASSWORD"], host)); err != nil {
			return err
		}
	}
	if err = client.Mail(from); err != nil {
		return err
	}
	if err = client.Rcpt(invite.To); err != nil {
		return err
	}
	output, err := client.Data()
	if err != nil {
		return err
	}
	if _, err = output.Write(message); err != nil {
		return err
	}
	if err = output.Close(); err != nil {
		return err
	}
	// DATA acceptance is success even if the peer closes before QUIT.
	_ = client.Quit()
	return nil
}

func (a *API) invitationAccountEmail(ctx context.Context, token, user string) (string, error) {
	if a.AuthURL == "" {
		return "", nil
	}
	response, err := requestHTTP(ctx, http.MethodGet, strings.TrimSuffix(a.AuthURL, "/")+"/user", nil, http.Header{"Authorization": {"Bearer " + token}}, 10*time.Second)
	if err != nil {
		return "", err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return "", &HTTPError{Status: 401, Message: "Session expired"}
	}
	raw, err := io.ReadAll(io.LimitReader(response.Body, 1_000_000))
	if err != nil {
		return "", err
	}
	value, err := decode(raw)
	if err != nil {
		return "", err
	}
	account := object(value)
	if text(account["id"]) != user || text(account["email_confirmed_at"]) == "" {
		return "", nil
	}
	email, _ := normalizeInvitationEmail(text(account["email"]))
	return email, nil
}
