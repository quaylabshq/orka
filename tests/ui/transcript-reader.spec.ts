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
