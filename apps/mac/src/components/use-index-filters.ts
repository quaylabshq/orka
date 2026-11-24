import { useCallback, useEffect, useState } from "react";
import type { Resource } from "@portable/protocol";
import {
  defaultIndexFilters,
  indexPages,
  type IndexFilters,
} from "./index-pages.js";

type Kind = Resource["kind"];
const opening = (kind: Kind): IndexFilters => ({
  ...defaultIndexFilters,
  sort: indexPages[kind].defaultSort,
});
const initial: Record<Kind, IndexFilters> = {
  memory: opening("memory"),
  skill: opening("skill"),
  session: opening("session"),
  plan: opening("plan"),
};

/** Each collection's filters, and the header repository selection for ENVs. */
export function useIndexFilters(scope: string) {
  const [stored, setStored] = useState({
    scope,
    filters: initial,
    repository: "all",
  });
  const current =
    stored.scope === scope
      ? stored
      : { scope, filters: initial, repository: "all" };
  useEffect(() => {
    setStored({ scope, filters: initial, repository: "all" });
  }, [scope]);
  const set = useCallback(
    (kind: Kind, next: IndexFilters) => {
      setStored((stored) =>
        stored.scope === scope
          ? { ...stored, filters: { ...stored.filters, [kind]: next } }
          : { scope, repository: "all", filters: { ...initial, [kind]: next } },
      );
    },
    [scope],
  );
  const setRepository = useCallback(
    (repository: string) =>
      setStored((stored) => ({
        scope,
        repository,
        filters: stored.scope === scope ? stored.filters : initial,
      })),
    [scope],
  );
  return {
    filters: current.filters,
    repository: current.repository,
    setRepository,
    set,
  };
}
