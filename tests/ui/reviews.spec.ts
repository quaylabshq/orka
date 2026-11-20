import { AxeBuilder } from "@axe-core/playwright";
import { test, expect, type Page } from "@playwright/test";
import {
  compact,
  day,
  draft,
  mixed,
  open,
  req,
  shared,
  shot,
  type Scene,
} from "./fixtures/reviews-scene.js";

// The Reviews tab: its list, the review page and the access dialog. Each test
// asserts behavior and saves a capture for design review. Synthetic data only.
const items = [
  shared("res-m1", "memory", "Desktop interaction guidelines"),
  shared("res-p1", "plan", "Onboarding rollout plan", "backend"),
];
const start = async (page: Page, scene: Scene, viewport?: typeof compact) => {
  await page.clock.setFixedTime(new Date("2026-11-20T10:30:00Z"));
  await open(page, { resources: items, ...scene }, viewport);
};
const reviews = (page: Page) =>
  page.getByRole("region", { name: "Reviews", exact: true });
const toReviews = async (page: Page) => {
  await page.getByRole("button", { name: /^Reviews/ }).click();
  await expect(reviews(page)).toBeVisible();
};
const owner: Scene = {
  requests: [
    ...mixed,
    req("h1", "Sync retry guidance", { status: "approved", createdAt: day(6) }),
    req("h2", "Old deploy notes", { status: "rejected", createdAt: day(8) }),
    req("h3", "Naming conventions", { status: "stale", createdAt: day(9) }),
  ],
  bindings: "update",
  drafts: [draft("d1", "Saved learning", "local")],
};
const twelve = [
  ...mixed,
  ...[
    "code-review",
    "Sync retry guidance",
    "pr-polish",
    "Settings migration plan",
    "Naming conventions",
    "Access to Skills",
    "issue-investigate",
    "Release notes voice",
  ].map((title, index) =>
    req(`x${index}`, title, {
      author: ["mira", "ana", "jon"][index % 3],
      createdAt: day(index + 1),
      ...(title.startsWith("Access")
        ? { type: "access", requestedMode: "suggest", requestedClass: "skill" }
        : {}),
    }),
  ),
];

