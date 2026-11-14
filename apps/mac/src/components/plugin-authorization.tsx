import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { PlugIcon, XIcon } from "@primer/octicons-react";
import { Button } from "./button.js";
import { IconButton } from "./icon-button.js";
import { Overlay } from "./overlay.js";

export interface PluginAccount {
  id: string;
  email: string | null;
  displayName: string | null;
}

interface Authorization {
  requestId: string;
  account: PluginAccount;
  serviceOrigin: string;
  client: { id: string; name: string };
  scopes: string[];
  permissionDescriptions: string[];
  expiresAt: string;
}

export function PluginAuthorization({
  request,
  scope,
  onClose,
}: {
  request: { callback: string; scope: string };
  scope: string;
  onClose: () => void;
}) {
  const [preview, setPreview] = useState<Authorization | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [approved, setApproved] = useState(false);
  const [expired, setExpired] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const changed = request.scope !== scope;
  useEffect(() => {
    if (request.scope !== scope) return;
    let stopped = false;
    void invoke<Authorization>("plugin_authorization", {
      operation: "preview",
      input: { callback: request.callback },
    }).then(
      (result) => {
        if (!stopped) setPreview(result);
        else
          void invoke("plugin_authorization", {
            operation: "cancel",
            input: { requestId: result.requestId },
          }).catch(() => {});
      },
      (failure: unknown) => {
        if (!stopped) setError(String(failure));
      },
    );
    return () => {
      stopped = true;
    };
  }, [request.callback, request.scope, scope, attempt]);
  useEffect(() => {
    if (!preview) return;
    const remaining = Date.parse(preview.expiresAt) - Date.now();
    const timer = window.setTimeout(
      () => setExpired(true),
      Math.max(0, remaining),
    );
    return () => window.clearTimeout(timer);
  }, [preview]);
  const close = async () => {
    if (busy) return;
    if (preview && !approved) {
      setBusy(true);
      try {
        await invoke("plugin_authorization", {
          operation: "cancel",
          input: { requestId: preview.requestId },
        });
      } catch {
        // An unapproved request expires automatically if the service is offline.
      }
    }
    onClose();
  };
  const approve = async () => {
    if (!preview || busy || changed || expired) return;
    setBusy(true);
    setError("");
    try {
      await invoke("plugin_authorization", {
        operation: "approve",
        input: { requestId: preview.requestId },
      });
      setApproved(true);
    } catch (failure) {
      setError(String(failure));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Overlay
      open
      title="Connect to Orka"
      onClose={() => void close()}
      className="plugin-authorization"
    >
      <header className="review-header plugin-authorization-heading">
        <h2>Connect to Orka</h2>
        <IconButton
          icon={XIcon}
          aria-label="Close connection"
          variant="tertiary"
          size="sm"
          disabled={busy}
          onClick={() => void close()}
        />
      </header>
      {!approved && (changed || expired || error) && (
        <p role="alert" className="connector-feedback" tabIndex={0}>
          {changed
            ? "Your account or service changed. Start a new connection from your assistant."
            : expired
              ? "This request expired. Start a new connection from your assistant."
              : error}
        </p>
      )}
      <div
        className="plugin-authorization-content"
        aria-busy={busy}
        role="region"
        aria-label="Connection details"
        tabIndex={0}
      >
        {approved ? (
          <p role="status">
            Connection approved. Return to your assistant to finish connecting.
          </p>
        ) : (
          <>
            {!preview && !error && (
              <p role="status">Checking connection request…</p>
            )}
            {preview && (
              <>
                <div className="connector-identity">
                  <div className="connector-icon" aria-hidden="true">
                    <PlugIcon size={24} />
                  </div>
                  <div>
                    <h3>{preview.client.name}</h3>
                    <p>Requests access to your Orka account.</p>
                  </div>
                </div>
                <dl
                  className="plugin-connection-identity connector-consent-account"
                  aria-label="Account on this Mac"
                >
                  <div>
                    <dt>Account</dt>
                    <dd>
                      {preview.account.displayName ||
                        preview.account.email ||
                        preview.account.id}
                      {preview.account.email && preview.account.displayName && (
                        <span>{preview.account.email}</span>
                      )}
                    </dd>
                  </div>
                  <div>
                    <dt>Service</dt>
                    <dd>{preview.serviceOrigin}</dd>
                  </div>
                </dl>
                <section
                  className="connector-consent-access"
                  aria-labelledby="connector-access-title"
                >
                  <h3 id="connector-access-title">Requested access</h3>
                  <ul
                    className="plugin-permissions"
                    aria-label="Requested permissions"
                  >
                    {preview.permissionDescriptions.map((description, i) => (
                      <li key={`${preview.scopes[i]}:${description}`}>
                        {description}
                      </li>
                    ))}
                  </ul>
                </section>
                <p className="connector-consent-note">
                  Switching accounts or services requires reconnecting.
                </p>
              </>
            )}
          </>
        )}
      </div>
      <footer className="review-footer plugin-authorization-actions">
        <Button disabled={busy} onClick={() => void close()}>
          {approved ? "Done" : "Cancel"}
        </Button>
        {error && !changed && !expired && !approved && (
          <Button
            disabled={busy}
            onClick={() => {
              setError("");
              setPreview(null);
              setAttempt((value) => value + 1);
            }}
          >
            Retry connection
          </Button>
        )}
        {!approved && (
          <Button
            variant="primary"
            disabled={!preview || busy || changed || expired || Boolean(error)}
            onClick={() => void approve()}
          >
            {busy ? "Connecting…" : "Allow connection"}
          </Button>
        )}
      </footer>
    </Overlay>
  );
}
