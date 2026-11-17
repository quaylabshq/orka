import { test, expect } from "@playwright/test";
import { startupFixture, type StartupWindow } from "./fixtures/startup.js";

for (const viewport of [
  { width: 1160, height: 800 },
  { width: 900, height: 640 },
]) {
  test(`startup loading clears native chrome at ${viewport.width}px`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await startupFixture(page, { pending: true });
    const status = page.getByRole("status");
    await expect(status).toHaveText("Loading…");
    expect((await status.boundingBox())!.y).toBeGreaterThanOrEqual(64);
    expect(
      await page.evaluate(() =>
        document
          .elementFromPoint(300, 20)
          ?.hasAttribute("data-tauri-drag-region"),
      ),
    ).toBe(true);
    await page.evaluate(() =>
      (window as unknown as StartupWindow).startup.release(),
    );
    await expect(
      page.getByRole("heading", { name: "Get started with Orka" }),
    ).toBeVisible();
  });

  test(`startup errors wrap and retry clears native chrome at ${viewport.width}px`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await startupFixture(page, {
      error: `Cannot read /synthetic/${"long-directory/".repeat(30)}sync.sqlite`,
    });
    const error = page.getByRole("alert");
    await expect(error).toContainText("Cannot read /synthetic/");
    const bounds = (await error.boundingBox())!;
    expect(bounds.y).toBeGreaterThanOrEqual(64);
    expect(bounds.width).toBeLessThanOrEqual(viewport.width - 64);
    expect(
      await error.evaluate(
        (element) => element.scrollWidth <= element.clientWidth,
      ),
    ).toBe(true);
    const retry = page.getByRole("button", { name: "Try again" });
    expect((await retry.boundingBox())!.y).toBeGreaterThanOrEqual(64);
    await page.evaluate(
      () => ((window as unknown as StartupWindow).startup.error = ""),
    );
    await page.keyboard.press("Tab");
    await expect(retry).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(
      page.getByRole("heading", { name: "Get started with Orka" }),
    ).toBeVisible();
  });
}
