import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { FileDiffCard } from "./file-diff.js";

// The fallback copy must stay platform-neutral: the capability check in
// pierre-diffs-compat.ts detects renderer features, not the OS, so the
// message cannot name macOS (or any other platform).
vi.mock("./pierre-diffs-compat.js", () => ({
  supportsPierreDiffs: () => false,
}));

afterEach(cleanup);

test("unsupported diff features show a platform-neutral fallback", () => {
  render(<FileDiffCard path="notes.md" before="one\n" after="two\n" />);

  const fallback = screen.getByRole("status");
  expect(fallback.textContent).toContain(
    "Diff preview unavailable in this window. Use Open in editor to inspect the files.",
  );
  expect(fallback.textContent).not.toContain("macOS");
});

test("a supplied fallback replaces the default message", () => {
  render(
    <FileDiffCard
      path="notes.md"
      before="one\n"
      after="two\n"
      fallback={<p role="status">Custom fallback.</p>}
    />,
  );

  expect(screen.getByRole("status").textContent).toContain("Custom fallback.");
  expect(screen.queryByText(/Diff preview unavailable/)).toBeNull();
});
