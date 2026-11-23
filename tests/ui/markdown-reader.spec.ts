import AxeBuilder from "@axe-core/playwright";
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
  const callout = reader.getByRole("note", { name: "Important" });
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
  const code = reader.getByRole("group", { name: "Shell code" });
  await code.focus();
  await expect(code).toBeFocused();
  await page.evaluate(() => {
    let writes = 0;
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: (value: string) =>
          new Promise<void>((resolve) => {
            document.addEventListener("finish-code-copy", () => resolve(), {
              once: true,
            });
            document.documentElement.dataset.clipboard = value;
            document.documentElement.dataset.clipboardWrites = String(++writes);
          }),
      },
    });
  });
  const copy = reader.getByRole("button", { name: "Copy code" });
  await copy.focus();
  await page.keyboard.press("Enter");
  await expect(copy).toBeDisabled();
  await expect(copy).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator("html")).toHaveAttribute(
    "data-clipboard-writes",
    "1",
  );
  await page.evaluate(() => {
    document.dispatchEvent(new Event("finish-code-copy"));
  });
  await expect(copy).toBeEnabled();
  await expect(copy).toBeFocused();
  await expect(reader.getByRole("status")).toHaveText("Code copied");
  await expect(page.locator("html")).toHaveAttribute("data-clipboard", command);
});

test("repeated callouts and code blocks do not add duplicate landmarks", async ({
  page,
}) => {
  const content = [
    "> [!NOTE]",
    "> Prepare the release.",
    "",
    "```sh",
    "pnpm test",
    "```",
    "",
    "> [!NOTE]",
    "> Verify the build.",
    "",
    "```sh",
    "pnpm run build",
    "```",
  ].join("\n");
  const view = await detailGalleryFixture(page, { kind: "memory", content });
  const reader = view.getByRole("article", { name: "Rendered Markdown" });
  await expect(reader.getByText("Prepare the release.")).toBeVisible();
  await expect(reader.getByText("Verify the build.")).toBeVisible();
  await expect(reader.getByRole("button", { name: "Copy code" })).toHaveCount(
    2,
  );

  const result = await new AxeBuilder({ page })
    .withRules(["landmark-unique"])
    .analyze();
  expect(result.violations).toEqual([]);
});

for (const viewport of [
  { width: 1160, height: 800 },
  { width: 900, height: 640 },
]) {
  test(`wide Mermaid diagrams remain readable and scroll inside the ${viewport.width}px reader`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    const steps = Array.from({ length: 14 }, (_, index) => {
      const next = index < 13 ? ` --> step${index + 1}` : "";
      return `step${index}[Verify release step ${index + 1}]${next}`;
    });
    const content = ["```mermaid", "flowchart LR", ...steps, "```"].join("\n");
    const view = await detailGalleryFixture(page, { kind: "plan", content });
    const diagram = view.getByRole("img", { name: "Mermaid diagram" });
    const svg = diagram.locator("svg");
    await expect(svg).toBeVisible();

    const size = await svg.evaluate((svg: SVGSVGElement) => ({
      intrinsic: svg.viewBox.baseVal.width,
      rendered: svg.getBoundingClientRect().width,
      reader: svg.parentElement!.clientWidth,
      scroll: svg.parentElement!.scrollWidth,
    }));
    expect(size.intrinsic).toBeGreaterThan(2 * size.reader);
    expect(size.rendered).toBeCloseTo(size.intrinsic, 0);
    expect(size.scroll - size.reader).toBeGreaterThan(size.reader);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBe(viewport.width);

    await diagram.focus();
    await expect(diagram).toBeFocused();
    await page.keyboard.press("ArrowRight");
    await expect
      .poll(() => diagram.evaluate((el) => el.scrollLeft))
      .toBeGreaterThan(0);
  });
}
