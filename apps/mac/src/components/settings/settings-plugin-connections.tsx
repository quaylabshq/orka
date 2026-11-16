import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { PlugIcon } from "@primer/octicons-react";
import type { Snapshot } from "../../types.js";
import type { PluginAccount } from "../plugin-authorization.js";
import { Button } from "../button.js";
import { SettingsHeading, settingsScope } from "./settings-shared.js";

interface ConnectionStatus {
  state:
    "not_linked" | "linked" | "pending" | "reconnect_required" | "signed_out";
  account: PluginAccount | null;
  serviceOrigin: string | null;
  connections: {
    id: string;
    client: { id: string; name: string };
    scopes: string[];
    state: string;
    connectedAt: string | null;
  }[];
  pendingCount: number;
  reason: string | null;
  reconnectRequired: boolean;
}

export function SettingsPluginConnections({ state }: { state: Snapshot }) {
  const scope = settingsScope(state);
  const [cached, setCached] = useState<{
    scope: string;
    status: ConnectionStatus;
  } | null>(null);
  const result = cached?.scope === scope ? cached.status : null;
  const [error, setError] = useState("");
  const [checking, setChecking] = useState(true);
  const [revision, setRevision] = useState(0);
  const [revoking, setRevoking] = useState<string | null>(null);
  const [actionError, setActionError] = useState("");
  const revoke = async (connectionId: string) => {
    setRevoking(connectionId);
    setActionError("");
    try {
      await invoke("plugin_authorization", {
        operation: "revoke",
        input: { connectionId },
      });
      setRevision((value) => value + 1);
    } catch (failure) {
      setActionError(String(failure));
    } finally {
      setRevoking(null);
    }
  };
  useEffect(() => {
    let stopped = false;
    let pending = false;
    setError("");
    const refresh = async (manual = false) => {
      if (pending || document.hidden) return;
      pending = true;
      if (manual) setChecking(true);
      try {
        const status = await invoke<ConnectionStatus>(
          "plugin_connection_status",
        );
        if (!stopped) {
          setCached({ scope, status });
          setError("");
        }
      } catch (failure) {
        if (!stopped) setError(String(failure));
      } finally {
        pending = false;
        if (!stopped) setChecking(false);
      }
    };
    void refresh(true);
    const timer = window.setInterval(() => void refresh(), 5000);
    const focus = () => void refresh();
    window.addEventListener("focus", focus);
    return () => {
      stopped = true;
      window.clearInterval(timer);
      window.removeEventListener("focus", focus);
    };
  }, [scope, revision]);
  const title = error
    ? "Couldn’t check connection"
    : !result
      ? "Checking connection…"
      : result.state === "linked"
        ? "Approved on this Mac"
        : result?.state === "reconnect_required"
          ? "Reconnect required"
          : result?.state === "pending"
            ? "Approval pending"
            : result?.state === "signed_out"
              ? "Sign in to connect"
              : "Not connected";
  return (
    <>
      <SettingsHeading
        title="Connectors"
        description="Connect assistants to the Orka account on this Mac."
      />
      <section
        className="settings-group connector-card"
        aria-label="Orka connector"
      >
        <div className="connector-identity connector-card-section">
          <div className="connector-icon" aria-hidden="true">
            <PlugIcon size={24} />
          </div>
          <div>
            <h3>Orka desktop</h3>
            <p role="status">{title}</p>
          </div>
        </div>
        {result && (
          <dl
            className="plugin-connection-identity connector-card-section"
            aria-label="Account on this Mac"
          >
            <div>
              <dt>Account</dt>
              <dd>
                {result.account?.displayName ||
                  result.account?.email ||
                  result.account?.id ||
                  "Signed out"}
                {result.account?.email && result.account.displayName && (
                  <span>{result.account.email}</span>
                )}
              </dd>
            </div>
            <div>
              <dt>Service</dt>
              <dd>{result.serviceOrigin || "No service selected"}</dd>
            </div>
          </dl>
        )}
        <div className="connector-card-section connector-card-actions">
          {error ? (
            <p role="alert">{error}</p>
          ) : (
            result &&
            (result.state === "linked" ? (
              <p>
                Connected assistants use the account signed in here. Review or
                revoke their sessions below.
              </p>
            ) : (
              <p>
                {result.reason ||
                  "Connect Orka from your assistant, then approve its session here."}
              </p>
            ))
          )}
          <Button
            className="connector-check-button"
            size="sm"
            disabled={checking}
            onClick={() => setRevision((value) => value + 1)}
          >
            {checking ? "Checking…" : "Check connection"}
          </Button>
        </div>
      </section>
      {result && result.connections.length > 0 && (
        <section
          className="settings-group connector-card"
          aria-label="Connector sessions"
        >
          {result.connections.map((connection) => (
            <div
              className="connector-card-section connector-session"
              key={connection.id}
            >
              <div>
                <h3>{connection.client.name}</h3>
                <p>
                  {connection.state === "approved"
                    ? connection.scopes
                        .map(
                          (value) =>
                            ({
                              "orka.read": "Read",
                              "orka.write": "Write",
                              "orka.manage": "Manage",
                            })[value] ?? value,
                        )
                        .join(" · ")
                    : connection.state === "pending"
                      ? "Awaiting approval"
                      : connection.state === "denied"
                        ? "Access removed"
                        : "Reconnect required"}
                </p>
              </div>
              {connection.state === "approved" && (
                <Button
                  size="sm"
                  disabled={revoking !== null}
                  onClick={() => void revoke(connection.id)}
                >
                  {revoking === connection.id ? "Revoking…" : "Revoke access"}
                </Button>
              )}
            </div>
          ))}
          {actionError && (
            <p role="alert" className="connector-card-section">
              {actionError}
            </p>
          )}
        </section>
      )}
      <section
        className="settings-group connector-setup"
        aria-labelledby="connector-setup-title"
      >
        <h3 id="connector-setup-title">Connect or reconnect</h3>
        <ol>
          <li>
            Install the desktop Orka plugin in your assistant and connect.
          </li>
          <li>
            Approve the account and access shown in Orka. Each new session needs
            approval.
          </li>
          <li>
            After an account or service change, reconnect from your assistant
            and approve a new session.
          </li>
        </ol>
      </section>
    </>
  );
}
