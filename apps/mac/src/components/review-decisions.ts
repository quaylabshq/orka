import { useSyncExternalStore } from "react";
import type { ReviewRequest } from "@portable/protocol";

export type Decision = "approve" | "reject";
export interface DecisionFailure {
  serviceRejected: boolean;
  message: string;
}

export interface DecisionState {
  /** On its way to the service. */
  sending?: Decision;
  failure?: DecisionFailure;
  outcome?: Pick<ReviewRequest, "status" | "reviewer">;
}

/**
 * Decisions outlive the page that sent them: Settings, another tab or Back can
 * replace it before the service answers. Holding them here keeps a request
 * from being decided twice and keeps a failure from going unseen.
 */
const decisions = new Map<string, DecisionState>();
const listeners = new Set<() => void>();
let version = 0;

const key = (scope: string, requestId: string) => `${scope}\n${requestId}`;

function change(id: string, state: DecisionState) {
  decisions.set(id, state);
  version += 1;
  for (const listener of listeners) listener();
}

export const reviewDecisions = {
  get: (scope: string, requestId: string): DecisionState =>
    decisions.get(key(scope, requestId)) ?? {},
  start: (scope: string, requestId: string, decision: Decision) =>
    change(key(scope, requestId), { sending: decision }),
  fail: (scope: string, requestId: string, failure: DecisionFailure) =>
    change(key(scope, requestId), { failure }),
  settle: (
    scope: string,
    requestId: string,
    { status, reviewer }: ReviewRequest,
  ) => change(key(scope, requestId), { outcome: { status, reviewer } }),
  confirm: (scope: string, requests: ReviewRequest[]) => {
    for (const { id, status } of requests) {
      const entry = key(scope, id);
      if (decisions.get(entry)?.outcome?.status === status)
        decisions.delete(entry);
    }
  },
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
