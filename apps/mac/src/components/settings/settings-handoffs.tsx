import { useCallback, useEffect, useRef, useState } from "react";
import type { Snapshot } from "../../types.js";
import { ActivityIndicator } from "../activity-indicator.js";
import {
  formatHandoffDate,
  handoffSourceLabel,
} from "../browser-handoff-dialog.js";
import { Button } from "../button.js";
import { LoadingRegion } from "../loading-region.js";
import { Modal } from "../modal.js";
import { invoke } from "../product-command.js";
import { SettingsHeading } from "./settings-shared.js";
import { useSettingsQuery } from "./use-settings-query.js";

export interface ActiveHandoff {
  id: string;
  title?: string;
  source?: string;
  createdAt?: string;
  expiresAt?: string;
  includeToolCalls?: boolean;
  messageCount?: number;
  toolCallCount?: number;
  memoryCount?: number;
  url: string | null;
}

export interface ListHandoffsResponse {
  supported: boolean;
  handoffs: ActiveHandoff[];
}

interface ScopedHandoffs {
  scope: string;
  response: ListHandoffsResponse;
}

function HandoffsSkeleton() {
  return (
    <div
      className="settings-group settings-handoff-skeleton"
      aria-hidden="true"
    >
      <div className="settings-handoff-row">
        <div className="settings-handoff-summary">
          <span className="settings-handoff-skeleton-title" />
          <span className="settings-handoff-skeleton-meta" />
        </div>
        <span className="settings-handoff-skeleton-action" />
      </div>
    </div>
  );
}

function countLabel(count: number, singular: string, plural: string) {
  return `${count} ${count === 1 ? singular : plural}`;
}

function formatSettingsError(raw: string) {
  return raw.replace(/^Error:\s*/i, "").trim();
}

function handoffMeta(handoff: ActiveHandoff) {
  const parts: string[] = [];
  if (typeof handoff.messageCount === "number")
    parts.push(countLabel(handoff.messageCount, "message", "messages"));
  if (typeof handoff.memoryCount === "number")
    parts.push(countLabel(handoff.memoryCount, "memory", "memories"));
  if (handoff.includeToolCalls) {
    parts.push(
      typeof handoff.toolCallCount === "number" && handoff.toolCallCount > 0
        ? countLabel(handoff.toolCallCount, "tool call", "tool calls")
        : "Tool calls included",
    );
  }
  const created = formatHandoffDate(handoff.createdAt);
  if (created) parts.push(`Created ${created}`);
  const expires = formatHandoffDate(handoff.expiresAt);
  if (expires) parts.push(`Expires ${expires}`);
  return parts.join(" · ");
}

function HandoffRows({
  handoffs,
  revokingId,
  onRevoke,
}: {
  handoffs: ActiveHandoff[];
  revokingId?: string;
  onRevoke: (handoff: ActiveHandoff) => void;
}) {
  return (
    <ul className="settings-group settings-handoff-list">
      {handoffs.map((handoff) => {
        const title = handoff.title?.trim() || "Untitled session";
        const meta = handoffMeta(handoff);
        return (
          <li className="settings-handoff-row" key={handoff.id}>
            <div className="settings-handoff-summary">
              <div className="settings-identity-name">
                <strong title={title}>{title}</strong>
                {handoff.source && (
                  <span className="settings-handoff-badge">
                    {handoffSourceLabel(handoff.source)}
                  </span>
                )}
              </div>
              {meta && <p>{meta}</p>}
            </div>
            <Button
              size="sm"
              disabled={revokingId === handoff.id}
              onClick={() => onRevoke(handoff)}
            >
              Revoke
            </Button>
          </li>
        );
      })}
    </ul>
  );
}

