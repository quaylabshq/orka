import {
  CheckIcon,
  CopyIcon,
  GlobeIcon,
  MessagesSquareIcon,
  ShieldAlertIcon,
} from "lucide-react";
import React, { useEffect, useId, useRef, useState } from "react";
import type { ProjectResource } from "../types.js";
import { ActivityIndicator } from "./activity-indicator.js";
import { Button } from "./button.js";
import { Icon } from "./icon.js";
import { Modal } from "./modal.js";
import { invoke } from "./product-command.js";
import { fileSize } from "./share-dialog.js";
import { Switch } from "./switch.js";
import { TextField } from "./text-field.js";
import "./browser-handoff-dialog.css";

const NOTE_LIMIT = 500;
const SECRET_PREFIX = "HANDOFF_SECRET:";

export interface HandoffCandidateMemory {
  id: string;
  slug: string;
  title: string;
  scope: "local" | "shared";
  preselected: boolean;
  byteSize: number;
  redactionCount: number;
}

export interface HandoffCandidates {
  session: {
    id: string;
    title: string;
    source: string;
    messageCount: number;
    toolCallCount: number;
  };
  memories: HandoffCandidateMemory[];
}

export interface CreateHandoffReceipt {
  id: string;
  url: string;
  createdAt: string;
  expiresAt: string;
  requestId: string;
  redactionCount: number;
  messageCount: number;
  toolCallCount: number;
  memoryCount: number;
}

export function handoffSourceLabel(source?: string | null) {
  switch (source) {
    case "claude":
      return "Claude Code";
    case "codex":
      return "Codex";
    case "pi":
      return "Pi";
    default:
      return source?.trim() || "Session";
  }
}

export function formatHandoffDate(iso?: string | null) {
  if (!iso) return null;
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return null;
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(parsed));
}

function countLabel(count: number, singular: string, plural: string) {
  return `${count} ${count === 1 ? singular : plural}`;
}