test("01 owner, four to decide", async ({ page }) => {
  await start(page, owner);
  await toReviews(page);
  await expect(reviews(page).getByRole("row")).toHaveCount(8);
  await shot(
    page,
    "01-open-owner",
    "Owner with four requests and two local changes.",
  );
});
test("02 nothing to decide", async ({ page }) => {
  await start(page, {
    bindings: "update",
    drafts: [draft("d1", "Saved learning", "local")],
  });
  await toReviews(page);
  await expect(
    reviews(page).getByRole("region", { name: /^To decide/ }),
  ).toHaveCount(0);
  await expect(
    reviews(page).getByRole("region", { name: "On this Mac 2" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Reviews", exact: true }),
  ).toBeVisible();
  await shot(
    page,
    "02-open-local-only",
    "To decide is hidden. No count in the sidebar.",
  );
});
test("03 all clear", async ({ page }) => {
  await start(page, {});
  await toReviews(page);
  await expect(reviews(page).getByText("Nothing to review")).toBeVisible();
  await shot(
    page,
    "03-open-clear",
    "No sections. One line and an illustration.",
  );
});
test("05 twelve to decide", async ({ page }) => {
  await start(page, { ...owner, requests: twelve });
  await toReviews(page);
  await shot(
    page,
    "05-open-twelve",
    "All show, newest first. The list fades at the bottom.",
  );
  await reviews(page)
    .locator(".reviews-scroll")
    .evaluate((node) => {
      node.scrollTop = node.scrollHeight;
    });
  await shot(
    page,
    "06-open-twelve-end",
    "Scrolled to the end. The fade moves to the top.",
  );
});
test("07 member, sent by you", async ({ page }) => {
  await start(page, {
    role: "member",
    requests: [
      req("m1", "Desktop interaction guidelines", { canReview: false }),
      req("p1", "Onboarding rollout plan", {
        canReview: false,
        createdAt: day(3),
      }),
    ],
    drafts: [draft("d1", "Saved learning", "local")],
  });
  await toReviews(page);
  await expect(
    reviews(page).getByRole("region", { name: "Sent by you 2" }),
  ).toContainText("Awaiting approval");
  await expect(
    reviews(page).getByRole("region", { name: /^To decide/ }),
  ).toHaveCount(0);
  await shot(
    page,
    "07-open-member",
    "Member. Their requests sit under Sent by you with a status.",
  );
});
test("11 on this Mac statuses", async ({ page }) => {
  await start(page, {
    bindings: "modified",
    drafts: [
      draft("d1", "Saved learning", "local"),
      draft("d2", "Sync retry guidance", "stale"),
    ],
  });
  await toReviews(page);
  await shot(
    page,
    "11-open-local-statuses",
    "Update blocked, Local edits, Needs refresh.",
  );
});
test("12 row hover", async ({ page }) => {
  await start(page, owner);
  await toReviews(page);
  await reviews(page)
    .getByRole("row", { name: /Desktop interaction/ })
    .hover();
  await shot(page, "12-open-row-hover", "The whole row is the target.");
});
test("13 history", async ({ page }) => {
  await start(page, owner);
  await toReviews(page);
  await reviews(page).getByRole("button", { name: "History" }).click();
  await expect(reviews(page).getByRole("row")).toHaveCount(4);
  await shot(
    page,
    "13-history",
    "Decided requests only, with an outcome pill.",
  );
});
test("14 history, empty", async ({ page }) => {
  await start(page, { requests: mixed });
  await toReviews(page);
  await reviews(page).getByRole("button", { name: "History" }).click();
  await expect(reviews(page).getByText("No decisions yet")).toBeVisible();
  await shot(page, "14-history-empty", "Nothing decided yet.");
});
test("15 loading", async ({ page }) => {
  await start(page, { ...owner, holdCatalog: true });
  await toReviews(page);
  await shot(page, "15-loading", "Rows hold their shape.");
});
test("16 failed to load", async ({ page }) => {
  await start(page, { ...owner, failCatalog: true });
  await toReviews(page);
  await expect(reviews(page).getByText("Couldn’t load reviews")).toBeVisible();
  await shot(page, "16-load-failed", "One line and Retry.");
});
test("17 smallest window", async ({ page }) => {
  await start(page, owner, compact);
  await toReviews(page);
  await shot(
    page,
    "17-open-900",
    "Repository is dropped at the minimum width.",
  );
  await reviews(page).getByRole("button", { name: "History" }).click();
  await shot(page, "25-history-900", "Repository and From are dropped.");
});
test("18 missing content", async ({ page }) => {
  await start(page, {
    requests: [
      req("u1", "", { author: "gone" }),
      req("a2", "Resource access request", { type: "access", author: "ana" }),
      req("m1", "Desktop interaction guidelines", { author: "jon" }),
    ],
    longNames: true,
  });
  await toReviews(page);
  await shot(
    page,
    "18-open-missing",
    "Untitled, Former member, and an access request with no level.",
  );
});
test("20 long titles at the smallest window", async ({ page }) => {
  const long =
    "Notes from the permissions migration covering every role, every category, and the exceptions kept for existing members";
  await start(
    page,
    {
      requests: [req("m1", long, { author: "jon" }), ...mixed.slice(0, 2)],
      bindings: "update",
      drafts: [draft("d1", long, "stale")],
      longNames: true,
    },
    compact,
  );
  await toReviews(page);
  await shot(page, "20-open-long-900", "Long names end in an ellipsis.");
});
test("40 entry: settings button lands on Reviews", async ({ page }) => {
  await start(page, owner);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Members", exact: true }).click();
  await page.getByRole("button", { name: /Review pending requests/ }).click();
  await expect(reviews(page)).toBeVisible();
  await shot(
    page,
    "40-entry-settings",
    "The old Settings button now opens the Reviews tab.",
  );
});
test("41 no tab without permissions", async ({ page }) => {
  await start(page, { governed: false });
  await expect(
    page.getByRole("button", { name: /^Plans/ }).first(),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: /^Reviews/ })).toHaveCount(0);
  await shot(page, "41-no-permissions", "Permissions off: no Reviews tab.");
});
test("42 permissions off still reaches setup", async ({ page }) => {
  await start(page, { governed: false, requests: mixed });
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Members", exact: true }).click();
  await page
    .getByRole("button", { name: /Review pending requests|View requests/ })
    .click();
  await expect(
    reviews(page).getByRole("region", { name: "Enable project permissions" }),
  ).toBeVisible();
  await shot(
    page,
    "42-permissions-setup",
    "Permissions off: the old route still shows the setup card.",
  );
});

// ---------- The review page and the access dialog ----------
const flag = (page: Page, flags: Record<string, boolean>) =>
  page.evaluate((flags) => Object.assign(window, flags), flags);
const openRow = async (page: Page, name: RegExp | string) => {
  await reviews(page).getByRole("row", { name }).first().click();
};
const detail = (page: Page) =>
  page.getByRole("region", { name: "Review details", exact: true });
const info = (page: Page) =>
  page.getByRole("complementary", { name: "Review information" });
const accessDialog = (page: Page) => page.getByRole("dialog");

