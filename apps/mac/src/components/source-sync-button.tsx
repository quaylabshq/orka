import { Button } from "./button.js";
import { firstSyncLabel } from "./sync-queue.js";

export function SourceSyncButton({
  name,
  startsAt,
  disabled,
  onStart,
}: {
  name: string;
  startsAt: string;
  disabled: boolean;
  onStart: () => void;
}) {
  const label = firstSyncLabel(new Date(startsAt).getTime());
  return (
    <Button
      variant="secondary"
      size="sm"
      disabled={disabled}
      title={`New folder. ${label}, so you can disconnect it if it was added by mistake.`}
      aria-label={`Start syncing ${name} now`}
      onClick={onStart}
    >
      {`${label} · Sync now`}
    </Button>
  );
}
