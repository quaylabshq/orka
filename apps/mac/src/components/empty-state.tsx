import type { ReactNode } from "react";
import { Icon } from "./icon.js";
import type { IconGlyph } from "./icons.js";
import "./empty-state.css";

type EmptyIllustration =
  "project" | "updates" | "session" | "memory" | "plan" | "skill" | "search";

export function EmptyState({
  title,
  description,
  illustration,
  icon,
  size = "collection",
  heading: Heading = "h2",
  announce = false,
  actions,
  details,
}: {
  title: string;
  description?: string;
  illustration?: EmptyIllustration;
  icon?: IconGlyph;
  size?: "collection" | "compact" | "workspace";
  heading?: "h2" | "h3";
  announce?: boolean;
  actions?: ReactNode;
  /** More about the state below the actions, such as a reported cause. */
  details?: ReactNode;
}) {
  return (
    <div className={`empty-state empty-state--${size}`}>
      {illustration && (
        <img
          className="empty-state-art"
          src={`/empty-states/${illustration}.svg`}
          width={192}
          height={128}
          alt=""
          draggable={false}
        />
      )}
      {icon && (
        <span className="empty-state-icon">
          <Icon icon={icon} variant="secondary" />
        </span>
      )}
      <div className="empty-state-copy" role={announce ? "status" : undefined}>
        <Heading className="empty-state-title">{title}</Heading>
        {description && (
          <p className="empty-state-description">{description}</p>
        )}
      </div>
      {actions && <div className="empty-state-actions">{actions}</div>}
      {details}
    </div>
  );
}