test("R01 skill change", async ({ page }) => {
  await start(page, { ...owner, detail: "skill" });
  await toReviews(page);
  await openRow(page, /release-checklist/);
  await expect(
    detail(page).getByRole("button", { name: "Approve" }),
  ).toBeEnabled();
  await expect(
    page.getByRole("button", { name: "Back to Reviews" }),
  ).toBeVisible();
  await expect(
    page.getByRole("navigation", { name: "Requests" }),
  ).toContainText("1 of 3");
  await shot(
    page,
    "R01-skill-change",
    "The change beside who asked and the decision.",
  );
});
test("R02 new memory", async ({ page }) => {
  await start(page, { ...owner, detail: "memory" });
  await toReviews(page);
  await openRow(page, /Desktop interaction/);
  await expect(info(page)).toContainText("Topic");
  await shot(
    page,
    "R02-new-memory",
    "Topic and scope are rows in the details panel.",
  );
});
test("R03 removal", async ({ page }) => {
  await start(page, { ...owner, detail: "deleted" });
  await toReviews(page);
  await openRow(page, /release-checklist/);
  await expect(
    detail(page).getByText("Removal", { exact: true }),
  ).toBeVisible();
  await shot(page, "R03-removal", "A red Removal pill above the name.");
});
test("R04 access request", async ({ page }) => {
  await start(page, owner);
  await toReviews(page);
  await openRow(page, /Access to Sessions/);
  await expect(accessDialog(page)).toContainText("Approve access to Sessions?");
  await shot(page, "R04-access-request", "A small dialog over the list.");
});
test("R05 long change", async ({ page }) => {
  await start(page, { ...owner, detail: "long" });
  await toReviews(page);
  await openRow(page, /release-checklist/);
  await expect(
    detail(page).getByRole("button", { name: "Approve" }),
  ).toBeEnabled();
  await shot(
    page,
    "R05-long-change",
    "The page scrolls; the details stay put.",
  );
});
test("R06 several files, one without a preview", async ({ page }) => {
  await start(page, { ...owner, detail: "binary" });
  await toReviews(page);
  await openRow(page, /release-checklist/);
  await expect(
    detail(page).getByRole("button", { name: "Approve" }),
  ).toBeEnabled();
  await shot(
    page,
    "R06a-files-first",
    "One file at a time, chosen from Files.",
  );
  await info(page).getByRole("listitem").nth(1).getByRole("button").click();
  await expect(
    detail(page).getByText("No text preview for this file."),
  ).toBeVisible();
  await shot(
    page,
    "R06-file-no-preview",
    "The second file has no text to show.",
  );
});
test("R07 loading", async ({ page }) => {
  await start(page, { ...owner, detail: "skill" });
  await toReviews(page);
  await flag(page, { holdRequestLoad: true });
  await openRow(page, /release-checklist/);
  await expect(
    detail(page).getByRole("heading", { name: "release-checklist" }),
  ).toBeVisible();
  await shot(
    page,
    "R07-loading",
    "The name is known. The rest holds its shape.",
  );
});
test("R08 failed to load", async ({ page }) => {
  await start(page, { ...owner, detail: "skill" });
  await toReviews(page);
  await flag(page, { requestLoadFailure: true });
  await openRow(page, /release-checklist/);
  await expect(
    detail(page).getByText("Couldn’t load this request"),
  ).toBeVisible();
  await shot(page, "R08-load-failed", "One line and Retry.");
  await flag(page, { requestLoadFailure: false });
  await detail(page).getByRole("button", { name: "Retry" }).click();
  await expect(
    detail(page).getByRole("button", { name: "Approve" }),
  ).toBeEnabled();
});
test("R09 deciding", async ({ page }) => {
  await start(page, { ...owner, detail: "skill" });
  await toReviews(page);
  await openRow(page, /release-checklist/);
  await flag(page, { holdRequestDecision: true });
  await detail(page).getByRole("button", { name: "Approve" }).click();
  await expect(
    detail(page).getByRole("button", { name: "Reject" }),
  ).toBeDisabled();
  await expect(
    detail(page).getByRole("button", { name: "Approve" }),
  ).toHaveAttribute("aria-busy", "true");
  await shot(page, "R09-deciding", "Approve shows progress. Reject is locked.");
});
test("R10 decision failed", async ({ page }) => {
  await start(page, { ...owner, detail: "skill" });
  await toReviews(page);
  await openRow(page, /release-checklist/);
  await flag(page, { decideFail: true });
  await detail(page).getByRole("button", { name: "Approve" }).click();
  await expect(info(page)).toContainText("Not sent");
  await expect(
    detail(page).getByRole("button", { name: "Approve" }),
  ).toBeEnabled();
  await shot(
    page,
    "R10-decision-failed",
    "Status reads Not sent. The buttons work again.",
  );
});
const memberScene: Scene = {
  role: "member",
  detail: "memory",
  requests: [
    req("m1", "Desktop interaction guidelines", { canReview: false }),
    req("p1", "Onboarding rollout plan", {
      canReview: false,
      createdAt: day(3),
    }),
  ],
};
test("R12 member, own request", async ({ page }) => {
  await start(page, memberScene);
  await toReviews(page);
  await openRow(page, /Desktop interaction/);
  await expect(info(page)).toContainText("Awaiting approval");
  await expect(
    detail(page).getByRole("button", { name: "Approve" }),
  ).toHaveCount(0);
  await shot(page, "R12-member-own", "Read only, with its status.");
});
test("R13 decided, from History", async ({ page }) => {
  await start(page, {
    ...owner,
    detail: "skill",
    requests: [
      ...mixed,
      req("h1", "Sync retry guidance", {
        status: "approved",
        createdAt: day(6),
        reviewer: "owner",
      }),
    ],
  });
  await toReviews(page);
  await reviews(page).getByRole("button", { name: "History" }).click();
  await openRow(page, /Sync retry guidance/);
  await expect(info(page)).toContainText("Approved");
  await expect(info(page)).toContainText("Decided by");
  await shot(
    page,
    "R13-decided",
    "No actions. The outcome and who decided it.",
  );
  await page.getByRole("button", { name: "Back to Reviews" }).click();
  await expect(
    reviews(page).getByRole("button", { name: "History" }),
  ).toHaveAttribute("aria-pressed", "true");
});
test("R14 smallest window", async ({ page }) => {
  await start(page, { ...owner, detail: "multi" }, compact);
  await toReviews(page);
  await openRow(page, /release-checklist/);
  await expect(
    detail(page).getByRole("button", { name: "Approve" }),
  ).toBeEnabled();
  await expect(detail(page)).toHaveAttribute("data-layout", "compact");
  await expect(
    detail(page).getByRole("button", { name: /^Files, 3$/ }),
  ).toBeVisible();
  await shot(
    page,
    "R14-900",
    "One column. Details become one line, files a count.",
  );
});
test("R15 after approving, the next opens", async ({ page }) => {
  await start(page, { ...owner, detail: "memory" });
  await toReviews(page);
  await openRow(page, /release-checklist/);
  await detail(page).getByRole("button", { name: "Approve" }).click();
  await expect(
    detail(page).getByRole("heading", { level: 2 }).first(),
  ).toContainText("Desktop interaction guidelines");
  await expect(
    page.getByRole("navigation", { name: "Requests" }),
  ).toContainText("1 of 2");
  await expect(page.getByText("Approved release-checklist")).toBeVisible();
  await shot(
    page,
    "R15-next-opens",
    "A toast confirms. The count drops by one.",
  );
});
test("R16 decision went stale", async ({ page }) => {
  await start(page, { ...owner, detail: "skill" });
  await toReviews(page);
  await openRow(page, /release-checklist/);
  await flag(page, { decideStale: true });
  await detail(page).getByRole("button", { name: "Approve" }).click();
  await expect(info(page)).toContainText("Needs refresh");
  await expect(
    detail(page).getByRole("button", { name: "Approve" }),
  ).toHaveCount(0);
  await shot(
    page,
    "R16-stale",
    "The page stays. Status reads Needs refresh and the buttons go.",
  );
});
test("R17 full file", async ({ page }) => {
  await start(page, { ...owner, detail: "skill" });
  await toReviews(page);
  await openRow(page, /release-checklist/);
  await detail(page).getByRole("button", { name: "Full file" }).click();
  await expect(
    detail(page).getByRole("region", { name: /source$/ }),
  ).toBeVisible();
  await shot(
    page,
    "R17-full-file",
    "The whole file after the change, no marks.",
  );
});
test("R18 last in the queue", async ({ page }) => {
  await start(page, { ...owner, detail: "skill" });
  await toReviews(page);
  await openRow(page, /release-checklist/);
  const stepper = page.getByRole("navigation", { name: "Requests" });
  await expect(
    stepper.getByRole("button", { name: "Previous request" }),
  ).toBeDisabled();
  await stepper.getByRole("button", { name: "Next request" }).click();
  await stepper.getByRole("button", { name: "Next request" }).click();
  await expect(stepper).toContainText("3 of 3");
  await expect(
    stepper.getByRole("button", { name: "Next request" }),
  ).toBeDisabled();
  await shot(page, "R18-last-in-queue", "Next is disabled at the end.");
});
test("R20 long content", async ({ page }) => {
  await start(page, {
    detail: "longpath",
    longNames: true,
    requests: [
      req(
        "m1",
        "Notes from the permissions migration covering every role, every category, and the exceptions kept for existing members",
        { author: "jon" },
      ),
    ],
  });
  await toReviews(page);
  await openRow(page, /Notes from the permissions/);
  await expect(
    detail(page).getByRole("button", { name: "Approve" }),
  ).toBeEnabled();
  await shot(
    page,
    "R20-long-content",
    "A long name wraps. Long values and file names end in an ellipsis.",
  );
});
test("R21 after the last decision", async ({ page }) => {
  await start(page, {
    detail: "skill",
    requests: [req("skill-1", "release-checklist")],
  });
  await toReviews(page);
  await openRow(page, /release-checklist/);
  await detail(page).getByRole("button", { name: "Reject" }).click();
  await expect(reviews(page).getByText("Nothing to review")).toBeVisible();
  await expect(page.getByText("Rejected release-checklist")).toBeVisible();
  await shot(page, "R21-after-last", "Back on the list, with a toast.");
});
test("R22 member request at the smallest window", async ({ page }) => {
  await start(page, memberScene, compact);
  await toReviews(page);
  await openRow(page, /Desktop interaction/);
  await expect(detail(page)).toContainText("Awaiting approval");
  await shot(page, "R22-member-900", "The status pill leads the details line.");
});
test("R23 back keeps the list where it was", async ({ page }) => {
  await start(page, { ...owner, requests: twelve, detail: "skill" });
  await toReviews(page);
  const list = reviews(page).locator(".reviews-scroll");
  await list.evaluate((node) => {
    node.scrollTop = 120;
  });
  await openRow(page, /Release notes voice/);
  await expect(
    detail(page).getByRole("button", { name: "Approve" }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "Back to Reviews" }).click();
  await expect(list).toBeVisible();
  expect(await list.evaluate((node) => node.scrollTop)).toBe(120);
});
test("D02 access dialog, sending", async ({ page }) => {
  await start(page, owner);
  await toReviews(page);
  await openRow(page, /Access to Sessions/);
  await flag(page, { holdRequestDecision: true });
  await accessDialog(page).getByRole("button", { name: "Approve" }).click();
  await expect(
    accessDialog(page).getByRole("button", { name: "Close" }),
  ).toBeDisabled();
  await shot(
    page,
    "D02-access-sending",
    "Approve shows progress. The dialog cannot be closed.",
  );
});
test("D03 access dialog, decision failed", async ({ page }) => {
  await start(page, owner);
  await toReviews(page);
  await openRow(page, /Access to Sessions/);
  await flag(page, { decideFail: true });
  await accessDialog(page).getByRole("button", { name: "Approve" }).click();
  await expect(accessDialog(page)).toContainText("Not sent");
  await shot(
    page,
    "D03-access-failed",
    "A Not sent pill. The buttons work again.",
  );
  await flag(page, { decideFail: false });
  await accessDialog(page).getByRole("button", { name: "Approve" }).click();
  await expect(accessDialog(page)).toHaveCount(0);
  await expect(page.getByText("Approved Access to Sessions")).toBeVisible();
  await expect(
    reviews(page).getByRole("row", { name: /Access to Sessions/ }),
  ).toHaveCount(0);
});
test("D04 access dialog at the smallest window", async ({ page }) => {
  await start(page, owner, compact);
  await toReviews(page);
  await openRow(page, /Access to Sessions/);
  await expect(accessDialog(page)).toBeVisible();
  await shot(page, "D04-access-900", "Same dialog, centered.");
});

