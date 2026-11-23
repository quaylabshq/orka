import React from "react";

const shortDate = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
});
const shortDateWithYear = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  year: "numeric",
});
const dateTime = new Intl.DateTimeFormat(undefined, {
  year: "numeric",
  month: "numeric",
  day: "numeric",
  hour: "numeric",
  minute: "numeric",
  second: "numeric",
});

/** "23h ago" style labels for recent activity, calendar dates beyond a week. */
function relativeUpdated(date: Date, now: number, year: number) {
  if (Number.isNaN(date.getTime())) return date.toString();
  const seconds = Math.max(0, Math.round((now - date.getTime()) / 1000));
  if (seconds < 60) return "Just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d ago`;
  return (date.getFullYear() === year ? shortDate : shortDateWithYear).format(
    date,
  );
}

/** When an item last changed, relative to now, with the full time on hover. */
export function UpdatedTime({ value, now }: { value: string; now: Date }) {
  const updated = new Date(value);
  const tooltip = Number.isNaN(updated.getTime())
    ? updated.toString()
    : dateTime.format(updated);
  return (
    <time dateTime={value} title={`Updated ${tooltip}`}>
      {relativeUpdated(updated, now.getTime(), now.getFullYear())}
    </time>
  );
}
