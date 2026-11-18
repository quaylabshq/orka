import { useEffect, useRef } from "react";
import {
  useInfiniteQuery,
  useQueryClient,
  type InfiniteData,
  type QueryClient,
  type QueryKey,
} from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";
import type { ProjectResource, SessionPage } from "../types.js";
import { useWorkspaceScope } from "./workspace-cache.js";

const SESSION_PAGE_SIZE = 40;
/** The native command serves at most this many turns per call. */
const SESSION_PAGE_LIMIT = 200;

/**
 * Message pages for one catalog version. Local forks can grow before discovery
 * updates their hashes, so their readers also revalidate on each visit.
 */
export class SessionMessagesQuery {
  static key(scope: string, id: string, conflict: string, content: string) {
    return ["session-messages", scope, id, conflict, content] as const;
  }

  static options(scope: string, id: string, conflict: string, content: string) {
    return {
      queryKey: this.key(scope, id, conflict, content),
      staleTime: Infinity,
      queryFn: (context: { pageParam: { offset: number; limit: number } }) =>
        invoke<SessionPage>("session_messages", {
          id,
          conflictId: conflict || null,
          ...context.pageParam,
        }),
    };
  }

  static prefetch(
    client: QueryClient,
    scope: string,
    session: ProjectResource,
  ) {
    if (session.kind !== "session") return;
    return client.prefetchInfiniteQuery({
      ...this.options(
        scope,
        session.resourceId,
        "",
        session.files.map((file) => file.hash).join(":"),
      ),
      initialPageParam: { offset: 0, limit: SESSION_PAGE_SIZE },
    });
  }

  /** Whether two keys read the same session and conflict, at any content. */
  static sameSession(a: QueryKey, b: QueryKey) {
    return a.slice(0, 4).every((part, index) => part === b[index]);
  }
}

/**
 * Pages through a session's readable turns, oldest first. Only the requested
 * window crosses the native bridge; the parsed transcript stays native-side.
 * Returning to a session reads the shared cache. When its content changes,
 * the earlier turns stay visible until the new version's first page arrives.
 */
export function useSessionMessages(
  id: string,
  conflictId: string,
  contentKey: string,
  refreshOnMount = false,
) {
  const scope = useWorkspaceScope();
  const client = useQueryClient();
  const options = SessionMessagesQuery.options(
    scope,
    id,
    conflictId,
    contentKey,
  );
  const key = options.queryKey;
  // A pending read may have captured an older native file before this visit.
  // Refetch-on-mount alone can deduplicate an existing background read.
  const pendingAtMount = useRef(
    refreshOnMount &&
      !conflictId &&
      client.getQueryState(key)?.fetchStatus === "fetching",
  );
  // Keep confirmed turns across content changes and failed refreshes. Query's
  // placeholder data disappears on error, when the earlier turns remain useful.
  const previous = useRef<{
    key: QueryKey;
    data: InfiniteData<SessionPage>;
  } | null>(null);
  if (
    previous.current &&
    !SessionMessagesQuery.sameSession(previous.current.key, key)
  )
    previous.current = null;
  const earlier = previous.current?.data;
  const shown =
    earlier?.pages.flatMap((page) => page.messages ?? []).length ?? 0;
  const query = useInfiniteQuery({
    ...options,
    refetchOnMount: refreshOnMount && !conflictId ? "always" : false,
    initialPageParam: {
      offset: 0,
      limit: Math.min(Math.max(shown, SESSION_PAGE_SIZE), SESSION_PAGE_LIMIT),
    },
    getNextPageParam: (last: SessionPage, pages: SessionPage[]) => {
      const offset = pages.flatMap((page) => page.messages ?? []).length;
      return offset < (last.total ?? offset)
        ? { offset, limit: SESSION_PAGE_SIZE }
        : undefined;
    },
  });
  useEffect(() => {
    if (!pendingAtMount.current) return;
    pendingAtMount.current = false;
    const filters = {
      queryKey: SessionMessagesQuery.key(scope, id, conflictId, contentKey),
      exact: true,
    };
    let active = true;
    void client.cancelQueries(filters).then(() => {
      if (active) void client.refetchQueries({ ...filters, type: "active" });
    });
    return () => {
      active = false;
    };
  }, [client, scope, id, conflictId, contentKey]);
  if (query.data) previous.current = { key, data: query.data };
  const data = query.data ?? earlier;
  const messages = data?.pages.flatMap((page) => page.messages ?? []);
  const last = data?.pages.at(-1);
  const loading = query.isFetching;
  const error = query.error ? String(query.error) : "";
  return {
    messages: messages ?? [],
    total: last ? (last.total ?? messages?.length ?? 0) : null,
    loading,
    /** No turns to show yet, from the cache or an earlier version. */
    pending: query.isPending && !data,
    error,
    removed: last?.removed === true,
    hasMore: query.hasNextPage,
    loadMore: () => {
      if (!loading && !error && query.hasNextPage) void query.fetchNextPage();
    },
    retry: () =>
      void (query.isFetchNextPageError
        ? query.fetchNextPage()
        : query.refetch()),
  };
}
