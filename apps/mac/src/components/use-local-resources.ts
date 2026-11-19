import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Project, ProjectPage, ProjectResource } from "../types.js";

const kinds = ["memory", "session", "plan"] as const;
export type LocalKind = (typeof kinds)[number];
type Catalog = {
  resources: ProjectResource[];
  errors: string[];
  refreshPending?: boolean;
};
type CatalogEntry = {
  catalog?: Catalog;
  updatedAt: number;
  restoredAt?: number;
  restoring?: Promise<void>;
  pending?: Promise<void>;
};
type Catalogs = Partial<Record<LocalKind, CatalogEntry>>;

/** Restore the private index before refreshing it independently of workspace sync. */
export function useLocalResources({
  scope,
  project,
  page,
  user,
  serviceOrigin,
  syncMinutes = 15,
}: {
  scope: string;
  project: Project | undefined;
  page: ProjectPage;
  user: string | null;
  serviceOrigin: string | undefined;
  syncMinutes?: number;
}) {
  const refreshInterval = Math.max(1, Math.min(syncMinutes, 1440)) * 60_000;
  const cache = useMemo(
    () => ({
      scope,
      user,
      serviceOrigin,
      projects: new Map<string, { key: string; catalogs: Catalogs }>(),
    }),
    [scope, user, serviceOrigin],
  );
  const projectId = project?.id;
  const key = JSON.stringify([projectId, project?.path, project?.sources]);
  const catalogs = useMemo(() => {
    const cached = cache.projects.get(projectId ?? "");
    if (cached?.key === key) return cached.catalogs;
    const catalogs: Catalogs = {};
    cache.projects.set(projectId ?? "", { key, catalogs });
    return catalogs;
  }, [cache, key, projectId]);
  const kind = kinds.find((kind) => kind === page);
  const [, setVersion] = useState(0);
  const [retry, setRetry] = useState(0);
  const args = useMemo(
    () =>
      projectId && user && serviceOrigin
        ? { projectId, accountId: user, serviceOrigin }
        : null,
    [projectId, user, serviceOrigin],
  );
  const restore = useCallback(
    (kind: LocalKind) => {
      if (!args) return;
      const entry = (catalogs[kind] ??= { updatedAt: 0 });
      if (entry.restoring) return entry.restoring;
      if (
        entry.pending ||
        (entry.restoredAt !== undefined &&
          Date.now() - entry.restoredAt < refreshInterval)
      )
        return;
      entry.restoring = invoke<Catalog | null>("local_resource_catalog", {
        ...args,
        kind,
        refresh: false,
      })
        .then((value) => {
          entry.catalog = value ?? { resources: [], errors: [] };
          entry.restoredAt = Date.now();
        })
        .catch(() => {
          // Keep any previous rows. The open collection can still discover
          // resources and surface errors even when its saved index cannot load.
          entry.catalog ??= { resources: [], errors: [] };
        })
        .finally(() => {
          entry.restoring = undefined;
          setVersion((version) => version + 1);
        });
      return entry.restoring;
    },
    [args, catalogs, refreshInterval],
  );
  useEffect(() => {
    // Home and the sidebar need all persisted counts. Only the open
    // collection below performs filesystem discovery.
    for (const kind of kinds) void restore(kind);
  }, [restore]);
  const refresh = useCallback(() => {
    // Home mutations can affect any cached collection in this project.
    for (const entry of kind ? [catalogs[kind]] : Object.values(catalogs)) {
      if (entry) entry.updatedAt = 0;
    }
    setRetry((value) => value + 1);
  }, [catalogs, kind]);
  useEffect(() => {
    if (!kind || !args) return;
    let canceled = false;
    let timer: number | undefined;
    let running = false;
    const schedule = () => {
      const entry = catalogs[kind];
      const age = Date.now() - (entry?.updatedAt ?? 0);
      timer = window.setTimeout(
        () => {
          if (document.visibilityState === "visible") void load();
          else schedule();
        },
        document.visibilityState === "visible"
          ? entry?.catalog?.refreshPending
            ? 5000
            : Math.max(refreshInterval - age, 1000)
          : refreshInterval,
      );
    };
    const load = async () => {
      if (canceled || running) return;
      running = true;
      window.clearTimeout(timer);
      const entry = (catalogs[kind] ??= { updatedAt: 0 });
      if (
        !entry.pending &&
        (!entry.updatedAt || Date.now() - entry.updatedAt >= refreshInterval)
      ) {
        // A request belongs to its catalog, so navigation can reuse its result.
        const restoring =
          entry.restoring ?? (entry.catalog ? undefined : restore(kind));
        entry.pending = Promise.resolve(restoring)
          .then(() =>
            invoke<Catalog | null>("local_resource_catalog", {
              ...args,
              kind,
              refresh: true,
            }),
          )
          .then((result) => {
            entry.catalog = {
              resources: result?.resources ?? [],
              errors: result?.errors ?? [],
              refreshPending: result?.refreshPending,
            };
            // A busy daemon has not checked freshness. Retry soon, keeping the
            // persisted rows visible without turning contention into an error.
            entry.restoredAt = Date.now();
            entry.updatedAt = result?.refreshPending ? 0 : Date.now();
          })
          .catch((error) => {
            entry.catalog = {
              resources: entry.catalog?.resources ?? [],
              errors: [String(error)],
            };
            entry.updatedAt = Date.now();
          })
          .finally(() => {
            entry.pending = undefined;
            setVersion((value) => value + 1);
          });
      }
      if (entry.pending) {
        setVersion((value) => value + 1);
        await entry.pending;
      }
      running = false;
      if (!canceled) schedule();
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") void load();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    void load();
    return () => {
      canceled = true;
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [args, catalogs, kind, refreshInterval, restore, retry]);
  const memories = catalogs.memory?.catalog?.resources;
  const sessions = catalogs.session?.catalog?.resources;
  const plans = catalogs.plan?.catalog?.resources;
  const resources = useMemo(
    () => [...(memories ?? []), ...(sessions ?? []), ...(plans ?? [])],
    [memories, sessions, plans],
  );
  return {
    resources,
    pendingCounts: args ? kinds.filter((kind) => !catalogs[kind]?.catalog) : [],
    errors: kind ? (catalogs[kind]?.catalog?.errors ?? []) : [],
    result: kind ? catalogs[kind]?.catalog : undefined,
    loading: Boolean(
      kind &&
      args &&
      (catalogs[kind]?.pending ||
        catalogs[kind]?.catalog?.refreshPending ||
        !catalogs[kind]?.catalog),
    ),
    refresh,
  };
}
