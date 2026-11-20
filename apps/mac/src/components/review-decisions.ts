import { useSyncExternalStore } from "react";

export type Decision = "approve" | "reject";
export interface DecisionState {
  /** On its way to the service. */
  sending?: Decision;
  /** The last attempt did not reach the service. */
  unsent?: boolean;
}

/**
 * Decisions outlive the page that sent them: Settings, another tab or Back can
 * replace it before the service answers. Holding them here keeps a request
 * from being decided twice and keeps a failure from going unseen.
 */
const decisions = new Map<string, DecisionState>();
const listeners = new Set<() => void>();
let version = 0;

const key = (projectId: string, requestId: string) =>
  `${projectId}\n${requestId}`;

function change(id: string, state: DecisionState | null) {
  if (state) decisions.set(id, state);
  else decisions.delete(id);
  version += 1;
  for (const listener of listeners) listener();
}

export const reviewDecisions = {
  get: (projectId: string, requestId: string): DecisionState =>
    decisions.get(key(projectId, requestId)) ?? {},
  start: (projectId: string, requestId: string, decision: Decision) =>
    change(key(projectId, requestId), { sending: decision }),
  fail: (projectId: string, requestId: string) =>
    change(key(projectId, requestId), { unsent: true }),
  settle: (projectId: string, requestId: string) =>
    change(key(projectId, requestId), null),
};

/** Re-renders when any decision starts, fails or settles. */
export function useReviewDecisions() {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => version,
  );
}
