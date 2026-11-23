import { startTransition, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { WorkspaceResource as Resource } from "../types.js";

type Preview = { title: string | null; unavailable?: boolean };
type TitleItem = { id: string; key: string };
const publishInterval = 64;

export function useSessionTitleCache(scope: string) {
  return useMemo(
    () => ({
      scope,
      previews: new Map<string, Preview>(),
      pending: new Map<string, Promise<Preview>>(),
    }),
    [scope],
  );
}

export type SessionTitleCache = ReturnType<typeof useSessionTitleCache>;

function loadTitle({ id, key }: TitleItem, cache: SessionTitleCache) {
  const ready = cache.previews.get(key);
  if (ready) return Promise.resolve(ready);
  const pending = cache.pending.get(key);
  if (pending) return pending;
  const request = invoke<string | null>("session_display_title", { id })
    .then((title) => {
      const preview = { title };
      cache.previews.set(key, preview);
      if (cache.previews.size > 500) {
        const oldest = cache.previews.keys().next().value;
        if (oldest !== undefined) cache.previews.delete(oldest);
      }
      return preview;
    })
    .catch(() => ({ title: null, unavailable: true }))
    .finally(() => cache.pending.delete(key));
  cache.pending.set(key, request);
  return request;
}

export function useSessionTitles(
  resources: Resource[],
  enabled: boolean,
  cache: SessionTitleCache,
) {
  const manifest = useMemo(
    () =>
      JSON.stringify(
        enabled
          ? resources
              .filter((resource) => resource.kind === "session")
              .map((resource) => ({
                id: resource.resourceId,
                key: JSON.stringify([
                  cache.scope,
                  resource.projectId,
                  resource.resourceId,
                  resource.files.length
                    ? resource.files.map((file) => file.hash)
                    : resource.revision,
                ]),
              }))
          : [],
      ),
    [resources, enabled, cache.scope],
  );
  const initial = useMemo(() => {
    const items: TitleItem[] = JSON.parse(manifest);
    const previews = Object.fromEntries(
      items.flatMap(({ id, key }) => {
        const preview = cache.previews.get(key);
        return preview ? [[id, preview] as const] : [];
      }),
    );
    return {
      items,
      previews,
      loading: Object.keys(previews).length < items.length,
    };
  }, [manifest, cache]);
  const [loaded, setLoaded] = useState<{
    initial: typeof initial;
    attempt: number;
    previews: Record<string, Preview>;
    loading: boolean;
  }>();
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const previews = new Map(Object.entries(initial.previews));
    const remaining = initial.items.filter((item) => {
      const preview = cache.previews.get(item.key);
      if (preview) previews.set(item.id, preview);
      return !previews.has(item.id);
    });
    if (!initial.loading) return;
    let canceled = false;
    let index = 0;
    let timer: number | undefined;
    const publish = (loading: boolean) => {
      window.clearTimeout(timer);
      timer = undefined;
      const next = {
        initial,
        attempt,
        previews: Object.fromEntries(previews),
        loading,
      };
      startTransition(() => setLoaded(next));
    };
    async function worker() {
      while (!canceled && index < remaining.length) {
        const item = remaining[index++];
        const preview = await loadTitle(item, cache);
        if (canceled) return;
        previews.set(item.id, preview);
        // Many quick IPC replies should not each trigger a table render.
        timer ??= window.setTimeout(() => publish(true), publishInterval);
      }
    }
    // Complete histories stay native-side; this view starts at most two reads.
    void Promise.all([worker(), worker()]).then(() => {
      if (!canceled) publish(false);
    });
    return () => {
      canceled = true;
      window.clearTimeout(timer);
    };
  }, [initial, cache, attempt]);

  const current = loaded?.initial === initial ? loaded : undefined;
  const previews = current?.previews ?? initial.previews;
  return {
    previews,
    loading: current
      ? current.loading || current.attempt !== attempt
      : initial.loading,
    unavailable: Object.values(previews).some((item) => item.unavailable),
    retry: () => setAttempt((value) => value + 1),
  };
}
