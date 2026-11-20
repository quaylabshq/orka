import type { SyncQueueEntry } from "../types.js";

/** The short state shown beside a project in the sync panel. */
export function queueStateLabel(
  entry: SyncQueueEntry,
  now = Date.now(),
): string {
  if (entry.cancelRequested) return "Stopping…";
  if (entry.state === "running") return "Syncing";
  if (entry.state === "queued") return "Queued";
  const at = entry.notBefore ? new Date(entry.notBefore).getTime() : NaN;
  if (entry.state === "scheduled") return firstSyncLabel(at, now);
  if (!Number.isFinite(at)) return "Waiting to retry";
  const minutes = Math.ceil((at - now) / 60_000);
  if (minutes <= 0) return "Waiting to retry shortly";
  if (minutes < 60) return `Waiting to retry in ${minutes} min`;
  const hours = Math.ceil(minutes / 60);
  return hours < 24
    ? `Waiting to retry in ${hours} hr`
    : `Waiting to retry in ${Math.ceil(hours / 24)} ${Math.ceil(hours / 24) === 1 ? "day" : "days"}`;
}

/** A newly connected folder waits a few minutes before its first sync. */
export function firstSyncLabel(at: number, now = Date.now()): string {
  const minutes = Math.ceil((at - now) / 60_000);
  if (!Number.isFinite(minutes) || minutes <= 0) return "Starting shortly";
  return `Starts in ${minutes} min`;
}

/** A requested cancel remains pending until the native worker settles it. */
export function canCancel(entry: SyncQueueEntry): boolean {
  return !entry.cancelRequested;
}

export function retryTime(entry: SyncQueueEntry): string | undefined {
  const at = entry.notBefore ? new Date(entry.notBefore) : null;
  return at && Number.isFinite(at.getTime())
    ? `Retry scheduled for ${at.toLocaleString()}`
    : undefined;
}

export function lastSyncLabel(
  value: string | null | undefined,
  now: number,
): string {
  const at = value ? new Date(value).getTime() : NaN;
  if (!Number.isFinite(at)) return "Not synced yet";
  const minutes = Math.floor(Math.max(0, now - at) / 60_000);
  if (!minutes) return "Last synced just now";
  if (minutes < 60) return `Last synced ${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  return hours < 24
    ? `Last synced ${hours} hr ago`
    : `Last synced ${Math.floor(hours / 24)} ${Math.floor(hours / 24) === 1 ? "day" : "days"} ago`;
}

/** Native replies are not guaranteed to be a list in older or mocked builds. */
export function queueEntries(value: unknown): SyncQueueEntry[] {
  return Array.isArray(value) ? (value as SyncQueueEntry[]) : [];
}
