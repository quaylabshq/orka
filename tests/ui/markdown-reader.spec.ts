import { expect, test } from "@playwright/test";
import { detailGalleryFixture } from "./fixtures/detail-gallery.js";

const command = "pnpm test\npnpm run build";
const memory = [
  "---",
  "owner: Release team",
  "metadata:",
  "  type: handoff",
  "---",
  "",
  "# Release handoff",
  "",
  "Check the release branch before handing it to the next teammate.",
  "",
  "| Check | Owner |",
  "| --- | --- |",
  "| Build | Desktop |",
  "| Offline retry | Sync |",
  "",
  "> [!IMPORTANT]",
  "> Keep the original checklist until the next teammate confirms the build.",
  "",
  "```sh",
  command,
  "```",
].join("\n");

test("a formatted memory separates file properties from body tables and preserves its source", async ({
  page,
}) => {
  const view = await detailGalleryFixture(page, {
    kind: "memory",
    content: memory,
  });
  const reader = view.getByRole("article", { name: "Rendered Markdown" });
  const properties = reader.getByRole("table", { name: "Properties" });
  await expect(properties.getByRole("columnheader")).toHaveText([
    "Property",
    "Value",
  ]);
  await expect(
    properties.getByRole("row", { name: "metadata.type handoff" }),
  ).toBeVisible();
  await expect(reader.getByRole("heading", { name: "Properties" })).toHaveCount(
    0,
  );
  await expect(
    properties.getByRole("columnheader", { name: "Value" }),
  ).toHaveCSS("border-left-width", "1px");
  const tableRegion = reader.getByRole("region", { name: "Markdown table" });
  const data = tableRegion.getByRole("table");
  await expect(data.getByRole("columnheader")).toHaveText(["Check", "Owner"]);
  await expect(data.getByRole("row", { name: "Build Desktop" })).toBeVisible();
  await expect(tableRegion).toHaveCSS("border-top-width", "1px");
  await expect(data.getByRole("cell", { name: "Desktop" })).toHaveCSS(
    "border-bottom-width",
    "1px",
  );
  const callout = reader.getByRole("complementary", { name: "Important" });
  await expect(callout).toContainText("Keep the original checklist");
  const borders = await callout.evaluate((el) => {
    const style = getComputedStyle(el);
    return [
      style.borderLeftWidth,
      style.borderRightWidth,
      style.borderLeftColor,
      style.borderRightColor,
    ];
  });
  expect(borders[0]).toBe(borders[1]);
  expect(borders[2]).toBe(borders[3]);
  await view.getByRole("button", { name: "Markdown", exact: true }).click();
  const raw = view.getByRole("group", { name: "Markdown source" });
  await expect(raw).toBeVisible();
  expect((await raw.locator(".source-code").allTextContents()).join("\n")).toBe(
    memory,
  );
});

test("fenced code copies the original lines and can be reached from the keyboard", async ({
  page,
}) => {
  const view = await detailGalleryFixture(page, {
    kind: "memory",
    content: memory,
  });
  const reader = view.getByRole("article", { name: "Rendered Markdown" });
  const code = reader.getByRole("region", { name: "Shell code" });
  await code.focus();
  await expect(code).toBeFocused();
  await page.evaluate(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (value: string) => {
          document.documentElement.dataset.clipboard = value;
        },
      },
    });
  });
  await reader.getByRole("button", { name: "Copy code" }).press("Enter");
  await expect(reader.getByRole("status")).toHaveText("Code copied");
  await expect(page.locator("html")).toHaveAttribute("data-clipboard", command);
});
