import type { SyncQueueEntry } from "../types.js";

/** The short state shown beside a project in the sync panel. */
export function queueStateLabel(entry: SyncQueueEntry): string {
  if (entry.state === "running") return "Syncing";
  if (entry.state === "queued") return "Queued";
  const at = entry.notBefore ? new Date(entry.notBefore) : null;
  return at && !Number.isNaN(at.getTime())
    ? `Retrying at ${at.toLocaleTimeString([], {
        hour: "numeric",
        minute: "2-digit",
      })}`
    : "Retrying";
}

/** A job backing off after a failure waits on its own; only queued and running jobs stop. */
export function canCancel(entry: SyncQueueEntry): boolean {
  return entry.state !== "waiting";
}

/** Native replies are not guaranteed to be a list in older or mocked builds. */
export function queueEntries(value: unknown): SyncQueueEntry[] {
  return Array.isArray(value) ? (value as SyncQueueEntry[]) : [];
}
