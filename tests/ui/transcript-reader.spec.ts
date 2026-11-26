import { expect, test, type Locator, type Page } from "@playwright/test";
import { detailGalleryFixture } from "./fixtures/detail-gallery.js";

async function expectSkeletonLines(area: Locator) {
  const lines = area.locator(".transcript-skeleton-line");
  await expect(lines.first()).toBeInViewport();
  await expect(lines.first()).not.toHaveCSS(
    "background-color",
    "rgba(0, 0, 0, 0)",
  );
  await expect(lines.nth(1)).toBeVisible();
}

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
        w.prependCount = (w.prependCount ?? 0) + 1;
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
      if (request.before) w.previousPageStart = offset;
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

  const pendingEdge = text.locator(
    '[data-transcript-edge="before"][aria-busy="true"]',
  );
  if (atHeader) {
    await scroller.evaluate((reader) => {
      reader.scrollTop = 0;
    });
    await expectSkeletonLines(pendingEdge);
    await expect(
      text.locator(".transcript-block pre").first(),
    ).toBeInViewport();
  }

  const before = await scroller.evaluate((reader, atHeader) => {
    const viewport = reader.getBoundingClientRect();
    const blocks = Array.from(
      reader.querySelectorAll<HTMLElement>(".transcript-block[data-offset]"),
    );
    const stable = atHeader
      ? reader.querySelector<HTMLElement>(".detail-title-card")!
      : blocks.find(
          (block) => block.getBoundingClientRect().bottom > viewport.top + 100,
        )!;
    return {
      selector: atHeader
        ? ".detail-title-card"
        : `.transcript-block[data-offset="${stable.dataset.offset}"]`,
      top: stable.getBoundingClientRect().top - viewport.top,
    };
  }, atHeader);
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
      scroller.evaluate((reader, { selector, top }) => {
        const block = reader.querySelector(selector);
        if (!block) return Infinity;
        const actualTop =
          block.getBoundingClientRect().top -
          reader.getBoundingClientRect().top;
        return Math.abs(actualTop - top);
      }, before),
    )
    .toBeLessThanOrEqual(atHeader ? 1 : 24);
  if (atHeader) {
    await expect(pendingEdge).toHaveCount(0);
    await expect(scroller.locator(".detail-title-card")).toBeInViewport();
    const start = await page.evaluate(() => (window as any).previousPageStart);
    await expect(
      text.locator(`.transcript-block[data-offset="${start}"]`),
    ).toBeInViewport();
    expect(await page.evaluate(() => (window as any).prependCount)).toBe(1);
  }
  await expect(text).toBeFocused();
}

test("keeps the visible transcript offset when preceding text arrives", async ({
  page,
}) => {
  await checkPrependAnchor(page, false);
});

test("keeps the visible header stationary while exposing the previous page", async ({
  page,
}) => {
  await checkPrependAnchor(page, true);
});