export function SettingsHandoffs({ state }: { state: Snapshot }) {
  const user = state.user;
  const service = state.config?.apiUrl;
  const signedIn = Boolean(user && service);
  const scopeKey = `${user ?? ""}\0${service ?? ""}`;

  const [confirmTarget, setConfirmTarget] = useState<ActiveHandoff | null>(
    null,
  );
  const [revoking, setRevoking] = useState(false);
  const [revokeError, setRevokeError] = useState("");
  const [notice, setNotice] = useState("");

  const activeRef = useRef(true);
  const scopeRef = useRef(scopeKey);
  scopeRef.current = scopeKey;
  const revokedRef = useRef(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    activeRef.current = true;
    return () => {
      activeRef.current = false;
    };
  }, []);

  useEffect(() => {
    setConfirmTarget(null);
    setRevoking(false);
    setRevokeError("");
    setNotice("");
  }, [scopeKey]);

  const load = useCallback(async (): Promise<ScopedHandoffs> => {
    if (!user || !service) {
      return { scope: scopeKey, response: { supported: true, handoffs: [] } };
    }
    const response = await invoke<ListHandoffsResponse>("list_handoffs", {
      accountId: user,
      serviceOrigin: service,
    });
    if (
      !response ||
      typeof response !== "object" ||
      typeof response.supported !== "boolean" ||
      !Array.isArray(response.handoffs)
    ) {
      throw new Error("The service returned an invalid handoff list.");
    }
    return { scope: scopeKey, response };
  }, [user, service, scopeKey]);

  const query = useSettingsQuery<ScopedHandoffs>(load, null, scopeKey);
  const scoped = query.data?.scope === scopeKey ? query.data.response : null;

  const closeConfirm = () => {
    if (revoking) return;
    revokedRef.current = false;
    setConfirmTarget(null);
    setRevokeError("");
  };

  const confirmRevoke = async () => {
    if (!confirmTarget || revoking || !user || !service || !scoped) return;
    const startedScope = scopeKey;
    const target = confirmTarget;
    const snapshot = scoped;
    setRevoking(true);
    setRevokeError("");
    try {
      await invoke<{ id: string; revoked: true }>("revoke_handoff", {
        id: target.id,
        accountId: user,
        serviceOrigin: service,
      });
      if (!activeRef.current || scopeRef.current !== startedScope) return;
      query.confirm({
        scope: startedScope,
        response: {
          ...snapshot,
          handoffs: snapshot.handoffs.filter((item) => item.id !== target.id),
        },
      });
      revokedRef.current = true;
      setConfirmTarget(null);
      setRevokeError("");
      setNotice("Handoff link revoked.");
    } catch (failure: unknown) {
      if (!activeRef.current || scopeRef.current !== startedScope) return;
      setRevokeError(
        failure instanceof Error ? failure.message : String(failure),
      );
      void query.refresh();
    } finally {
      if (activeRef.current && scopeRef.current === startedScope)
        setRevoking(false);
    }
  };

  const heading = (
    <SettingsHeading
      title="Handoff links"
      description="Active browser links you created. Links are shown only once when created and expire after 7 days."
    />
  );

  const queryErrorDetail = query.error ? formatSettingsError(query.error) : "";

  if (!signedIn) {
    return (
      <div className="settings-handoffs" ref={containerRef}>
        {heading}
        <p>Sign in to view and manage your active handoff links.</p>
      </div>
    );
  }

  return (
    <div className="settings-handoffs" ref={containerRef}>
      {heading}
      <LoadingRegion
        id="settings-handoffs"
        label="Loading handoff links…"
        loading={!scoped && !query.error}
        skeleton={<HandoffsSkeleton />}
        empty={Boolean(
          scoped && (!scoped.supported || scoped.handoffs.length === 0),
        )}
        emptyMessage={
          scoped && !scoped.supported ? (
            <p>
              This Orka service doesn’t support browser handoffs yet. Update the
              service to create and manage handoff links.
            </p>
          ) : (
            <p>
              No active handoff links. Share a session from its actions menu to
              create a 7-day link.
            </p>
          )
        }
        error={
          !scoped && query.error ? (
            <p role="alert">
              {queryErrorDetail
                ? `Couldn’t load handoff links: ${queryErrorDetail}`
                : "Couldn’t load handoff links."}{" "}
              <Button size="sm" onClick={() => void query.refresh()}>
                Retry
              </Button>
            </p>
          ) : undefined
        }
      >
        {scoped ? (
          <HandoffRows
            handoffs={scoped.handoffs}
            revokingId={revoking ? confirmTarget?.id : undefined}
            onRevoke={(handoff) => {
              revokedRef.current = false;
              setRevokeError("");
              setNotice("");
              setConfirmTarget(handoff);
            }}
          />
        ) : null}
      </LoadingRegion>
      {query.error && scoped && (
        <p role="alert">
          {queryErrorDetail
            ? `Couldn’t refresh handoff links: ${queryErrorDetail}`
            : "Couldn’t refresh handoff links."}{" "}
          <Button size="sm" onClick={() => void query.refresh()}>
            Retry
          </Button>
        </p>
      )}
      {query.extended && (
        <p>
          Still checking your handoff links. You can use the other settings.
        </p>
      )}
      <p className="settings-handoff-status" role="status">
        {notice}
      </p>
      {confirmTarget && (
        <Modal
          title="Revoke handoff link?"
          size="compact"
          className="settings-confirm"
          closeDisabled={revoking}
          onClose={closeConfirm}
          onEscapeKeyDown={(event) => {
            if (revoking) event.preventDefault();
          }}
          onCloseAutoFocus={(event) => {
            if (!revokedRef.current) return;
            revokedRef.current = false;
            event.preventDefault();
            const nextButton =
              containerRef.current?.querySelector<HTMLButtonElement>(
                ".settings-handoff-row button:not(:disabled)",
              );
            if (nextButton) nextButton.focus();
            else
              containerRef.current
                ?.querySelector<HTMLElement>(".settings-heading h2")
                ?.focus();
          }}
          footer={
            <>
              <Button
                size="sm"
                variant="tertiary"
                disabled={revoking}
                onClick={closeConfirm}
              >
                Cancel
              </Button>
              <Button
                size="sm"
                className="management-danger"
                disabled={revoking}
                onClick={() => void confirmRevoke()}
              >
                {revoking && <ActivityIndicator />}
                {revoking ? "Revoking…" : "Revoke link"}
              </Button>
            </>
          }
        >
          <p>
            Revoking{" "}
            <strong>{confirmTarget.title?.trim() || "Untitled session"}</strong>{" "}
            immediately ends access for anyone with the link and removes the
            stored snapshot.
          </p>
          {revokeError && <p role="alert">{revokeError}</p>}
        </Modal>
      )}
    </div>
  );
}
