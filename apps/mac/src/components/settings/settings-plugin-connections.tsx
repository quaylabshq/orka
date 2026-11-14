import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { PlugIcon } from "@primer/octicons-react";
import type { Snapshot } from "../../types.js";
import type { PluginAccount } from "../plugin-authorization.js";
import { Button } from "../button.js";
import { SettingsHeading, settingsScope } from "./settings-shared.js";

interface ConnectionStatus {
  state: "not_linked" | "linked" | "reconnect_required" | "signed_out";
  account: PluginAccount | null;
  serviceOrigin: string | null;
  client: { id: string; name: string } | null;
  scopes: string[];
  connectedAt: string | null;
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
            <h3>{result?.client?.name || "Orka"}</h3>
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
                This Mac approved this connector. Reconnect if you removed it or
                changed its access in your assistant.
              </p>
            ) : (
              <p>
                {result.reason ||
                  "Local tools need a connection approved by this Mac."}
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
      <section
        className="settings-group connector-setup"
        aria-labelledby="connector-setup-title"
      >
        <h3 id="connector-setup-title">Connect or reconnect</h3>
        <ol>
          <li>Open connections in your assistant and reconnect Orka.</li>
          <li>
            Choose <strong>Use account in Orka</strong>, then approve the
            account and access shown in Orka.
          </li>
        </ol>
      </section>
    </>
  );
}
