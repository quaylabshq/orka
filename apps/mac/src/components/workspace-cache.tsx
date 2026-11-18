import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useState,
  type ReactNode,
} from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Snapshot } from "../types.js";

const WorkspaceScope = createContext("");

export class WorkspaceCache {
  static scope(state: Pick<Snapshot, "profile" | "user" | "config">) {
    return JSON.stringify([state.profile, state.user, state.config?.apiUrl]);
  }

  static createClient() {
    return new QueryClient({
      defaultOptions: {
        queries: {
          networkMode: "always", // Local IPC reads must also work offline.
          retry: false,
          refetchOnWindowFocus: false,
          refetchOnReconnect: false,
          staleTime: 30_000,
          gcTime: 5 * 60_000,
        },
      },
    });
  }
}

/** The provider's scope; query keys hold it second so a scope change evicts them. */
export function useWorkspaceScope() {
  return useContext(WorkspaceScope);
}

export function WorkspaceCacheProvider({
  state,
  children,
}: {
  state: Pick<Snapshot, "profile" | "user" | "config">;
  children: ReactNode;
}) {
  const [client] = useState(WorkspaceCache.createClient);
  const scope = WorkspaceCache.scope(state);
  useLayoutEffect(() => {
    // Removing queries also cancels their in-flight reads. Keep the new scope's
    // queries, which consumers may already have created during this render.
    client.removeQueries({ predicate: (query) => query.queryKey[1] !== scope });
  }, [client, scope]);
  useEffect(() => () => client.clear(), [client]);
  return (
    <QueryClientProvider client={client}>
      <WorkspaceScope.Provider value={scope}>
        {children}
      </WorkspaceScope.Provider>
    </QueryClientProvider>
  );
}
