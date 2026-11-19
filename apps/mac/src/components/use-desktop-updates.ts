import { useCallback, useEffect, useRef, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export interface DesktopRelease {
  version: string;
  sha256: string;
  notes: string;
}

interface UpdateStatus {
  installedVersion: string;
  update?: DesktopRelease;
  updateAudience?: "early" | "public";
  release?: DesktopRelease;
  message?: string;
  supported?: boolean;
}

interface UpdateProgress {
  phase: "downloading" | "verifying" | "restarting";
  downloadedBytes?: number;
  totalBytes?: number;
}

export function useDesktopUpdates(scope: string, owner: string | null) {
  const [result, setResult] = useState<{
    scope: string;
    status: UpdateStatus;
    checkedAt?: Date;
  }>();
  const status = result?.scope === scope ? result.status : undefined;
  const checkedAt = result?.scope === scope ? result.checkedAt : undefined;
  const [checking, setChecking] = useState(isTauri);
  const [error, setError] = useState("");
  const [installing, setInstalling] = useState(false);
  const [progress, setProgress] = useState<UpdateProgress>();
  const [actionError, setActionError] = useState("");
  const checkingRef = useRef<{ scope: string } | null>(null);
  const installingRef = useRef(false);
  const active = useRef(true);

  const check = useCallback(
    async (manual = false) => {
      if (
        !isTauri() ||
        checkingRef.current?.scope === scope ||
        installingRef.current
      )
        return;
      const request = { scope };
      checkingRef.current = request;
      setChecking(true);
      setError("");
      try {
        const next = await invoke<UpdateStatus>("update_status", {
          manual,
          owner,
        });
        if (!active.current || checkingRef.current !== request) return;
        if (next.message && next.supported !== false) {
          setError(next.message);
          setResult((previous) =>
            previous?.scope === scope &&
            previous.status.updateAudience !== "early"
              ? previous
              : { scope, status: next },
          );
        } else {
          setResult({
            scope,
            status: next,
            checkedAt: next.supported === false ? undefined : new Date(),
          });
        }
      } catch (reason) {
        if (!active.current || checkingRef.current !== request) return;
        setResult((previous) =>
          previous?.status.updateAudience === "early" ? undefined : previous,
        );
        setError(
          typeof reason === "string"
            ? reason
            : "Couldn’t check for updates. Check your connection and try again.",
        );
      } finally {
        if (checkingRef.current === request) {
          checkingRef.current = null;
          if (active.current) setChecking(false);
        }
      }
    },
    [owner, scope],
  );

  useEffect(() => {
    if (isTauri()) void invoke("update_ready").catch(() => {});
  }, []);

  useEffect(() => {
    active.current = true;
    if (!isTauri()) {
      setResult({
        scope,
        status: {
          installedVersion: "",
          supported: false,
          message: "Install the Orka desktop app to check for updates.",
        },
      });
      return;
    }
    setActionError("");
    void check();
    const timer = window.setInterval(() => void check(), 4 * 60 * 60 * 1000);
    return () => {
      active.current = false;
      checkingRef.current = null;
      window.clearInterval(timer);
    };
  }, [check, scope]);

  const install = async () => {
    const update = status?.update;
    if (!update || installingRef.current || checkingRef.current) return;
    installingRef.current = true;
    setInstalling(true);
    setProgress(undefined);
    setActionError("");
    let unlisten: (() => void) | undefined;
    try {
      unlisten = await listen<UpdateProgress>(
        "desktop-update-progress",
        ({ payload }) => {
          if (active.current) setProgress(payload);
        },
      );
      await invoke("update_install", {
        version: update.version,
        sha256: update.sha256,
        owner,
      });
    } catch (reason) {
      if (active.current)
        setActionError(
          typeof reason === "string"
            ? reason
            : "Couldn’t install the update. Try again.",
        );
    } finally {
      unlisten?.();
      installingRef.current = false;
      if (active.current) setInstalling(false);
    }
  };

  const openChangelog = async (version: string) => {
    setActionError("");
    try {
      await invoke("open_update_changelog", { version });
    } catch {
      if (active.current)
        setActionError("Couldn’t open the changelog in your browser.");
    }
  };

  return {
    status,
    checking,
    checkedAt,
    error,
    check,
    installing,
    progress,
    actionError,
    install,
    openChangelog,
  };
}

export type DesktopUpdates = ReturnType<typeof useDesktopUpdates>;
