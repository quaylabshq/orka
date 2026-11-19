# Email delivery

Orka sends project invitations by email when a server has delivery settings.
Without them, invites fall back to joining links and no mail is sent. Once email
is turned on, the mailbox provider decides where the message lands. That decision
depends on the sending domain and the DNS records published for it.

This page covers the settings a self-hosted server reads and the DNS work that
makes Gmail and Outlook trust the mail. Record values that the mail provider
supplies are marked.

## Settings

The API reads these variables from the server environment. Edit the private
`.env` and run `sh ./orka-server start` to apply them.

| Setting                                | Effect                                                                                                            |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `EMAIL_PROVIDER`                       | `smtp` or `resend`. Defaults to `smtp`. A server running `DEPLOYMENT_MODE=self-hosted` always resolves to `smtp`. |
| `SMTP_HOST`                            | Relay hostname. Email invitations require this and `SMTP_FROM`.                                                   |
| `SMTP_PORT`                            | Default `587`. Port `465` uses implicit TLS; other ports negotiate STARTTLS when the relay offers it.             |
| `SMTP_USER`, `SMTP_PASSWORD`           | Optional relay login. The API authenticates only when `SMTP_USER` is set.                                         |
| `SMTP_FROM`                            | From address. A display name is allowed, as in `Orka <invites@example.com>`.                                      |
| `RESEND_API_KEY`, `RESEND_FROM`        | Resend credentials and from address, used when the provider resolves to `resend`.                                 |
| `SEND_EMAIL_HOOK_SECRET`, `PUBLIC_URL` | Managed sign-in mail. `PUBLIC_URL` is also required for email invitations.                                        |

Email invitations stay available only while `PUBLIC_URL` and the provider
settings for the selected path are present. The shared Compose definition also
passes the `SMTP_*` values to GoTrue as `GOTRUE_SMTP_*`, with `SMTP_FROM` as its
sender, so sign-in mail and invitations leave through the same relay when sign-in
mail is enabled.

Point `SMTP_FROM` or `RESEND_FROM` at a mailbox on a domain you control, such as
`invites@example.com`. The domain part of the from address is the one the records
below have to cover, and you can publish those records only for a domain you own.
A free mailbox domain cannot carry your DKIM key, and its SPF record does not list
your server.

## DNS records

The mail provider publishes the record values and you copy them into your DNS
provider. None of this is implemented by Orka.

**SPF (provider value).** One TXT record on the from domain that lists the hosts
allowed to send as that domain, for example `v=spf1 include:<provider> ~all`.
Keep a single SPF record. A second one makes SPF fail for the domain.

**DKIM (provider value).** One or more TXT records holding public keys, usually
at `<selector>._domainkey.example.com`. The relay signs outgoing mail with the
matching private key. Orka's SMTP client sends the message as given and adds no
signature of its own, so a self-run mail server signs with its own DKIM setup.

**DMARC.** A TXT record at `_dmarc.<from domain>`. Start with a policy that only
reports, such as `v=DMARC1; p=none; rua=mailto:dmarc@example.com`, and read the
aggregate reports for a few weeks. Then move to `p=quarantine`, and to `p=reject`
once the reports show SPF and DKIM passing for everything you send. DMARC passes
when an authenticated SPF or DKIM domain aligns with the from domain, so a pass on
an unrelated domain does not count.

**Reverse DNS (self-run mail servers only).** The PTR record for the public
sending address must resolve to the hostname your mail server announces in its
HELO greeting, and that hostname must resolve forward to the same address. Relays
run by a provider already have this configured.

## Checking it works

1. Apply the settings, restart the server, and invite a Gmail address and an
   Outlook address you can open. The recipient needs no account on your server to
   receive the message. If your deployment sends sign-in codes, request one for
   the same addresses.
2. In Gmail, open the message and choose **Show original**. In Outlook, use
   **View** then **View message source**. Both show the message headers.
3. Find the `Authentication-Results` header. A passing message shows `spf=pass`,
   `dkim=pass` and `dmarc=pass`, and the `d=` domains belong to the domain in your
   from address.
4. Fixes follow the failing mechanism. `spf=softfail` or `spf=fail` means the SPF
   record is missing, lists the wrong sender or appears twice. `dkim=none` means
   the selector record is missing or the relay is not signing. `dmarc=fail` means
   neither SPF nor DKIM aligned, so correct those first and resend.
5. A new domain can still be filtered while its reputation is unknown. Send a low
   volume at first, ask recipients to mark early messages as not spam, and check
   the spam folder yourself before assuming a setting is wrong.

`POST /v2/invites` returns `{ sent: true, email }` once the provider accepts the
message, which for SMTP is the relay's acceptance of the message data. That
response confirms the handoff to the provider. It does not confirm the message
reached the recipient's inbox. Only the receiving mailbox can show that.
