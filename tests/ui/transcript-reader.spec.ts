import { expect, test } from "@playwright/test";
import { detailGalleryFixture } from "./fixtures/detail-gallery.js";

test("keeps the visible transcript offset when preceding text becomes ready", async ({
  page,
}) => {
  const view = await detailGalleryFixture(page, { kind: "session" });
  await page.evaluate(() => {
    const w = window as any;
    const invoke = w.__TAURI_INTERNALS__.invoke;
    const transcript =
      "Synthetic transcript begins\n" +
      Array.from(
        { length: 3800 },
        (_, i) => `Record ${i} ${"with more text ".repeat((i % 7) + 1)}\n`,
      ).join("") +
      "Exact last line";
    w.__TAURI_INTERNALS__.invoke = async (command: string, request: any) => {
      if (command !== "read_transcript") return invoke(command, request);
      if (request.before) {
        await new Promise<void>((resolve) => {
          w.finishPrepend = resolve;
        });
      }
      const backward = request.before || request.offset === null;
      const position = request.offset ?? transcript.length;
      const offset = backward
        ? Math.max(0, position - request.maxBytes)
        : position;
      const nextOffset = backward
        ? position
        : Math.min(transcript.length, position + request.maxBytes);
      return {
        offset,
        nextOffset,
        text: transcript.slice(offset, nextOffset),
        eof: nextOffset === transcript.length,
      };
    };
  });
  await view.getByRole("button", { name: "Transcript", exact: true }).click();
  const text = view.getByRole("region", { name: "Transcript text" });
  await expect(text).toContainText("Synthetic transcript begins");
  await text.focus();
  await text.press("End");
  await expect(text).toContainText("Exact last line");
  await expect(text).toBeFocused();
  await expect(text).not.toContainText("Synthetic transcript begins");

  const scroller = view.locator(".detail-reader");
  await scroller.evaluate((reader) => {
    const blocks = reader.querySelector(".transcript-blocks")!;
    reader.scrollTop +=
      blocks.getBoundingClientRect().top -
      reader.getBoundingClientRect().top -
      40;
  });
  await expect
    .poll(() => page.evaluate(() => typeof (window as any).finishPrepend))
    .toBe("function");

  const before = await scroller.evaluate((reader) => {
    const viewport = reader.getBoundingClientRect();
    const blocks = Array.from(
      reader.querySelectorAll<HTMLElement>(".transcript-block[data-offset]"),
    );
    const stable = blocks.find(
      (block) => block.getBoundingClientRect().bottom > viewport.top + 100,
    )!;
    return {
      offset: stable.dataset.offset,
      top: stable.getBoundingClientRect().top - viewport.top,
    };
  });
  await page.evaluate(() => (window as any).finishPrepend());
  await expect
    .poll(() =>
      scroller.evaluate((reader, { offset, top }) => {
        const block = reader.querySelector(
          `.transcript-block[data-offset="${offset}"]`,
        );
        if (!block) return Infinity;
        const actualTop =
          block.getBoundingClientRect().top -
          reader.getBoundingClientRect().top;
        return Math.abs(actualTop - top);
      }, before),
    )
    .toBeLessThanOrEqual(24);
  await expect(text).toBeFocused();
});

test("closes a reader whose open reply arrives after leaving Transcript", async ({
  page,
}) => {
  const view = await detailGalleryFixture(page, { kind: "session" });
  await page.evaluate(() => {
    const w = window as any;
    const invoke = w.__TAURI_INTERNALS__.invoke;
    w.closedReaders = [];
    w.__TAURI_INTERNALS__.invoke = async (command: string, request: any) => {
      if (command === "open_transcript") {
        await new Promise<void>((resolve) => {
          w.finishOldOpen = resolve;
        });
        return { readerId: "obsolete-reader", sessionSnapshot: null };
      }
      if (command === "close_transcript") {
        w.closedReaders.push(request.readerId);
        return null;
      }
      if (command === "read_transcript")
        throw new Error("An obsolete reader must never be read");
      return invoke(command, request);
    };
  });
  await view.getByRole("button", { name: "Transcript", exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => typeof (window as any).finishOldOpen))
    .toBe("function");
  await view.getByRole("button", { name: "Conversation", exact: true }).click();
  await page.evaluate(() => (window as any).finishOldOpen());
  await expect
    .poll(() => page.evaluate(() => (window as any).closedReaders))
    .toEqual(["obsolete-reader"]);
  await expect(
    view.getByRole("region", { name: "Transcript text" }),
  ).toHaveCount(0);
});

