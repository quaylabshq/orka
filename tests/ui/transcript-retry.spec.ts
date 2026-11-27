import { expect, test, type Page } from "@playwright/test";
import { detailGalleryFixture } from "./fixtures/detail-gallery.js";

type Read = {
  readerId: string;
  offset: number | null;
  before: boolean;
  maxBytes: number;
};
type Snapshot = { snapshotHash: string; conflictId?: string | null };
const transcript = Array.from(
  { length: 2400 },
  (_, i) => `Record ${i} describes the next change to the session.\n`,
).join("");
function pageFor(request: Read, text = transcript) {
  const backward = request.before || request.offset === null;
  const position = request.offset ?? text.length;
  const offset = backward ? Math.max(0, position - request.maxBytes) : position;
  const nextOffset = backward
    ? position
    : Math.min(text.length, position + request.maxBytes);
  return {
    offset,
    nextOffset,
    text: text.slice(offset, nextOffset),
    eof: nextOffset === text.length,
  };
}
function gate() {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { pending, release };
}
async function session(
  page: Page,
  options: {
    incoming?: boolean;
    open?: (number: number) => Promise<Snapshot | null>;
    read: (request: Read) => Promise<ReturnType<typeof pageFor>>;
  },
) {
  const view = await detailGalleryFixture(page, {
    kind: "session",
    conflict: options.incoming,
  });
  const reads: Read[] = [];
  const closed: string[] = [];
  let opens = 0;
  await page.exposeFunction(
    "transcriptFixture",
    async (cmd: string, args: Read) => {
      try {
        if (cmd === "close_transcript") {
          closed.push(args.readerId);
          return { value: null };
        }
        if (cmd === "open_transcript") {
          const number = ++opens;
          const snapshot = options.open
            ? await options.open(number)
            : {
                snapshotHash: "first",
                conflictId: options.incoming ? "conflict-1" : null,
              };
          return {
            value: { readerId: `handle-${number}`, sessionSnapshot: snapshot },
          };
        }
        reads.push(args);
        return { value: await options.read(args) };
      } catch (error) {
        return { error: String(error) };
      }
    },
  );
  await page.evaluate(() => {
    const w = window as any,
      invoke = w.__TAURI_INTERNALS__.invoke;
    w.__TAURI_INTERNALS__.invoke = async (cmd: string, args: unknown) => {
      if (cmd === "plugin:dialog|save") return "/fixture/session.zip";
      if (cmd === "export_bundle") {
        w.transcriptExport = args;
        return;
      }
      if (
        !["open_transcript", "read_transcript", "close_transcript"].includes(
          cmd,
        )
      )
        return invoke(cmd, args);
      const result = await w.transcriptFixture(cmd, args);
      if (result.error) throw result.error;
      return result.value;
    };
  });
  if (options.incoming)
    await view.getByRole("button", { name: "View incoming version" }).click();
  await view.getByRole("button", { name: "Transcript", exact: true }).click();
  const region = view.getByRole("region", { name: "Transcript text" });
  return {
    view,
    region,
    scroller: view.locator(".detail-reader"),
    reads,
    closed,
  };
}

test("keeps the same record in view through a delayed reopen and repeated forward failures", async ({
  page,
}) => {
  const open = gate(),
    replay = gate();
  const { region, scroller, reads } = await session(page, {
    incoming: true,
    open: async (number) => {
      if (number === 2) await open.pending;
      return { snapshotHash: "incoming-v1", conflictId: "conflict-1" };
    },
    read: async (req) => {
      if (req.offset && req.readerId === "handle-1")
        throw "Temporary read failure";
      if (req.readerId === "handle-2") {
        await replay.pending;
        throw "Read still unavailable";
      }
      return pageFor(req);
    },
  });
  await expect(region).toContainText("Record 0");
  await scroller.evaluate((s) => {
    s.scrollTop = s.scrollHeight;
  });
  const retry = region.getByRole("button", { name: "Retry", exact: true });
  await expect(retry).toBeInViewport();
  const req = reads[reads.length - 1];
  expect(req.offset).toBeGreaterThan(0);
  const anchor = await region
    .locator(".transcript-block")
    .last()
    .evaluate((el) => ({
      offset: (el as HTMLElement).dataset.offset,
      top: el.getBoundingClientRect().top,
    }));
  const block = region.locator(`[data-offset="${anchor.offset}"]`);
  const unchanged = async () => {
    await expect(block).toBeInViewport();
    expect(
      Math.abs((await block.boundingBox())!.y - anchor.top),
    ).toBeLessThanOrEqual(1);
    await expect(
      region.getByRole("button", { name: "Download incoming version" }),
    ).toBeAttached();
  };
  await retry.click();
  await unchanged();
  await expect(region).toBeFocused();
  open.release();
  await expect
    .poll(() => reads[reads.length - 1])
    .toEqual({ ...req, readerId: "handle-2" });
  await unchanged();
  replay.release();
  await expect(retry).toBeInViewport();
  await retry.click();
  await expect
    .poll(() => reads.find((read) => read.readerId === "handle-3"))
    .toEqual({ ...req, readerId: "handle-3" });
  await expect(
    region.locator(`[data-offset="${req.offset}"] pre`),
  ).toBeAttached();
  await unchanged();
  await region
    .getByRole("button", { name: "Download incoming version", exact: true })
    .click();
  await expect
    .poll(() =>
      page.evaluate(() => (window as any).transcriptExport?.sessionSnapshot),
    )
    .toEqual({
      conflictId: "conflict-1",
      snapshotHash: "incoming-v1",
    });
});

