import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import React, { useState } from "react";
import { afterEach, expect, test, vi } from "vitest";
import { Button } from "./button.js";
import { Modal } from "./modal.js";

afterEach(cleanup);

function Harness({ onClose }: { onClose: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button onClick={() => setOpen(true)}>Open</Button>
      {open && (
        <Modal
          title="Delete shared plan"
          onClose={() => {
            onClose();
            setOpen(false);
          }}
          footer={<Button size="sm">Confirm</Button>}
        >
          <p>Everyone in the project loses this plan.</p>
        </Modal>
      )}
    </>
  );
}

test("names the dialog by its visible title and closes on Escape", async () => {
  const onClose = vi.fn();
  render(<Harness onClose={onClose} />);
  const trigger = screen.getByRole("button", { name: "Open" });
  trigger.focus();
  fireEvent.click(trigger);

  const dialog = screen.getByRole("dialog", { name: "Delete shared plan" });
  expect(
    screen.getByRole("heading", { name: "Delete shared plan" }),
  ).toBeTruthy();
  expect(dialog.querySelectorAll("h2")).toHaveLength(1);
  expect(screen.getByRole("button", { name: "Close" })).toBeTruthy();

  fireEvent.keyDown(dialog, { key: "Escape" });
  expect(onClose).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole("dialog")).toBeNull();
  await waitFor(() => expect(document.activeElement).toBe(trigger));
});

test("keeps the accessible name when the visible heading is longer", () => {
  render(
    <Modal
      title="Revoke invite?"
      heading="Revoke the invite to sam@example.com?"
      closeButton={false}
      onClose={() => {}}
    >
      <p>Links sent to this address will stop working.</p>
    </Modal>,
  );
  expect(screen.getByRole("dialog", { name: "Revoke invite?" })).toBeTruthy();
  expect(
    screen.getByRole("heading", {
      name: "Revoke the invite to sam@example.com?",
    }),
  ).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Close" })).toBeNull();
});

test("shows a failure reason beside the footer actions", () => {
  render(
    <Modal
      title="Share with team"
      error="The service is unavailable."
      onClose={() => {}}
      footer={<Button size="sm">Try again</Button>}
    />,
  );
  const alert = screen.getByRole("alert");
  expect(alert.textContent).toBe("The service is unavailable.");
  expect(alert.closest("footer")).toBeTruthy();
});

test("opens with focus on the first action rather than the close button", async () => {
  render(
    <Modal
      title="Remove from this Mac?"
      onClose={() => {}}
      footer={
        <>
          <Button size="sm">Keep it</Button>
          <Button size="sm">Remove</Button>
        </>
      }
    >
      <p>Removing this project clears cached files on this Mac.</p>
    </Modal>,
  );
  await waitFor(() =>
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Keep it" }),
    ),
  );
});

test("focuses the dialog while its only action is disabled", async () => {
  const content = (disabled: boolean) => (
    <Modal
      title="Share with team"
      onClose={() => {}}
      footer={<Button disabled={disabled}>Share</Button>}
    >
      <p>Preparing preview</p>
    </Modal>
  );
  const { rerender } = render(content(true));
  const dialog = screen.getByRole("dialog");
  await waitFor(() => expect(document.activeElement).toBe(dialog));
  rerender(content(false));
  expect(document.activeElement).toBe(dialog);
});