// ---------- States nobody drew ----------
const violations = async (page: Page, selector: string) =>
  (await new AxeBuilder({ page }).include(selector).analyze()).violations;

test("a read that finishes late does not replace the request now open", async ({
  page,
}) => {
  await start(page, { ...owner, detail: "skill" });
  await toReviews(page);
  await flag(page, { holdRequestLoad: true });
  await openRow(page, /release-checklist/);
  const finishFirst = await page.evaluateHandle(
    () =>
      (window as unknown as { finishRequestLoad: () => void })
        .finishRequestLoad,
  );
  await flag(page, { holdRequestLoad: false });
  await page
    .getByRole("navigation", { name: "Requests" })
    .getByRole("button", { name: "Next request" })
    .click();
  const heading = detail(page).getByRole("heading", { level: 2 }).first();
  await expect(heading).toHaveText("Desktop interaction guidelines");
  await expect(
    detail(page).getByRole("button", { name: "Approve" }),
  ).toBeEnabled();
  await finishFirst.evaluate((finish) => finish());
  await expect(heading).toHaveText("Desktop interaction guidelines");
  await expect(
    page.getByRole("navigation", { name: "Requests" }),
  ).toContainText("2 of 3");
});
test("a decision that lands after going back does not reopen a review", async ({
  page,
}) => {
  await start(page, { ...owner, detail: "skill" });
  await toReviews(page);
  await openRow(page, /release-checklist/);
  await flag(page, { holdRequestDecision: true });
  await detail(page).getByRole("button", { name: "Approve" }).click();
  await page.getByRole("button", { name: "Back to Reviews" }).click();
  await expect(detail(page)).toHaveCount(0);
  await page.evaluate(() =>
    (
      window as unknown as { finishRequestDecision: () => void }
    ).finishRequestDecision(),
  );
  await expect(page.getByText("Approved release-checklist")).toBeVisible();
  await expect(detail(page)).toHaveCount(0);
  await expect(
    reviews(page).getByRole("region", { name: /^To decide/ }),
  ).toContainText("To decide 3");
});
test("a failed list load recovers with Retry", async ({ page }) => {
  await page.addInitScript(() => {
    (window as unknown as { failCatalog: boolean }).failCatalog = true;
  });
  await start(page, owner);
  await toReviews(page);
  await expect(reviews(page).getByRole("alert")).toContainText(
    "Couldn’t load reviews",
  );
  await flag(page, { failCatalog: false });
  await reviews(page).getByRole("button", { name: "Retry" }).click();
  await expect(
    reviews(page)
      .getByRole("row", { name: /release-checklist/ })
      .first(),
  ).toBeVisible();
});
test("a decided access request opens read only", async ({ page }) => {
  await start(page, {
    requests: [
      req("a9", "Sessions access request", {
        type: "access",
        requestedMode: "suggest",
        requestedClass: "session",
        author: "ana",
        status: "approved",
        reviewer: "owner",
      }),
    ],
  });
  await toReviews(page);
  await reviews(page).getByRole("button", { name: "History" }).click();
  await openRow(page, /Access to Sessions/);
  await expect(accessDialog(page).locator("h2:not(.sr-only)")).toHaveText(
    "Access to Sessions",
  );
  await expect(accessDialog(page)).toContainText("Approved");
  await expect(
    accessDialog(page).getByRole("button", { name: "Approve" }),
  ).toHaveCount(0);
  await shot(
    page,
    "X03-access-decided",
    "A decided access request: its outcome, and only Close.",
  );
  await page.keyboard.press("Escape");
  await expect(accessDialog(page)).toHaveCount(0);
  await expect(
    reviews(page).getByRole("button", { name: "Access to Sessions" }),
  ).toBeFocused();
});
test("a member sees their own access request without a decision", async ({
  page,
}) => {
  await start(page, {
    role: "member",
    requests: [
      req("a9", "Skills access request", {
        type: "access",
        requestedMode: "publish",
        requestedClass: "skill",
        canReview: false,
      }),
    ],
  });
  await toReviews(page);
  await openRow(page, /Access to Skills/);
  await expect(accessDialog(page)).toContainText("Awaiting approval");
  await expect(
    accessDialog(page).getByRole("button", { name: "Reject" }),
  ).toHaveCount(0);
  await shot(
    page,
    "X04-access-own",
    "A member’s own access request: its status, and only Close.",
  );
});
test("an access request the app cannot name still reads as a question", async ({
  page,
}) => {
  await start(page, {
    requests: [
      req("a2", "Resource access request", { type: "access", author: "ana" }),
    ],
  });
  await toReviews(page);
  await openRow(page, /Resource access request/);
  await expect(accessDialog(page).locator("h2:not(.sr-only)")).toHaveText(
    "Approve this access request?",
  );
  await expect(accessDialog(page)).toContainText(
    "Ana Souza asked 1 day ago for access to this item.",
  );
  await expect(accessDialog(page)).not.toContainText("undefined");
  await shot(
    page,
    "X05-access-unnamed",
    "No level and no known item: the dialog still reads.",
  );
});
test("a request with nothing to compare says so and can still be decided", async ({
  page,
}) => {
  await start(page, { ...owner, detail: "access" });
  await toReviews(page);
  await openRow(page, /release-checklist/);
  await expect(detail(page).getByText("No file changes.")).toBeVisible();
  await expect(
    detail(page).getByRole("button", { name: "Full file" }),
  ).toHaveCount(0);
  await expect(
    detail(page).getByRole("button", { name: "Approve" }),
  ).toBeEnabled();
  await shot(
    page,
    "X06-no-file-changes",
    "Nothing to compare: one line, no view switch, no Files.",
  );
});
test("the keyboard opens a review and comes back to the same row", async ({
  page,
}) => {
  await start(page, { ...owner, detail: "skill" });
  await toReviews(page);
  const row = reviews(page).getByRole("button", {
    name: "Desktop interaction guidelines",
  });
  await row.focus();
  await page.keyboard.press("Enter");
  await expect(
    detail(page).getByRole("button", { name: "Approve" }),
  ).toBeEnabled();
  await expect(reviews(page)).toBeFocused();
  await page.getByRole("button", { name: "Back to Reviews" }).press("Enter");
  await expect(row).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(detail(page)).toBeVisible();
});
test("a collapsed sidebar keeps Reviews reachable", async ({ page }) => {
  await start(page, { ...owner, detail: "skill" });
  await page.getByRole("button", { name: "Collapse sidebar" }).click();
  await page.getByRole("button", { name: "Reviews", exact: true }).click();
  await expect(reviews(page)).toBeVisible();
  await openRow(page, /release-checklist/);
  await expect(
    detail(page).getByRole("button", { name: "Approve" }),
  ).toBeEnabled();
  await shot(
    page,
    "X08-collapsed-sidebar",
    "Collapsed sidebar: more room for the change.",
  );
});
test("the list, the review page and the access dialog pass the accessibility checks", async ({
  page,
}) => {
  await start(page, { ...owner, detail: "memory" });
  await toReviews(page);
  expect(await violations(page, ".reviews-page")).toEqual([]);
  await reviews(page).getByRole("button", { name: "History" }).click();
  expect(await violations(page, ".reviews-page")).toEqual([]);
  await reviews(page).getByRole("button", { name: "Open" }).click();
  await openRow(page, /Access to Sessions/);
  expect(await violations(page, '[role="dialog"]')).toEqual([]);
  await page.keyboard.press("Escape");
  await openRow(page, /Desktop interaction/);
  await expect(
    detail(page).getByRole("button", { name: "Approve" }),
  ).toBeEnabled();
  expect(await violations(page, ".reviews-page")).toEqual([]);
  // The header sync status has a known naming issue of its own; check what this page adds.
  expect(await violations(page, ".review-stepper")).toEqual([]);
});
test("a long list fades only at the edge that hides rows", async ({ page }) => {
  await start(page, { ...owner, requests: twelve });
  await toReviews(page);
  const list = reviews(page).locator(".reviews-scroll");
  await expect(list).toHaveAttribute("data-fade-bottom", "");
  await expect(list).not.toHaveAttribute("data-fade-top", "");
  await list.evaluate((node) => {
    node.scrollTop = node.scrollHeight;
  });
  await expect(list).toHaveAttribute("data-fade-top", "");
  await expect(list).not.toHaveAttribute("data-fade-bottom", "");
  // A list that fits has no fade at all.
  await reviews(page).getByRole("button", { name: "History" }).click();
  await expect(list).not.toHaveAttribute("data-fade-bottom", "");
  await expect(list).not.toHaveAttribute("data-fade-top", "");
});
test("the smallest window drops Repository, and History also drops From", async ({
  page,
}) => {
  await start(page, owner, compact);
  await toReviews(page);
  const header = (name: string) =>
    reviews(page).getByRole("columnheader", { name });
  await expect(header("From")).toBeVisible();
  await expect(header("Repository").first()).toBeHidden();
  await reviews(page).getByRole("button", { name: "History" }).click();
  await expect(header("Outcome")).toBeVisible();
  await expect(header("From")).toBeHidden();
  await expect(header("Repository")).toBeHidden();
  // Nothing spills past the page.
  expect(
    await reviews(page)
      .locator(".reviews-scroll")
      .evaluate((node) => node.scrollWidth <= node.clientWidth),
  ).toBe(true);
});
test("loading says so, then shows the list", async ({ page }) => {
  await start(page, { ...owner, holdCatalog: true });
  await toReviews(page);
  await expect(reviews(page).getByRole("status")).toContainText(
    "Loading reviews",
  );
  await expect(reviews(page).getByRole("row")).toHaveCount(0);
});
test("refresh asks the service again", async ({ page }) => {
  await start(page, owner);
  await toReviews(page);
  await expect(reviews(page).getByRole("row")).toHaveCount(8);
  const calls = () =>
    page.evaluate(
      () => (window as unknown as { catalogCalls: number }).catalogCalls,
    );
  const before = await calls();
  await reviews(page).getByRole("button", { name: "Refresh reviews" }).click();
  await expect.poll(calls).toBeGreaterThan(before);
  await expect(reviews(page).getByRole("row")).toHaveCount(8);
});
test("a failed decision can be sent again from the page", async ({ page }) => {
  await start(page, {
    detail: "skill",
    requests: [req("skill-1", "release-checklist")],
  });
  await toReviews(page);
  await openRow(page, /release-checklist/);
  await flag(page, { decideFail: true });
  await detail(page).getByRole("button", { name: "Approve" }).click();
  await expect(info(page).getByRole("alert")).toContainText("Not sent");
  await flag(page, { decideFail: false });
  await detail(page).getByRole("button", { name: "Approve" }).click();
  await expect(page.getByText("Approved release-checklist")).toBeVisible();
  await expect(reviews(page).getByText("Nothing to review")).toBeVisible();
});
test("a decision cannot be sent twice by leaving the page and coming back", async ({
  page,
}) => {
  await start(page, { ...owner, detail: "skill" });
  await toReviews(page);
  await page.evaluate(() => {
    const w = window as unknown as {
      decisions: number;
      __TAURI_INTERNALS__: {
        invoke: (
          command: string,
          args: { action?: string },
        ) => Promise<unknown>;
      };
    };
    w.decisions = 0;
    const invoke = w.__TAURI_INTERNALS__.invoke;
    w.__TAURI_INTERNALS__.invoke = (command, args) => {
      if (args?.action === "decide") w.decisions += 1;
      return invoke(command, args);
    };
  });
  await openRow(page, /release-checklist/);
  await flag(page, { holdRequestDecision: true });
  await detail(page).getByRole("button", { name: "Approve" }).click();
  await page.getByRole("button", { name: "Back to Reviews" }).click();
  await openRow(page, /release-checklist/);
  await expect(
    detail(page).getByRole("button", { name: "Approve" }),
  ).toBeDisabled();
  await expect(
    detail(page).getByRole("button", { name: "Reject" }),
  ).toBeDisabled();
  expect(
    await page.evaluate(
      () => (window as unknown as { decisions: number }).decisions,
    ),
  ).toBe(1);
  await page.evaluate(() =>
    (
      window as unknown as { finishRequestDecision: () => void }
    ).finishRequestDecision(),
  );
  await expect(page.getByText("Approved release-checklist")).toBeVisible();
  expect(
    await page.evaluate(
      () => (window as unknown as { decisions: number }).decisions,
    ),
  ).toBe(1);
  // Reopened on the same request, so it moves on as any decision does.
  await expect(
    detail(page).getByRole("heading", { level: 2 }).first(),
  ).toHaveText("Desktop interaction guidelines");
  await expect(
    reviews(page).getByRole("button", { name: "release-checklist" }),
  ).toHaveCount(0);
});
test("opening an access request marks its notification read", async ({
  page,
}) => {
  await start(page, owner);
  await toReviews(page);
  await openRow(page, /Access to Sessions/);
  await expect(accessDialog(page)).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as unknown as { readCalls?: string[] }).readCalls ?? [],
      ),
    )
    .toEqual(["a1"]);
});
test("the smallest window keeps a memory's topic and what it replaces in view", async ({
  page,
}) => {
  await start(page, { ...owner, detail: "memory" }, compact);
  await toReviews(page);
  await openRow(page, /Desktop interaction/);
  await expect(
    detail(page).getByRole("button", { name: "Approve" }),
  ).toBeEnabled();
  await expect(detail(page).locator(".detail-meta")).toContainText("Topic");
  await expect(detail(page).locator(".detail-meta")).toContainText("Provider");
  await expect(detail(page).locator(".detail-meta")).toContainText("Seen by");
  await shot(
    page,
    "X09-memory-900",
    "A memory at the smallest window: its facts stay on the details line.",
  );
});
test("after a decision the keyboard is on the page that opened next", async ({
  page,
}) => {
  await start(page, { ...owner, detail: "memory" });
  await toReviews(page);
  await openRow(page, /release-checklist/);
  const approve = detail(page).getByRole("button", { name: "Approve" });
  await approve.focus();
  await page.keyboard.press("Enter");
  await expect(
    detail(page).getByRole("heading", { level: 2 }).first(),
  ).toContainText("Desktop interaction guidelines");
  await expect(reviews(page)).toBeFocused();
});