for (const direction of ["before", "start", "end"] as const)
  test(`replays the failed ${direction} request on a replacement handle`, async ({
    page,
  }) => {
    let shouldFail = false;
    const { region, scroller, reads } = await session(page, {
      read: async (req) => {
        if (
          shouldFail &&
          req.readerId === "handle-1" &&
          (direction === "before"
            ? req.before
            : req.offset === (direction === "end" ? null : 0))
        )
          throw "Temporary read failure";
        return pageFor(req);
      },
    });
    await expect(region).toContainText("Record 0");
    await region.focus();
    if (direction !== "end") {
      await region.press("End");
      await expect(region).toContainText("Record 2399");
    }
    shouldFail = true;
    if (direction === "before")
      await scroller.evaluate((s) => {
        s.scrollTop = 0;
      });
    else await region.press(direction === "end" ? "End" : "Home");
    const retry = region.getByRole("button", { name: "Retry", exact: true });
    await expect(retry).toBeVisible();
    const failed = reads[reads.length - 1];
    await retry.click();
    await expect
      .poll(() => reads.find((r) => r.readerId === "handle-2"))
      .toEqual({ ...failed, readerId: "handle-2" });
    await expect(retry).toHaveCount(0);
    if (direction === "before")
      await expect(
        region.locator(`[data-offset="${pageFor(failed).offset}"]`),
      ).toBeInViewport();
    else
      await expect(region).toContainText(
        direction === "end" ? "Record 2399" : "Record 0",
      );
    await expect(region).toBeFocused();
  });

for (const identity of ["changed", "unknown"] as const)
  test(`starts at byte zero when the reopened snapshot is ${identity}`, async ({
    page,
  }) => {
    const firstNew = gate();
    const { region, scroller, reads } = await session(page, {
      open: async (number) =>
        number === 1
          ? { snapshotHash: "old" }
          : identity === "changed"
            ? { snapshotHash: "new" }
            : null,
      read: async (req) => {
        if (req.readerId === "handle-2") {
          await firstNew.pending;
          return pageFor(req, "New snapshot text");
        }
        if (req.offset) throw "Read failed";
        return pageFor(req);
      },
    });
    await expect(region).toContainText("Record 0");
    await scroller.evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    await region.getByRole("button", { name: "Retry", exact: true }).click();
    await expect
      .poll(() => reads.find((r) => r.readerId === "handle-2")?.offset)
      .toBe(0);
    await expect(region.locator(".transcript-block pre")).toHaveCount(0);
    firstNew.release();
    await expect(region).toContainText("New snapshot text");
    await expect.poll(() => scroller.evaluate((el) => el.scrollTop)).toBe(0);
  });

for (const failure of ["invalidated range", "denied reopen"] as const)
  test(`discards the old transcript on ${failure} even when access is later restored`, async ({
    page,
  }) => {
    const { view, region, scroller, reads } = await session(page, {
      open: async (n) => {
        if (failure === "denied reopen" && n === 2) throw "Access unavailable";
        return { snapshotHash: "original" };
      },
      read: async (req) => {
        if (req.readerId === "handle-1" && req.offset) {
          throw failure === "invalidated range"
            ? "transcript_snapshot_invalidated"
            : "Temporary read failure";
        }
        return pageFor(req);
      },
    });
    await expect(region).toContainText("Record 0");
    await scroller.evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    if (failure === "denied reopen")
      await region.getByRole("button", { name: "Retry", exact: true }).click();
    await expect(
      view.getByText("Couldn’t load the transcript", { exact: true }),
    ).toBeVisible();
    await expect(view.locator(".transcript-block pre")).toHaveCount(0);
    const retry = view.getByRole("button", { name: "Retry", exact: true });
    if (failure === "denied reopen") await expect(retry).toBeFocused();
    await retry.click();
    const recovered = failure === "denied reopen" ? "handle-3" : "handle-2";
    await expect
      .poll(() => reads.find((r) => r.readerId === recovered)?.offset)
      .toBe(0);
    await expect(region).toContainText("Record 0");
  });

for (const stage of ["open", "read"] as const)
  test(`closes a recovery handle after leaving during its ${stage}`, async ({
    page,
  }) => {
    const held = gate(),
      entered = gate();
    const { view, region, scroller, reads, closed } = await session(page, {
      open: async (n) => {
        if (n === 2 && stage === "open") {
          entered.release();
          await held.pending;
        }
        return { snapshotHash: n === 3 ? "new" : "old" };
      },
      read: async (req) => {
        if (req.readerId === "handle-3")
          return pageFor(req, "Newly selected content");
        if (req.readerId === "handle-2") {
          entered.release();
          await held.pending;
        }
        if (req.readerId === "handle-1" && req.offset) throw "Read failed";
        return pageFor(req);
      },
    });
    await expect(region).toContainText("Record 0");
    await scroller.evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    await region.getByRole("button", { name: "Retry", exact: true }).click();
    await entered.pending;
    await view
      .getByRole("button", { name: "Conversation", exact: true })
      .click();
    await view.getByRole("button", { name: "Transcript", exact: true }).click();
    await expect(region).toContainText("Newly selected content");
    held.release();
    await expect.poll(() => closed).toContain("handle-2");
    expect(reads.filter((r) => r.readerId === "handle-2")).toHaveLength(
      stage === "open" ? 0 : 1,
    );
    await expect(region).not.toContainText("Record 0");
  });
