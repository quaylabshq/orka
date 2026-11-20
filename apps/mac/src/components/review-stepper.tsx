import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import React from "react";
import { IconButton } from "./icon-button.js";
import type { ReviewSelection } from "./reviews-page.js";

/** "2 of 4" with previous and next, over the section the review came from. */
export function ReviewStepper({
  selection,
  onChange,
}: {
  selection: ReviewSelection;
  onChange: (selection: ReviewSelection) => void;
}) {
  const { id, queue } = selection;
  const index = queue.indexOf(id);
  if (index < 0 || queue.length < 2) return null;
  const step = (offset: number) =>
    onChange({ id: queue[index + offset], queue });
  return (
    <nav className="review-stepper" aria-label="Requests">
      <span role="status">
        {index + 1} of {queue.length}
      </span>
      <IconButton
        icon={ChevronLeftIcon}
        size="sm"
        variant="tertiary"
        aria-label="Previous request"
        title="Previous request"
        disabled={index === 0}
        onClick={() => step(-1)}
      />
      <IconButton
        icon={ChevronRightIcon}
        size="sm"
        variant="tertiary"
        aria-label="Next request"
        title="Next request"
        disabled={index === queue.length - 1}
        onClick={() => step(1)}
      />
    </nav>
  );
}
