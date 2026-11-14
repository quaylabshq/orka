import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
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
  const [result, setResult] = useState<ConnectionStatus | null>(null);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let stopped = false;
    let pending = false;
    setResult(null);
    setError("");
    const refresh = async () => {
      if (pending || document.hidden) return;
      pending = true;
      try {
        const status = await invoke<ConnectionStatus>(
          "plugin_connection_status",
        );
        if (!stopped) {
          setResult(status);
          setError("");
        }
      } catch (failure) {
        if (!stopped) setError(String(failure));
      } finally {
        pending = false;
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 5000);
    const focus = () => void refresh();
    window.addEventListener("focus", focus);
    return () => {
      stopped = true;
      window.clearInterval(timer);
      window.removeEventListener("focus", focus);
    };
  }, [scope, revision]);
  const title =
    result?.state === "linked"
      ? "Desktop approval recorded"
      : result?.state === "reconnect_required"
        ? "Reconnect your assistant"
        : result?.state === "signed_out"
          ? "Sign in to connect"
          : "Connect using your desktop account";
  return (
    <>
      <SettingsHeading
        title="Assistant connections"
        description="Keep your assistant connected to the account you use on this Mac."
      />
      <section
        className="settings-group plugin-connection-card"
        aria-label="Assistant connection"
      >
        {error ? (
          <p role="alert">Couldn’t check this connection. {error}</p>
        ) : !result ? (
          <p role="status">Checking connection…</p>
        ) : (
          <>
            <div role="status">
              <h3>{title}</h3>
            </div>
            <dl className="plugin-connection-identity">
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
              {result.client && (
                <div>
                  <dt>Assistant</dt>
                  <dd>{result.client.name}</dd>
                </div>
              )}
            </dl>
            {result.state === "linked" ? (
              <p>
                This Mac approved the connection. Your assistant checks access
                when it uses local tools. Reconnect if the connection was
                removed or access changed.
              </p>
            ) : (
              <p>
                {result.reason ||
                  "Local tools need a connection approved by this Mac."}
              </p>
            )}
          </>
        )}
        <p>
          In your assistant’s connections, reconnect Orka and choose{" "}
          <strong>Use account in Orka</strong>. Approve the account and service
          shown here.
        </p>
        <Button size="sm" onClick={() => setRevision((value) => value + 1)}>
          Check connection
        </Button>
      </section>
    </>
  );
}
