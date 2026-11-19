import { test, expect, type Page } from "@playwright/test";
import { syncAttentionFixture } from "./fixtures/sync-attention.js";

async function loadFixture(
  page: Page,
  planUnavailable?: "deleted" | "missing",
) {
  await syncAttentionFixture(page, { planUploadReview: true, planUnavailable });
  await page.goto("/");
}

async function openReview(page: Page) {
  await page.locator(".workspace-header .sync-status").click();
  await page
    .getByRole("region", { name: "Changes that need review" })
    .getByRole("group", { name: "Release checklist in Product", exact: true })
    .getByRole("button", { name: "Review upload", exact: true })
    .click();
  return page.getByRole("dialog", {
    name: "Review queued upload",
    exact: true,
  });
}

for (const width of [1160, 900])
  test(`failed Plan upload reviews the frozen snapshot against the shared version at ${width}`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height: width === 900 ? 640 : 800 });
    await loadFixture(page);
    const review = await openReview(page);
    await expect(review).toContainText("Shared version 3");
    await expect(review).toContainText("Queued snapshot");
    await expect(review).toContainText("Shared milestone");
    await expect(review).toContainText("Queued milestone");
    await expect(review).toContainText("later local edits are not included");
    const submit = review.getByRole("button", {
      name: "Queue reviewed update",
      exact: true,
    });
    await expect(submit).toBeEnabled();
    await expect(submit).toBeInViewport();
    await page.screenshot({ path: info.outputPath(`review-${width}.png`) });
    await submit.dblclick();
    await expect(review).toHaveCount(0);
    const retries = await page.evaluate(() =>
      window.attentionFixture.calls.filter(
        (call) =>
          call.name === "resource_command" &&
          call.args?.action === "retry-upload",
      ),
    );
    expect(retries).toHaveLength(1);
    expect(retries[0].args?.input).toMatchObject({
      projectId: "one",
      resourceId: "plan",
      uploadId: "plan-upload",
      previewToken: "review-1",
    });
  });

test("cancel preserves the failed upload and restores a usable focus target", async ({
  page,
}) => {
  await loadFixture(page);
  const review = await openReview(page);
  await expect(review).toContainText("Queued milestone");
  await review.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(review).toHaveCount(0);
  await expect(page.locator('button[data-resource-id="plan"]')).toBeFocused();
  const state = await page.evaluate(() => ({
    upload: window.attentionFixture.state.outbox[0],
    writes: window.attentionFixture.calls.filter(
      (call) => call.args?.action === "retry-upload",
    ),
  }));
  expect(state.upload.error).toMatch(/^409:/);
  expect(state.writes).toEqual([]);
});

test("a stale review is invalidated and must be refreshed before another submit", async ({
  page,
}) => {
  await loadFixture(page);
  const review = await openReview(page);
  await page.evaluate(() => {
    window.attentionFixture.uploadReviewFailure =
      "The shared plan or queued upload changed. Review the latest versions again.";
  });
  await review
    .getByRole("button", { name: "Queue reviewed update", exact: true })
    .click();
  await expect(review.getByRole("alert")).toContainText(
    "Review the latest versions again",
  );
  await expect(
    review.getByRole("button", { name: "Queue reviewed update", exact: true }),
  ).toBeDisabled();
  await page.evaluate(() => {
    window.attentionFixture.uploadReviewFailure = undefined;
  });
  await review
    .getByRole("button", { name: "Review latest version", exact: true })
    .click();
  await expect(
    review.getByRole("button", { name: "Queue reviewed update", exact: true }),
  ).toBeEnabled();
  await review
    .getByRole("button", { name: "Queue reviewed update", exact: true })
    .click();
  await expect(review).toHaveCount(0);
  const tokens = await page.evaluate(() =>
    window.attentionFixture.calls
      .filter((call) => call.args?.action === "retry-upload")
      .map(
        (call) => (call.args?.input as { previewToken: string }).previewToken,
      ),
  );
  expect(tokens).toEqual(["review-1", "review-2"]);
});

test("offline preview can be retried without sending or losing the queued snapshot", async ({
  page,
}) => {
  await loadFixture(page);
  await page.evaluate(() => {
    window.attentionFixture.failUploadPreview = true;
  });
  const review = await openReview(page);
  await expect(review.getByRole("alert")).toContainText(
    "queued snapshot was kept",
  );
  await expect(
    review.getByRole("button", { name: "Queue reviewed update", exact: true }),
  ).toBeDisabled();
  await page.evaluate(() => {
    window.attentionFixture.failUploadPreview = false;
  });
  await review
    .getByRole("button", { name: "Review latest version", exact: true })
    .click();
  await expect(review).toContainText("Queued milestone");
  await review.getByRole("button", { name: "Cancel", exact: true }).click();
  expect(
    await page.evaluate(() =>
      window.attentionFixture.calls.some(
        (call) => call.args?.action === "retry-upload",
      ),
    ),
  ).toBe(false);
});

test("the Plan item menu exposes the same reviewed-upload action", async ({
  page,
}) => {
  await loadFixture(page);
  await page.getByRole("button", { name: /^Plans\b/ }).click();
  await page
    .getByRole("button", { name: "Actions for Release checklist", exact: true })
    .click();
  await page
    .getByRole("menuitem", { name: "Review queued upload…", exact: true })
    .click();
  const review = page.getByRole("dialog", {
    name: "Review queued upload",
    exact: true,
  });
  await expect(review).toContainText("Queued milestone");
  await review.getByRole("button", { name: "Cancel", exact: true }).click();
});

for (const unavailable of ["deleted", "missing"] as const)
  test(`a ${unavailable} shared Plan still opens upload recovery and preserves the queued snapshot`, async ({
    page,
  }) => {
    await loadFixture(page, unavailable);
    const review = await openReview(page);
    await expect(review.getByRole("alert")).toContainText(
      "queued snapshot was kept",
    );
    await expect(
      review.getByRole("button", {
        name: "Queue reviewed update",
        exact: true,
      }),
    ).toBeDisabled();
    await review.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(page.locator(".workspace-header .sync-status")).toBeFocused();
    const upload = await page.evaluate(
      () => window.attentionFixture.state.outbox[0],
    );
    expect(upload.error).toMatch(/^409:/);
  });