test("preserves the header when the preceding range reaches the first record", async ({
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

async function openAtForwardEdge(page: Page) {
  const view = await detailGalleryFixture(page, { kind: "session" });
  await page.evaluate(() => {
    const w = window as any;
    const invoke = w.__TAURI_INTERNALS__.invoke;
    let opened = 0;
    let failedReader = false;
    w.__TAURI_INTERNALS__.invoke = async (name: string, args: any) => {
      if (name === "open_transcript") opened++;
      if (name !== "read_transcript") return invoke(name, args);
      if (opened > 1) {
        const text = "Transcript reopened";
        return { offset: 0, nextOffset: text.length, text, eof: true };
      }
      if (failedReader) {
        w.readClosedTranscript = true;
        throw "transcript_snapshot_invalidated";
      }
      if (args.offset === 0) {
        const tail = "\nFinal loaded record";
        const text =
          "Already loaded record.\n"
            .repeat(1000)
            .slice(0, args.maxBytes - tail.length) + tail;
        return { offset: 0, nextOffset: text.length, text, eof: false };
      }
      await new Promise<void>((resolve, reject) => {
        w.finishEdge = (succeed: boolean) => {
          if (succeed) resolve();
          else {
            failedReader = true;
            reject("Read failed.");
          }
        };
      });
      const text = "\nNewly arrived record";
      return {
        offset: args.offset,
        nextOffset: args.offset + text.length,
        text,
        eof: true,
      };
    };
  });
  await view.getByRole("button", { name: "Transcript", exact: true }).click();
  const region = view.getByRole("region", { name: "Transcript text" });
  await expect(region).toContainText("Already loaded record.");
  const scroller = view.locator(".detail-reader");
  await scroller.evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  await expect
    .poll(() => page.evaluate(() => typeof (window as any).finishEdge))
    .toBe("function");
  // The boundary can be prefetched before it is visible. Move to the unread edge.
  await scroller.evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  const pending = region.locator(
    '[data-transcript-edge="after"][aria-busy="true"]',
  );
  await expectSkeletonLines(pending);
  const previous = region
    .locator(".transcript-block")
    .filter({ hasText: "Final loaded record" });
  await expect(previous).toBeInViewport();
  for (const label of ["Download session", "Jump to start", "Jump to end"]) {
    const action = region.getByRole("button", { name: label, exact: true });
    await expect(action).toBeAttached();
    await expect(action).not.toBeInViewport();
  }
  return { region, previous, pending };
}

for (const [width, height] of [
  [1160, 800],
  [900, 640],
]) {
  test(`appends the next page after a visible forward skeleton at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height });
    const { region, pending, previous } = await openAtForwardEdge(page);
    await page.evaluate(() => (window as any).finishEdge(true));
    await expect(pending).toHaveCount(0);
    await expect(previous).toBeInViewport();
    await expect(
      region.getByText("Newly arrived record", { exact: true }),
    ).toBeInViewport();
  });

  test(`offers an inline retry at the failed forward edge at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height });
    const { region, previous, pending } = await openAtForwardEdge(page);
    await page.evaluate(() => (window as any).finishEdge(false));
    await expect(pending).toHaveCount(0);
    const alert = region.getByRole("alert");
    await expect(alert).toContainText("Couldn’t load more of the transcript.");
    const retry = region
      .locator('[data-transcript-edge="after"]')
      .getByRole("button", { name: "Retry", exact: true });
    await expect(retry).toBeInViewport({ ratio: 1 });
    await expect(previous).toBeInViewport();
    const last = await previous.boundingBox();
    const feedback = await alert.boundingBox();
    expect(feedback!.y).toBeGreaterThanOrEqual(last!.y + last!.height - 1);
    await expect(
      region.getByRole("button", { name: "Download session", exact: true }),
    ).not.toBeInViewport();
    await retry.click();
    await expect(region).toContainText("Transcript reopened");
    await expect(retry).toHaveCount(0);
  });
}

test("a failed range cancels a jump waiting on its closed reader", async ({
  page,
}) => {
  const { region, previous } = await openAtForwardEdge(page);
  await region.evaluate((element) => element.focus({ preventScroll: true }));
  await page.keyboard.press("End");
  await expect(region.getByRole("status")).toHaveText(
    "Preparing the end of the transcript…",
  );
  await page.evaluate(() => (window as any).finishEdge(false));
  await expect(region.getByRole("alert")).toContainText(
    "Couldn’t load more of the transcript.",
  );
  await expect(previous).toBeInViewport();
  await expect(region.getByRole("button", { name: "Retry" })).toBeInViewport();
  expect(
    await page.evaluate(() => (window as any).readClosedTranscript),
  ).toBeUndefined();
});

test("shows transcript lines while the initial read is pending", async ({
  page,
}) => {
  const view = await detailGalleryFixture(page, { kind: "session" });
  await page.evaluate(() => {
    const w = window as any;
    const invoke = w.__TAURI_INTERNALS__.invoke;
    w.__TAURI_INTERNALS__.invoke = async (name: string, args: any) => {
      if (name === "read_transcript") {
        await new Promise<void>((resolve) => {
          w.releaseFirstRead = resolve;
        });
      }
      return invoke(name, args);
    };
  });
  await view.getByRole("button", { name: "Transcript", exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => typeof (window as any).releaseFirstRead))
    .toBe("function");
  const region = view.getByRole("region", { name: "Transcript text" });
  const status = region.getByRole("status", { name: "Loading transcript…" });
  await expectSkeletonLines(status);
  await page.evaluate(() => (window as any).releaseFirstRead());
  await expect(status).toHaveCount(0);
  await expect(
    region.locator(".transcript-block pre").first(),
  ).toBeInViewport();
});