test("a decision stays locked through Settings and another tab", async ({
  page,
}) => {
  await start(page, { ...owner, detail: "skill" });
  await toReviews(page);
  await openRow(page, /release-checklist/);
  await flag(page, { holdRequestDecision: true });
  await detail(page).getByRole("button", { name: "Approve" }).click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.keyboard.press("Escape");
  await expect(
    detail(page).getByRole("button", { name: "Approve" }),
  ).toBeDisabled();
  await page
    .getByRole("button", { name: /^Skills/ })
    .first()
    .click();
  await toReviews(page);
  await openRow(page, /release-checklist/);
  await expect(
    detail(page).getByRole("button", { name: "Reject" }),
  ).toBeDisabled();
  await page.evaluate(() =>
    (
      window as unknown as { finishRequestDecision: () => void }
    ).finishRequestDecision(),
  );
  await expect(page.getByText("Approved release-checklist")).toBeVisible();
  // Nobody is pulled into the next review by a decision sent from an earlier page.
  await expect(
    detail(page).getByRole("heading", { level: 2 }).first(),
  ).toHaveText("release-checklist");
  await expect(info(page)).toContainText("Approved");
});
test("a decision that fails after leaving the page says so", async ({
  page,
}) => {
  await start(page, { ...owner, detail: "skill" });
  await toReviews(page);
  await openRow(page, /release-checklist/);
  await flag(page, { decideFail: true });
  await page.evaluate(() => {
    // Hold the failing call until the reviewer has left the page.
    const w = window as unknown as {
      releaseDecision: () => void;
      __TAURI_INTERNALS__: {
        invoke: (
          command: string,
          args: { action?: string },
        ) => Promise<unknown>;
      };
    };
    const invoke = w.__TAURI_INTERNALS__.invoke;
    w.__TAURI_INTERNALS__.invoke = async (command, args) => {
      if (args?.action === "decide")
        await new Promise<void>((resolve) => {
          w.releaseDecision = resolve;
        });
      return invoke(command, args);
    };
  });
  await detail(page).getByRole("button", { name: "Approve" }).click();
  await page.getByRole("button", { name: "Back to Reviews" }).click();
  await page.evaluate(() =>
    (window as unknown as { releaseDecision: () => void }).releaseDecision(),
  );
  await expect(
    page.getByText("Couldn’t send your decision on release-checklist"),
  ).toBeVisible();
  await openRow(page, /release-checklist/);
  await expect(info(page).getByRole("alert")).toContainText("Not sent");
  await expect(
    detail(page).getByRole("button", { name: "Approve" }),
  ).toBeEnabled();
});
test("Not sent is announced at the smallest window too", async ({ page }) => {
  await start(page, { ...owner, detail: "skill" }, compact);
  await toReviews(page);
  await openRow(page, /release-checklist/);
  await flag(page, { decideFail: true });
  await detail(page).getByRole("button", { name: "Approve" }).click();
  await expect(
    detail(page).locator(".detail-meta").getByRole("alert"),
  ).toContainText("Not sent");
});
test("History stays selected after a trip through Settings", async ({
  page,
}) => {
  await start(page, owner);
  await toReviews(page);
  await reviews(page).getByRole("button", { name: "History" }).click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.keyboard.press("Escape");
  await expect(
    reviews(page).getByRole("button", { name: "History" }),
  ).toHaveAttribute("aria-pressed", "true");
});