function validateReceiptUrl(raw: unknown, linkOrigin: string | null): string {
  const invalid = "The Orka service returned an unexpected handoff link.";
  if (typeof raw !== "string" || !raw) throw new Error(invalid);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(invalid);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:")
    throw new Error(invalid);
  if (linkOrigin) {
    let expected: URL;
    try {
      expected = new URL(linkOrigin);
    } catch {
      throw new Error(invalid);
    }
    if (url.origin !== expected.origin || url.protocol !== expected.protocol)
      throw new Error(invalid);
  }
  if (
    !/^\/handoff\/[a-f0-9]{64}$/.test(url.pathname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error(invalid);
  return url.href;
}

const DEFAULT_SECRET_MESSAGE =
  "Orka found a secret it couldn’t remove from this handoff, so nothing was sent.";

function parseHandoffFailure(failure: unknown): {
  kind: "secret" | "general";
  message: string;
  preserveRequestId: boolean;
} {
  const objectFailure =
    failure && typeof failure === "object"
      ? (failure as {
          message?: unknown;
          kind?: unknown;
          preserveRequestId?: unknown;
        })
      : null;
  const raw = (
    typeof objectFailure?.message === "string"
      ? objectFailure.message
      : failure instanceof Error
        ? failure.message
        : String(failure)
  ).trim();
  const isSecret =
    objectFailure?.kind === "secret" || raw.startsWith(SECRET_PREFIX);
  const cleanMessage = raw.startsWith(SECRET_PREFIX)
    ? raw.slice(SECRET_PREFIX.length).trim()
    : raw;
  if (isSecret) {
    return {
      kind: "secret",
      message: cleanMessage || DEFAULT_SECRET_MESSAGE,
      preserveRequestId: false,
    };
  }
  if (typeof objectFailure?.preserveRequestId === "boolean") {
    return {
      kind: "general",
      message: cleanMessage || "Couldn’t create handoff link.",
      preserveRequestId: objectFailure.preserveRequestId,
    };
  }
  const terminal =
    /^(400|404|409|413|422):/.test(raw) ||
    /^Invalid\b/.test(raw) ||
    raw.includes("This request ID was already used") ||
    raw.includes("Use a new request ID") ||
    raw.includes("doesn’t support browser handoffs") ||
    raw.includes("doesn't support browser handoffs") ||
    raw.includes("Handoff unavailable") ||
    raw.includes("too large for your Orka service") ||
    raw.includes("too large to send") ||
    raw.includes("exceeds payload size limit") ||
    raw.includes("no longer available") ||
    raw.includes("Account or service changed") ||
    raw.includes("Session not found") ||
    raw.includes("no readable conversation") ||
    raw.includes("Choose a session to hand off") ||
    raw.includes("Keep the handoff note to ") ||
    raw.includes("Browser handoffs support Claude Code") ||
    raw.includes("rejected this handoff") ||
    raw.includes("Nothing was shared");
  return {
    kind: "general",
    message: cleanMessage || "Couldn’t create handoff link.",
    preserveRequestId: !terminal,
  };
}

export function BrowserHandoffDialog({
  resource,
  accountId,
  serviceOrigin,
  linkOrigin,
  stale,
  onOpenHandoffs,
  onClose,
  onCloseAutoFocus,
}: {
  resource: ProjectResource;
  accountId: string | null;
  serviceOrigin?: string;
  linkOrigin: string | null;
  stale: boolean;
  onOpenHandoffs?: () => void;
  onClose: () => void;
  onCloseAutoFocus?: (event: Event) => void;
}) {
  const [initialScope] = useState(() => ({ accountId, serviceOrigin }));
  const scopeChanged =
    !accountId ||
    !serviceOrigin ||
    accountId !== initialScope.accountId ||
    serviceOrigin !== initialScope.serviceOrigin;

  const [candidates, setCandidates] = useState<HandoffCandidates | null>(null);
  const [loading, setLoading] = useState(!(stale || scopeChanged));
  const [loadError, setLoadError] = useState("");
  const [loadAttempt, setLoadAttempt] = useState(0);

  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [handoffNote, setHandoffNote] = useState("");
  const [includeToolCalls, setIncludeToolCalls] = useState(false);

  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<{
    kind: "secret" | "general";
    message: string;
  } | null>(null);
  const [receipt, setReceipt] = useState<CreateHandoffReceipt | null>(null);
  const [copyStatus, setCopyStatus] = useState("");
  const [copyError, setCopyError] = useState("");

  const showReceipt = Boolean(receipt && !scopeChanged);
  const showStale = !showReceipt && (scopeChanged || (stale && !submitting));

  const activeRef = useRef(true);
  const scopeRef = useRef({ accountId, serviceOrigin });
  scopeRef.current = { accountId, serviceOrigin };
  const pendingRequestRef = useRef<{
    signature: string;
    requestId: string;
  } | null>(null);
  const copyButtonRef = useRef<HTMLButtonElement>(null);
  const secretAlertRef = useRef<HTMLDivElement>(null);
  const openingHandoffsRef = useRef(false);
  const toolsSwitchId = useId();
  const toolsHintId = useId();

  useEffect(() => {
    activeRef.current = true;
    return () => {
      activeRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (receipt && !scopeChanged) copyButtonRef.current?.focus();
  }, [receipt, scopeChanged]);

  useEffect(() => {
    if (
      submitError?.kind === "secret" &&
      typeof secretAlertRef.current?.scrollIntoView === "function"
    ) {
      secretAlertRef.current.scrollIntoView({ block: "nearest" });
    }
  }, [submitError]);

  useEffect(() => {
    if (showStale || !accountId || !serviceOrigin) {
      setLoading(false);
      return;
    }
    let canceled = false;
    setLoading(true);
    setLoadError("");
    setSubmitError(null);
    pendingRequestRef.current = null;
    void invoke<HandoffCandidates>("handoff_candidates", {
      sessionId: resource.resourceId,
      accountId,
      serviceOrigin,
    })
      .then((result) => {
        if (canceled || !activeRef.current) return;
        setCandidates(result);
        setSelectedIds(
          result.memories
            .filter((memory) => memory.preselected)
            .map((memory) => memory.id),
        );
        setIncludeToolCalls(false);
        pendingRequestRef.current = null;
      })
      .catch((failure: unknown) => {
        if (canceled || !activeRef.current) return;
        setCandidates(null);
        setLoadError(
          failure instanceof Error ? failure.message : String(failure),
        );
      })
      .finally(() => {
        if (!canceled && activeRef.current) setLoading(false);
      });
    return () => {
      canceled = true;
    };
  }, [loadAttempt, resource.resourceId, accountId, serviceOrigin, showStale]);

  const memories = candidates?.memories ?? [];
  const selectedSet = new Set(selectedIds);
  const orderedMemoryIds = memories
    .filter((memory) => selectedSet.has(memory.id))
    .map((memory) => memory.id);
  const trimmedNote = handoffNote.trim();
  const noteChars = Array.from(trimmedNote).length;
  const noteTooLong = noteChars > NOTE_LIMIT;
  const hasMessages = (candidates?.session.messageCount ?? 0) > 0;
  const hasTools = (candidates?.session.toolCallCount ?? 0) > 0;
  const effectiveIncludeTools = hasTools && includeToolCalls;
  const selectionSignature = JSON.stringify([
    resource.resourceId,
    orderedMemoryIds,
    trimmedNote,
    effectiveIncludeTools,
  ]);

  const toggleMemory = (id: string) => {
    setSubmitError(null);
    setSelectedIds((current) =>
      current.includes(id)
        ? current.filter((item) => item !== id)
        : [...current, id],
    );
  };

  const selectAllMemories = () => {
    setSubmitError(null);
    setSelectedIds(memories.map((memory) => memory.id));
  };

  const clearMemories = () => {
    setSubmitError(null);
    setSelectedIds([]);
  };

  const submit = async () => {
    if (
      submitting ||
      loading ||
      showStale ||
      !candidates ||
      !hasMessages ||
      noteTooLong ||
      !accountId ||
      !serviceOrigin
    )
      return;
    const requestId =
      pendingRequestRef.current?.signature === selectionSignature
        ? pendingRequestRef.current.requestId
        : crypto.randomUUID();
    pendingRequestRef.current = { signature: selectionSignature, requestId };
    const startedAccount = accountId;
    const startedService = serviceOrigin;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const result = await invoke<CreateHandoffReceipt>("create_handoff", {
        input: {
          sessionId: resource.resourceId,
          memoryIds: orderedMemoryIds,
          handoffNote: trimmedNote || null,
          includeToolCalls: effectiveIncludeTools,
          requestId,
          accountId: startedAccount,
          serviceOrigin: startedService,
        },
      });
      if (
        !activeRef.current ||
        scopeRef.current.accountId !== startedAccount ||
        scopeRef.current.serviceOrigin !== startedService
      )
        return;
      let validatedUrl: string;
      try {
        validatedUrl = validateReceiptUrl(result?.url, linkOrigin);
      } catch (error) {
        throw {
          kind: "general",
          message:
            error instanceof Error
              ? error.message
              : "The Orka service returned an unexpected handoff link.",
          preserveRequestId: true,
        };
      }
      pendingRequestRef.current = null;
      setReceipt({ ...result, url: validatedUrl });
      setCopyStatus("");
      setCopyError("");
    } catch (failure: unknown) {
      if (
        !activeRef.current ||
        scopeRef.current.accountId !== startedAccount ||
        scopeRef.current.serviceOrigin !== startedService
      )
        return;
      const parsed = parseHandoffFailure(failure);
      if (!parsed.preserveRequestId) {
        pendingRequestRef.current = null;
      }
      setSubmitError({ kind: parsed.kind, message: parsed.message });
    } finally {
      if (activeRef.current) setSubmitting(false);
    }
  };

  const copyLink = async () => {
    if (!receipt || scopeChanged) return;
    try {
      await navigator.clipboard.writeText(receipt.url);
      setCopyStatus("Link copied.");
      setCopyError("");
    } catch {
      setCopyStatus("");
      setCopyError("Couldn’t copy the link. Select it and copy it manually.");
    }
  };

  const sessionTitle = candidates?.session.title || resource.title;
  const sessionSource = handoffSourceLabel(
    candidates?.session.source ?? resource.source,
  );
  const expiresLabel = formatHandoffDate(receipt?.expiresAt);

  const footer = showReceipt ? (
    <>
      {onOpenHandoffs && (
        <Button
          size="sm"
          variant="tertiary"
          onClick={() => {
            openingHandoffsRef.current = true;
            onClose();
            onOpenHandoffs();
          }}
        >
          Manage links
        </Button>
      )}
      <Button size="sm" onClick={onClose}>
        Done
      </Button>
    </>
  ) : showStale ? (
    <Button
      size="sm"
      variant="tertiary"
      disabled={submitting}
      onClick={onClose}
    >
      Close
    </Button>
  ) : loadError && !candidates ? (
    <>
      <Button size="sm" variant="tertiary" onClick={onClose}>
        Cancel
      </Button>
      <Button
        size="sm"
        variant="primary"
        onClick={() => setLoadAttempt((value) => value + 1)}
      >
        Try again
      </Button>
    </>
  ) : (
    <>
      <Button
        size="sm"
        variant="tertiary"
        disabled={submitting}
        onClick={onClose}
      >
        Cancel
      </Button>
      <Button
        size="sm"
        variant="primary"
        disabled={
          submitting || loading || !candidates || !hasMessages || noteTooLong
        }
        onClick={() => void submit()}
      >
        {submitting && <ActivityIndicator />}
        {submitting
          ? "Creating link…"
          : submitError
            ? "Try again"
            : "Create handoff link"}
      </Button>
    </>
  );

  return (
    <Modal
      title={showReceipt ? "Handoff link ready" : "Share handoff link"}
      className="browser-handoff-dialog"
      closeDisabled={submitting}
      error={
        !showReceipt && !showStale && submitError?.kind === "general"
          ? submitError.message
          : undefined
      }
      fullWidthError
      footer={footer}
      onClose={() => {
        if (!submitting) onClose();
      }}
      onEscapeKeyDown={(event) => {
        if (submitting) event.preventDefault();
      }}
      onCloseAutoFocus={(event) => {
        if (openingHandoffsRef.current) {
          openingHandoffsRef.current = false;
          event.preventDefault();
          return;
        }
        onCloseAutoFocus?.(event);
      }}
    >
      <section className="browser-handoff-session" aria-label="Session summary">
        <span className="browser-handoff-session-icon" aria-hidden="true">
          <Icon icon={MessagesSquareIcon} size="md" variant="secondary" />
        </span>
        <div className="browser-handoff-session-meta">
          <p className="browser-handoff-session-title" title={sessionTitle}>
            {sessionTitle}
          </p>
          <div className="browser-handoff-session-facts">
            <span className="browser-handoff-badge">{sessionSource}</span>
            {candidates && (
              <span>
                {countLabel(
                  candidates.session.messageCount,
                  "message",
                  "messages",
                )}{" "}
                ·{" "}
                {countLabel(
                  candidates.session.toolCallCount,
                  "tool call",
                  "tool calls",
                )}
              </span>
            )}
          </div>
        </div>
      </section>

      {showReceipt && receipt ? (
        <div className="browser-handoff-receipt">
          <div className="browser-handoff-address">
            <TextField
              label="Handoff link"
              value={receipt.url}
              readOnly
              spellCheck={false}
              onFocus={(event) => event.currentTarget.select()}
            />
            <Button
              ref={copyButtonRef}
              variant="primary"
              onClick={() => void copyLink()}
            >
              <Icon icon={copyStatus ? CheckIcon : CopyIcon} size="sm" />
              Copy link
            </Button>
          </div>
          <dl className="browser-handoff-summary" aria-label="Handoff contents">
            <div>
              <dt>Conversation</dt>
              <dd>
                {countLabel(receipt.messageCount, "message", "messages")}
                {receipt.toolCallCount > 0
                  ? ` · ${countLabel(receipt.toolCallCount, "tool call", "tool calls")}`
                  : ""}
              </dd>
            </div>
            <div>
              <dt>Memories</dt>
              <dd>{countLabel(receipt.memoryCount, "memory", "memories")}</dd>
            </div>
            <div>
              <dt>Redactions</dt>
              <dd>
                {countLabel(receipt.redactionCount, "redaction", "redactions")}
              </dd>
            </div>
            <div>
              <dt>Expires</dt>
              <dd>{expiresLabel ?? "In 7 days"}</dd>
            </div>
          </dl>
          {copyError && (
            <p className="browser-handoff-alert" role="alert">
              {copyError}
            </p>
          )}
          <p className="browser-handoff-status" role="status">
            {copyStatus ||
              "Copy this link before closing. Orka cannot show it again."}
          </p>
        </div>
      ) : showStale ? (
        <p className="browser-handoff-alert" role="alert">
          {scopeChanged
            ? "Account or service changed. Open the handoff again."
            : "This session is no longer available. Close this dialog to continue."}
        </p>
      ) : loading ? (
        <div className="browser-handoff-loading" aria-busy="true">
          <p className="browser-handoff-status" role="status">
            Loading handoff options…
          </p>
          <div className="browser-handoff-skeleton" aria-hidden="true">
            <span />
            <span />
            <span />
          </div>
        </div>
      ) : loadError ? (
        <p className="browser-handoff-alert" role="alert">
          {loadError}
        </p>
      ) : candidates ? (
        <div className="browser-handoff-form">
          <div className="browser-handoff-form-scroll">
            {!hasMessages && (
              <p className="browser-handoff-alert" role="alert">
                This session has no readable conversation to hand off.
              </p>
            )}
            <section
              className="browser-handoff-memories"
              aria-label="Project memories"
            >
              <div className="browser-handoff-memories-header">
                <span className="browser-handoff-section-label">
                  Project memories
                </span>
                {memories.length > 0 && (
                  <div className="browser-handoff-memories-controls">
                    <span className="browser-handoff-memories-count">
                      {orderedMemoryIds.length} of {memories.length} selected
                    </span>
                    <Button
                      size="sm"
                      variant="tertiary"
                      className="browser-handoff-bulk-action"
                      disabled={
                        submitting ||
                        orderedMemoryIds.length === memories.length
                      }
                      onClick={selectAllMemories}
                    >
                      Select all
                    </Button>
                    <Button
                      size="sm"
                      variant="tertiary"
                      className="browser-handoff-bulk-action"
                      disabled={submitting || orderedMemoryIds.length === 0}
                      onClick={clearMemories}
                    >
                      Clear
                    </Button>
                  </div>
                )}
              </div>
              {memories.length === 0 ? (
                <p className="browser-handoff-empty">
                  No project memories available to attach.
                </p>
              ) : (
                <div
                  className="browser-handoff-memory-list"
                  role="group"
                  aria-label="Project memories to attach"
                >
                  {memories.map((memory) => {
                    const checked = selectedSet.has(memory.id);
                    return (
                      <label
                        key={memory.id}
                        className="browser-handoff-memory-row"
                        data-disabled={submitting || undefined}
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          disabled={submitting}
                          onChange={() => toggleMemory(memory.id)}
                        />
                        <span
                          className="browser-handoff-memory-title"
                          title={memory.title}
                        >
                          {memory.title}
                        </span>
                        <span className="browser-handoff-memory-meta">
                          <span className="browser-handoff-badge">
                            {memory.scope === "shared" ? "Shared" : "Local"}
                          </span>
                          <span className="browser-handoff-size">
                            {fileSize(memory.byteSize)}
                          </span>
                          {memory.redactionCount > 0 && (
                            <span
                              className="browser-handoff-redactions"
                              title={`${countLabel(memory.redactionCount, "secret", "secrets")} will be redacted`}
                            >
                              {memory.redactionCount} redacted
                            </span>
                          )}
                        </span>
                      </label>
                    );
                  })}
                </div>
              )}
            </section>

            <TextField
              label="Handoff note (optional)"
              placeholder="What should the next person focus on?"
              value={handoffNote}
              disabled={submitting}
              hint={
                handoffNote.length > 0 && !noteTooLong
                  ? `${noteChars} / ${NOTE_LIMIT} characters`
                  : undefined
              }
              error={
                noteTooLong
                  ? `Keep the handoff note to ${NOTE_LIMIT} characters or fewer.`
                  : undefined
              }
              onChange={(event) => {
                setSubmitError(null);
                setHandoffNote(event.currentTarget.value);
              }}
            />

            <div className="browser-handoff-tools">
              <div className="browser-handoff-tools-copy">
                <label htmlFor={toolsSwitchId}>Include tool calls</label>
                <p id={toolsHintId}>
                  {hasTools
                    ? "Tool inputs and outputs are redacted and size-capped."
                    : "This session has no tool calls."}
                </p>
              </div>
              <Switch
                id={toolsSwitchId}
                checked={effectiveIncludeTools}
                disabled={submitting || !hasTools}
                aria-describedby={toolsHintId}
                onChange={(event) => {
                  setSubmitError(null);
                  setIncludeToolCalls(event.currentTarget.checked);
                }}
              />
            </div>

            {submitError?.kind === "secret" && (
              <div
                ref={secretAlertRef}
                className="browser-handoff-alert browser-handoff-alert--secret"
                role="alert"
              >
                <Icon icon={ShieldAlertIcon} size="sm" />
                <div>
                  <strong>Secret blocked this handoff</strong>
                  <p>{submitError.message}</p>
                  <p>
                    Uncheck a memory or turn off tool calls, then try again.
                  </p>
                </div>
              </div>
            )}
          </div>

          <div className="browser-handoff-disclosure">
            <Icon icon={GlobeIcon} size="sm" variant="secondary" />
            <p>
              Anyone with the link can view and download this redacted copy
              without signing in. Expires in 7 days.
            </p>
          </div>
        </div>
      ) : null}
    </Modal>
  );
}