async function restoreEvictedPage(page: Page, succeeds: boolean) {
  const view = await detailGalleryFixture(page, { kind: "session" });
  await page.evaluate(() => {
    const w = window as any,
      invoke = w.__TAURI_INTERNALS__.invoke;
    const line =
      "Assistant: Verify the session transcript in compact and wide windows, then check the next page.\n";
    const transcript = "First restored record\n" + line.repeat(7000);
    let forwardEnd = 0;
    let released = false;
    w.__TAURI_INTERNALS__.invoke = async (name: string, args: any) => {
      if (name !== "read_transcript") return invoke(name, args);
      if (args.offset < forwardEnd && !released) {
        await new Promise<void>((resolve, reject) => {
          w.restorePage = (succeeds: boolean) => {
            released = true;
            if (succeeds) resolve();
            else reject("Could not restore this range.");
          };
        });
      }
      const nextOffset = Math.min(
        transcript.length,
        args.offset + args.maxBytes,
      );
      forwardEnd = Math.max(forwardEnd, nextOffset);
      w.reachedEnd = forwardEnd === transcript.length;
      return {
        offset: args.offset,
        nextOffset,
        text: transcript.slice(args.offset, nextOffset),
        eof: nextOffset === transcript.length,
      };
    };
  });
  await view.getByRole("button", { name: "Transcript", exact: true }).click();
  const region = view.getByRole("region", { name: "Transcript text" });
  await expect(region).toContainText("First restored record");
  const scroller = view.locator(".detail-reader");
  await expect
    .poll(
      () =>
        scroller.evaluate((el) => {
          el.scrollTop = el.scrollHeight;
          return (window as any).reachedEnd;
        }),
      { intervals: [35], timeout: 15000 },
    )
    .toBe(true);
  await scroller.evaluate((el) => {
    el.scrollTop = 0;
  });
  await expect
    .poll(() => page.evaluate(() => typeof (window as any).restorePage))
    .toBe("function");
  const firstBlock = region.locator('.transcript-block[data-offset="0"]');
  const placeholder = firstBlock.locator(".transcript-block-placeholder");
  await expectSkeletonLines(placeholder);
  const loading = region
    .getByRole("status")
    .filter({ hasText: "Loading transcript text…" });
  await expect(loading).toHaveCount(1);
  const originalHeight = await placeholder.evaluate(
    (el) => el.getBoundingClientRect().height,
  );
  await page.evaluate(
    (succeeds) => (window as any).restorePage(succeeds),
    succeeds,
  );
  await expect(loading).toHaveCount(0);
  if (!succeeds) {
    const alert = region.getByRole("alert");
    await expect(alert).toContainText("Couldn’t load more of the transcript.");
    await expect(placeholder.locator(".transcript-skeleton-line")).toHaveCount(
      0,
    );
    expect(
      await placeholder.evaluate((el) => el.getBoundingClientRect().height),
    ).toBe(originalHeight);
    const retry = alert.getByRole("button", { name: "Retry", exact: true });
    await expect(retry).toBeInViewport({ ratio: 1 });
    await retry.click();
    await expect(alert).toHaveCount(0);
  }
  await expect(firstBlock.locator("pre")).toContainText(
    "First restored record",
  );
  await expect(firstBlock.locator(".transcript-block-placeholder")).toHaveCount(
    0,
  );
}
test("replaces the placeholder with text after restoring an evicted page", async ({
  page,
}) => {
  await restoreEvictedPage(page, true);
});
test("stops the placeholder and offers retry when an evicted page fails", async ({
  page,
}) => {
  await restoreEvictedPage(page, false);
});
