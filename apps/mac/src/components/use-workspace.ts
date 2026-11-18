import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Snapshot, SyncProgress, SyncQueueEntry } from "../types.js";
import type { ActionFeedback } from "./use-resource-actions.js";
import { queueEntries } from "./sync-queue.js";

const empty: Snapshot = {
  user: null,
  config: null,
  projects: [],
  resources: [],
  bindings: [],
  conflicts: [],
  activity: [],
  outbox: [],
  errors: [],
  sync: null,
  daemon: null,
  devices: [],
  deviceId: "",
  background: null,
};

/** Reads native state and serializes user actions independently of navigation. */
export function useWorkspace() {
  const [state, setState] = useState(empty);
  const [queue, setQueue] = useState<SyncQueueEntry[]>([]);
  const [hasSnapshot, setHasSnapshot] = useState(false);
  const [project, setProject] = useState("");
  const [error, setError] = useState("");
  const [refreshError, setRefreshError] = useState("");
  const [errorFeedback, setErrorFeedback] = useState<
    (ActionFeedback & { retry?: () => Promise<unknown> }) | null
  >(null);
  const [actionNotice, setActionNotice] = useState<{
    title: string;
    kind?: "success" | "queued";
  } | null>(null);
  const reportError = useCallback((message: string) => {
    setErrorFeedback(null);
    setError(message);
  }, []);
  const [busy, setBusy] = useState(false);
  const active = useRef(true);
  const generation = useRef(0);
  const locked = useRef(false);
  const scope = JSON.stringify([
    state.profile,
    state.user,
    state.config?.apiUrl,
    project,
  ]);
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  useEffect(() => {
    setError("");
    setErrorFeedback(null);
    setActionNotice(null);
  }, [scope]);

  const refresh = useCallback(async () => {
    const current = ++generation.current;
    try {
      const next = await invoke<Snapshot>("snapshot");
      if (!active.current || current !== generation.current) return;
      setState(next);
      setHasSnapshot(true);
      setRefreshError("");
      setProject((selected) =>
        next.projects.some((item) => item.id === selected)
          ? selected
          : (next.projects[0]?.id ?? ""),
      );
    } catch (error) {
      if (active.current && current === generation.current) {
        setRefreshError(String(error));
        throw error;
      }
    }
  }, []);

  const run = useCallback(
    async (
      action: () => Promise<unknown>,
      propagateError = true,
      feedback?: ActionFeedback,
    ) => {
      if (locked.current || !active.current) {
        if (propagateError)
          throw new Error(
            "Another operation is in progress. Try again shortly.",
          );
        return;
      }
      locked.current = true;
      const actionScope = scopeRef.current;
      generation.current += 1;
      setBusy(true);
      setError("");
      setErrorFeedback(null);
      try {
        await action();
        await refresh();
        if (
          feedback?.successTitle &&
          active.current &&
          actionScope === scopeRef.current
        )
          setActionNotice({
            title: feedback.successTitle,
            kind: feedback.kind,
          });
      } catch (error) {
        if (propagateError) {
          // Settings may save one preference before another fails. Refresh the
          // acknowledged state, then let the dialog retain its remaining draft.
          await refresh().catch(() => {});
          throw error;
        }
        if (active.current && actionScope === scopeRef.current) {
          setErrorFeedback({
            ...feedback,
            retry: feedback?.retryable ? action : undefined,
          });
          setError(String(error));
        }
      } finally {
        locked.current = false;
        if (active.current) setBusy(false);
      }
    },
    [refresh],
  );

  // Existing workspace actions keep their original busy/error behavior.
  const act = useCallback(
    (action: () => Promise<unknown>, feedback?: ActionFeedback) =>
      run(action, false, feedback),
    [run],
  );

  useEffect(() => {
    active.current = true;
    let stopped = false;
    let timer: number | undefined;
    const poll = async () => {
      try {
        if (!locked.current) await refresh();
      } catch (error) {
        if (!stopped) setRefreshError(String(error));
      } finally {
        // Schedule after completion so a slow native read cannot pile up polls.
        if (!stopped) timer = window.setTimeout(() => void poll(), 3000);
      }
    };
    void poll();
    return () => {
      stopped = true;
      active.current = false;
      generation.current += 1;
      window.clearTimeout(timer);
    };
  }, [refresh]);

  const profile = state.profile;
  const user = state.user;
  const apiUrl = state.config?.apiUrl;
  const running = state.daemon?.running;
  const refreshQueue = useCallback(async () => {
    try {
      const next = queueEntries(await invoke("sync_queue_state"));
      setQueue((current) =>
        JSON.stringify(current) === JSON.stringify(next) ? current : next,
      );
    } catch {
      // The queue panel is descriptive; sync progress still drives the status.
    }
  }, []);
  useEffect(() => {
    if (!user || !running) return;
    let stopped = false;
    let timer: number | undefined;
    const poll = async () => {
      try {
        const result = await invoke<{
          user: string | null;
          progress: SyncProgress | null;
        }>("sync_progress");
        if (!stopped && result.user === user && result.progress !== undefined)
          setState((current) =>
            current.profile === profile &&
            current.user === user &&
            current.config?.apiUrl === apiUrl &&
            JSON.stringify(current.syncProgress ?? null) !==
              JSON.stringify(result.progress)
              ? { ...current, syncProgress: result.progress }
              : current,
          );
      } catch {
        // The full snapshot poll still refreshes state and reports read errors.
      }
      // The queue rides the same poll and pauses with the window.
      if (!document.hidden && !stopped) await refreshQueue();
      // Schedule after completion so a slow native read cannot pile up polls.
      if (!stopped) timer = window.setTimeout(() => void poll(), 500);
    };
    void poll();
    return () => {
      stopped = true;
      window.clearTimeout(timer);
      setQueue([]);
    };
  }, [profile, user, apiUrl, running, refreshQueue]);

  return {
    state,
    queue,
    refreshQueue,
    hasSnapshot,
    project,
    setProject,
    error,
    setError: reportError,
    refreshError,
    errorFeedback,
    actionNotice,
    busy,
    act,
    run,
    refresh,
  };
}