test("copies consecutive transcript blocks exactly and rejects an incomplete selection", async ({
  page,
}) => {
  const view = await detailGalleryFixture(page, { kind: "session" });
  await page.evaluate(() => {
    const w = window as any;
    const invoke = w.__TAURI_INTERNALS__.invoke;
    const transcript = "A readable transcript line.\n".repeat(320);
    w.__TAURI_INTERNALS__.invoke = (command: string, request: any) => {
      if (command !== "read_transcript") return invoke(command, request);
      return Promise.resolve({
        offset: 0,
        nextOffset: transcript.length,
        text: transcript,
        eof: true,
      });
    };
  });
  await view.getByRole("button", { name: "Transcript", exact: true }).click();
  const content = view.locator(".transcript-blocks");
  await expect(content.locator("pre").nth(1)).toBeAttached();
  const result = await content.evaluate((list) => {
    const selection = window.getSelection()!;
    const [first, second] = Array.from(list.querySelectorAll("pre"));
    const copy = (range: Range) => {
      selection.removeAllRanges();
      selection.addRange(range);
      const clipboardData = new DataTransfer();
      const event = new ClipboardEvent("copy", {
        bubbles: true,
        cancelable: true,
        clipboardData,
      });
      first.dispatchEvent(event);
      return {
        stopped: event.defaultPrevented,
        text: clipboardData.getData("text/plain"),
      };
    };
    const acrossBlocks = document.createRange();
    acrossBlocks.setStart(first.firstChild!, first.textContent!.length - 13);
    acrossBlocks.setEnd(second.firstChild!, 12);
    const exact = copy(acrossBlocks);
    const incomplete = document.createRange();
    incomplete.selectNode(list);
    const rejected = copy(incomplete);
    selection.removeAllRanges();
    return {
      exact,
      rejected,
      expected:
        first.textContent!.slice(-13) + second.textContent!.slice(0, 12),
    };
  });
  expect(result.exact).toEqual({ stopped: true, text: result.expected });
  expect(result.rejected).toEqual({ stopped: true, text: "" });
  await expect(
    view.getByText("Select a shorter range or download the session."),
  ).toBeVisible();
});

test("clears an invalidated page even when a jump is waiting", async ({
  page,
}) => {
  const view = await detailGalleryFixture(page, { kind: "session" });
  await page.evaluate(() => {
    const w = window as any;
    const invoke = w.__TAURI_INTERNALS__.invoke;
    w.__TAURI_INTERNALS__.invoke = (command: string, request: any) => {
      if (command !== "read_transcript") return invoke(command, request);
      if (request.offset === 0) {
        const text = "Revocable session text.\n".repeat(40);
        return Promise.resolve({
          offset: 0,
          nextOffset: text.length,
          text,
          eof: false,
        });
      }
      if (request.offset === null) {
        w.staleJumpExecuted = true;
        throw new Error("A queued jump must be cancelled after invalidation");
      }
      return new Promise((_resolve, reject) => {
        w.invalidateTranscript = () =>
          reject("transcript_snapshot_invalidated");
      });
    };
  });
  await view.getByRole("button", { name: "Transcript", exact: true }).click();
  await expect(view.getByText(/Revocable session text/)).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(() => typeof (window as any).invalidateTranscript),
    )
    .toBe("function");
  await view.getByRole("button", { name: "Jump to end", exact: true }).click();
  await expect(
    view.getByText("Preparing the end of the transcript…"),
  ).toBeVisible();
  await page.evaluate(() => (window as any).invalidateTranscript());
  await expect(view.getByText("Couldn’t load the transcript")).toBeVisible();
  await expect(view.getByText(/Revocable session text/)).toHaveCount(0);
  await expect(
    view.getByRole("button", { name: "Download session" }),
  ).toHaveCount(0);
  expect(
    await page.evaluate(() => (window as any).staleJumpExecuted),
  ).toBeUndefined();
});
