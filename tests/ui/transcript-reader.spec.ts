import { expect, test, type Page } from "@playwright/test";
import { detailGalleryFixture } from "./fixtures/detail-gallery.js";

async function checkPrependAnchor(
  page: Page,
  atHeader: boolean,
  records = 3800,
) {
  const view = await detailGalleryFixture(page, { kind: "session" });
  await page.evaluate((records) => {
    const w = window as any;
    const invoke = w.__TAURI_INTERNALS__.invoke;
    const transcript =
      "Synthetic transcript begins\n" +
      Array.from(
        { length: records },
        (_, i) => `Record ${i} ${"with more text ".repeat((i % 7) + 1)}\n`,
      ).join("") +
      "Exact last line";
    w.__TAURI_INTERNALS__.invoke = async (command: string, request: any) => {
      if (command !== "read_transcript") return invoke(command, request);
      if (request.before) {
        w.prependOffset = request.offset;
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
  }, records);
  await view.getByRole("button", { name: "Transcript", exact: true }).click();
  const text = view.getByRole("region", { name: "Transcript text" });
  await expect(text).toContainText("Synthetic transcript begins");
  await text.focus();
  await text.press("End");
  await expect(text).toContainText("Exact last line");
  await expect(text).toBeFocused();
  await expect(text).not.toContainText("Synthetic transcript begins");

  const scroller = view.locator(".detail-reader");
  await scroller.evaluate((reader, atHeader) => {
    if (atHeader) {
      reader.scrollTop = 0;
      return;
    }
    const blocks = reader.querySelector(".transcript-blocks")!;
    reader.scrollTop +=
      blocks.getBoundingClientRect().top -
      reader.getBoundingClientRect().top -
      40;
  }, atHeader);
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
      scroller.evaluate((reader) =>
        Array.from(
          reader.querySelectorAll<HTMLElement>(
            ".transcript-block[data-offset]",
          ),
        ).some(
          (block) =>
            Number(block.dataset.offset) < (window as any).prependOffset,
        ),
      ),
    )
    .toBe(true);
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
}

for (const atHeader of [false, true])
  test(`keeps the visible transcript offset on a backward scroll to the ${atHeader ? "header" : "text"}`, async ({
    page,
  }) => {
    await checkPrependAnchor(page, atHeader);
  });

test("preserves the top anchor when the preceding range reaches the first record", async ({
  page,
}) => {
  await checkPrependAnchor(page, true, 350);
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

test("reaches EOF through a dense transcript while keeping scroll geometry bounded", async ({
  page,
}) => {
  const view = await detailGalleryFixture(page, { kind: "session" });
  await page.evaluate(() => {
    const w = window as any;
    const invoke = w.__TAURI_INTERNALS__.invoke;
    const transcript =
      "Dense file begins\n" + "x\n".repeat(110_000) + "Dense file ends";
    w.__TAURI_INTERNALS__.invoke = (command: string, request: any) => {
      if (command !== "read_transcript") return invoke(command, request);
      const offset = request.offset;
      const nextOffset = Math.min(transcript.length, offset + request.maxBytes);
      return Promise.resolve({
        offset,
        nextOffset,
        text: transcript.slice(offset, nextOffset),
        eof: nextOffset === transcript.length,
      });
    };
  });
  await view.getByRole("button", { name: "Transcript", exact: true }).click();
  const content = view.locator(".transcript-blocks");
  await expect(content).toContainText("Dense file begins");
  const reader = view.locator(".detail-reader");
  let maxHeight = 0;
  await expect
    .poll(
      async () => {
        const current = await reader.evaluate((element) => {
          element.scrollTop = element.scrollHeight;
          return {
            height: element.scrollHeight,
            atEnd: element.textContent?.includes("Dense file ends"),
          };
        });
        maxHeight = Math.max(maxHeight, current.height);
        return current.atEnd;
      },
      { intervals: [60], timeout: 12000 },
    )
    .toBe(true);
  expect(maxHeight).toBeLessThan(1_650_000);
  await expect(content.getByText(/Dense file ends/)).toBeInViewport();
  await expect(content).not.toContainText("Dense file begins");
});

for (const cached of ["start", "end"] as const)
  test(`honors a jump to the cached ${cached} after a slow opposite jump`, async ({
    page,
  }) => {
    const view = await detailGalleryFixture(page, { kind: "session" });
    await page.evaluate(() => {
      const w = window as any;
      const invoke = w.__TAURI_INTERNALS__.invoke;
      const text =
        "First record\n" + "Next record.\n".repeat(12000) + "Last record";
      w.__TAURI_INTERNALS__.invoke = async (name: string, args: any) => {
        if (name !== "read_transcript") return invoke(name, args);
        if (w.holdNextJump && (args.offset === null || args.offset === 0)) {
          w.holdNextJump = false;
          await new Promise<void>((resolve) => {
            w.finishJump = resolve;
          });
        }
        const backward = args.before || args.offset === null;
        const position = args.offset ?? text.length;
        const offset = backward
          ? Math.max(0, position - args.maxBytes)
          : position;
        const nextOffset = backward
          ? position
          : Math.min(text.length, position + args.maxBytes);
        return {
          offset,
          nextOffset,
          text: text.slice(offset, nextOffset),
          eof: nextOffset === text.length,
        };
      };
    });
    await view.getByRole("button", { name: "Transcript", exact: true }).click();
    const region = view.getByRole("region", { name: "Transcript text" });
    await expect(region).toContainText("First record");
    await region.focus();
    if (cached === "end") {
      await region.press("End");
      await expect(region).toContainText("Last record");
    }
    await page.evaluate(() => {
      (window as any).holdNextJump = true;
    });
    await region.press(cached === "end" ? "Home" : "End");
    await expect
      .poll(() => page.evaluate(() => typeof (window as any).finishJump))
      .toBe("function");
    await region.press(cached === "end" ? "End" : "Home");
    const endpoint =
      cached === "end" ? "End of transcript" : "Start of transcript";
    await expect(region.getByRole("status")).toHaveText(endpoint);
    await page.evaluate(async () => {
      (window as any).finishJump();
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      );
    });
    await expect(region.getByRole("status")).toHaveText(endpoint);
    await expect(region).toContainText(
      cached === "end" ? "Last record" : "First record",
    );
  });

for (const [width, height] of [
  [1160, 800],
  [900, 640],
])
  test(`offers a visible retry at a failed forward edge at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height });
    const view = await detailGalleryFixture(page, { kind: "session" });
    await page.evaluate(() => {
      const w = window as any,
        invoke = w.__TAURI_INTERNALS__.invoke;
      let opened = 0;
      w.__TAURI_INTERNALS__.invoke = async (name: string, args: any) => {
        if (name === "open_transcript") opened++;
        if (name !== "read_transcript") return invoke(name, args);
        if (args.offset) throw "Read failed.";
        const recovered = opened > 1;
        const text = recovered
          ? "Transcript reopened"
          : "First record\n".repeat(1800).slice(0, args.maxBytes);
        return { offset: 0, nextOffset: text.length, text, eof: recovered };
      };
    });
    await view.getByRole("button", { name: "Transcript", exact: true }).click();
    const region = view.getByRole("region", { name: "Transcript text" });
    await expect(region).toContainText("First record");
    await view
      .locator(".detail-reader")
      .evaluate((el) => (el.scrollTop = el.scrollHeight));
    const retry = region.getByRole("button", { name: "Retry" });
    await expect(retry).toHaveCount(1);
    await expect(retry).toBeInViewport({ ratio: 1 });
    await expect(region.getByRole("alert")).toContainText(
      "Couldn’t load more of the transcript.",
    );
    await retry.click();
    await expect(region).toContainText("Transcript reopened");
    await expect(retry).toHaveCount(0);
  });
