import type { ProjectResource, Snapshot } from "../types.js";
import type { AttentionItem } from "./sync-attention.js";

export const sessionRecoverySharingHint =
  "Recovery choices require “Share automatically” for Sessions on this Mac. You can change this in Settings → General → Sharing.";

const sessionConflictMessage =
  "Session conflict: choose Keep, Override, or Create copy";

export interface RecoverySession {
  id: string;
  projectId: string;
  conflictId: string;
  revision: number;
  title: string;
}

export interface RecoveryEpisode {
  device: string;
  sessions: RecoverySession[];
}

export function recoveryEpisodes(
  state: Snapshot,
  items: AttentionItem[],
  projectId?: string,
) {
  const resources = new Map<string, ProjectResource>(
    state.resources
      .filter((r) => r.projectId === projectId)
      .map((r) => [r.resourceId, r]),
  );
  const pending = new Set(
    state.outbox
      .filter((o) => o.project === projectId)
      .map((o) => o.resourceId),
  );
  const byDevice = new Map<
    string,
    { at: number; session: RecoverySession }[]
  >();
  for (const item of items) {
    const current = resources.get(item.resourceId ?? "");
    if (
      !current ||
      current.kind !== "session" ||
      current.deleted !== true ||
      current.owner !== state.user ||
      !current.owner ||
      !current.projectId ||
      (current.access && current.access.mode !== "publish") ||
      !Number.isSafeInteger(current.revision) ||
      current.revision < 1 ||
      pending.has(current.resourceId) ||
      item.conflicts.length !== 1 ||
      item.requests.length ||
      item.errors.some(
        (error) =>
          error.source !== current.resourceId ||
          error.error !== sessionConflictMessage,
      ) ||
      item.draft ||
      item.binding ||
      item.uploads.length
    )
      continue;
    const conflict = item.conflicts[0];
    const incoming = conflict.candidate;
    const at = Date.parse(incoming.updatedAt);
    if (
      !conflict.deviceId?.trim() ||
      !conflict.id ||
      conflict.author !== current.owner ||
      incoming.owner !== current.owner ||
      incoming.updatedBy !== conflict.author ||
      incoming.kind !== "session" ||
      incoming.deleted !== false ||
      !incoming.files?.length ||
      incoming.projectId !== current.projectId ||
      incoming.resourceId !== current.resourceId ||
      incoming.source !== current.source ||
      incoming.sourceId !== current.sourceId ||
      !current.logicalPath ||
      incoming.logicalPath !== current.logicalPath ||
      conflict.revision !== incoming.revision ||
      conflict.revision !== current.revision ||
      !Number.isFinite(at) ||
      !/(?:Z|[+-]\d{2}:\d{2})$/i.test(incoming.updatedAt)
    )
      continue;
    const rows = byDevice.get(conflict.deviceId) ?? [];
    rows.push({
      at,
      session: {
        id: current.resourceId,
        projectId: current.projectId,
        conflictId: conflict.id,
        revision: current.revision,
        title: item.title,
      },
    });
    byDevice.set(conflict.deviceId, rows);
  }
  const episodes: RecoveryEpisode[] = [];
  for (const [device, rows] of byDevice) {
    rows.sort(
      (a, b) => a.at - b.at || a.session.id.localeCompare(b.session.id),
    );
    let start = 0;
    while (start < rows.length) {
      let end = start + 1;
      while (end < rows.length && rows[end].at - rows[start].at <= 5 * 60_000)
        end++;
      if (end - start >= 2)
        episodes.push({
          device,
          sessions: rows.slice(start, end).map((r) => r.session),
        });
      start = end;
    }
  }
  return episodes;
}
