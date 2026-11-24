import { test, expect, type Page } from "@playwright/test";
import { AxeBuilder } from "@axe-core/playwright";
import { readFileSync } from "node:fs";
import {
  resourceLibraryFixture,
  type LibraryWindow,
} from "./fixtures/resource-library.js";

const kinds = [
  { kind: "memory", label: "Memories" },
  { kind: "session", label: "Sessions" },
  { kind: "plan", label: "Plans" },
] as const;
const nouns = { memory: "Memory", session: "Session", plan: "Plan" };
const personLabel = (kind: string) =>
  kind === "memory" ? "Updated by" : "Owner";
const pick = async (page: Page, category: string, option: string) => {
  await page.getByRole("button", { name: /^Filter/ }).click();
  await page.getByRole("menuitem", { name: category }).click();
  await page
    .getByRole("menuitemcheckbox", { name: option, exact: true })
    .click();
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
};

for (const width of [1160, 900]) {
  test(`Pi sessions keep their source identity in the catalog and reader at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: width === 900 ? 640 : 800 });
    await resourceLibraryFixture(page, { piSession: true });
    await page.getByRole("button", { name: /^Sessions/ }).click();
    await pick(page, "Agent", "Pi");
    const table = page.getByRole("table");
    await expect(table.locator("tbody tr")).toHaveCount(1);
    await expect(table.locator(".index-table-agent")).toHaveAttribute(
      "title",
      "Pi",
    );
    await table
      .getByRole("button", { name: "Private Pi session", exact: true })
      .click();
    await expect(
      page.getByRole("article", { name: "Pi", exact: true }),
    ).toContainText("Answer from the saved Pi branch");
    await page.getByRole("button", { name: "Open in Pi", exact: true }).click();
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as unknown as LibraryWindow).library.calls.find(
              ({ command }) => command === "resume_session",
            )?.args,
        ),
      )
      .toEqual({ id: "session-pi", tool: "pi", destination: "terminal" });
  });
}

for (const width of [1160, 900]) {
  test(`the index toolbar keeps refresh at its right edge while filtering and sorting at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 800 });
    await resourceLibraryFixture(page);
    for (const { kind, label } of kinds) {
      await page.getByRole("button", { name: new RegExp(`^${label}`) }).click();
      const toolbar = page.getByRole("group", {
        name: `${label.toLowerCase()} tools`,
      });
      const rows = page.locator("tbody tr");
      const person = personLabel(kind);
      await expect(rows).toHaveCount(4);
      for (const [option, count] of [
        ["You", 3],
        ["Mira", 1],
      ] as const) {
        await pick(page, person, option);
        await expect(rows).toHaveCount(count);
        const edges = await toolbar.evaluate((element) => ({
          toolbar: element.getBoundingClientRect().right,
          refresh: element
            .querySelector('[aria-label="Refresh local items"]')!
            .getBoundingClientRect().right,
          overflow: element.scrollWidth - element.clientWidth,
        }));
        expect(Math.abs(edges.toolbar - edges.refresh)).toBeLessThanOrEqual(1);
        expect(edges.overflow).toBeLessThanOrEqual(1);
        await page
          .getByRole("group", { name: "Active filters" })
          .getByRole("button", { name: `Remove ${person} filter` })
          .click();
      }
      await expect(rows).toHaveCount(4);
      await page.getByRole("button", { name: /^Sort/ }).click();
      await page
        .getByRole("menuitemradio", { name: "Name", exact: true })
        .click();
      await expect(
        page.getByRole("columnheader", { name: nouns[kind], exact: true }),
      ).toHaveAttribute("aria-sort", "ascending");
    }
  });
}

for (const width of [1160, 900]) {
  test(`session rows show where they live, their agent, and their owner at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 800 });
    await resourceLibraryFixture(page);
    await page.getByRole("button", { name: /^Sessions/ }).click();
    const table = page.getByRole("table");
    await expect(table.locator("tbody tr")).toHaveCount(4);
    const row = (title: string) =>
      table.getByRole("row", { name: new RegExp(title) });
    const local = row("Private session notes");
    await expect(
      local.getByLabel("On this Mac", { exact: true }),
    ).toBeVisible();
    await expect(table).not.toContainText("Local Only");
    await expect(local.locator(".index-table-agent")).toHaveAttribute(
      "title",
      "Codex",
    );
    await expect(local.locator(".index-table-person")).toHaveAttribute(
      "title",
      "You",
    );
    const teammate = row("Mira's session");
    await expect(
      teammate.getByLabel("Shared with team", { exact: true }),
    ).toBeVisible();
    await expect(teammate.locator(".index-table-agent")).toHaveAttribute(
      "title",
      "Claude",
    );
    await expect(teammate.locator(".index-table-person")).toHaveAttribute(
      "title",
      "Mira",
    );
    expect(
      await local.evaluate((element) => element.getBoundingClientRect().height),
    ).toBe(44);
    const results = await new AxeBuilder({ page })
      .include(".resource-index")
      .analyze();
    expect(results.violations).toEqual([]);
  });
}

test("GitHub teammate photos obey the packaged image policy and failures keep a profile icon", async ({
  page,
  baseURL,
}) => {
  const config = JSON.parse(
    readFileSync("apps/mac/src-tauri/tauri.conf.json", "utf8"),
  );
  const imagePolicy = config.app.security.csp
    .split(";")
    .find((directive: string) => directive.trim().startsWith("img-src"));
  const avatar = "https://avatars.githubusercontent.com/u/12345";
  let failAvatar = false;
  await page.route(avatar, async (route) => {
    if (failAvatar) await route.abort();
    else
      await route.fulfill({
        contentType: "image/png",
        body: Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6rS8AAAAASUVORK5CYII=",
          "base64",
        ),
      });
  });
  await page.route(`${baseURL}/`, async (route) => {
    const response = await route.fetch();
    await route.fulfill({
      response,
      headers: {
        ...response.headers(),
        "Content-Security-Policy": imagePolicy,
      },
    });
  });
  await resourceLibraryFixture(page, { teammateAvatar: avatar });
  await page.getByRole("button", { name: /^Sessions/ }).click();
  const person = page.locator('.index-table-person[title="Mira"]');
  const photo = person.locator("img");
  await expect
    .poll(() => photo.evaluate((img: HTMLImageElement) => img.naturalWidth))
    .toBe(1);
  await expect(photo).toBeVisible();
  failAvatar = true;
  await page.reload();
  await page.getByRole("button", { name: /^Sessions/ }).click();
  await expect(photo).toBeHidden();
  await expect(person.locator(".index-table-avatar")).toHaveText("M");
});

for (const { kind, label } of kinds)
  for (const outcome of ["success", "failure"])
    test(`${label} retry feedback waits until busy discovery completes with ${outcome}`, async ({
      page,
    }) => {
      await page.clock.install();
      await resourceLibraryFixture(page);
      await page.getByRole("button", { name: new RegExp(`^${label}`) }).click();
      const item = page.getByRole("button", {
        name: `Private ${kind} notes`,
        exact: true,
      });
      await expect(item).toBeVisible();
      await page.evaluate(() => {
        (window as unknown as LibraryWindow).library.busyCatalog = true;
      });
      const refresh = page.getByRole("button", {
        name: "Refresh local items",
        exact: true,
      });
      await refresh.click();
      await page.clock.runFor(100);
      await expect(refresh).toBeDisabled();
      const success = page.getByText(`Local ${label.toLowerCase()} refreshed`, {
        exact: true,
      });
      await expect(success).toHaveCount(0);
      await expect(item).toBeVisible();
      await page.evaluate((outcome) => {
        const library = (window as unknown as LibraryWindow).library;
        library.busyCatalog = false;
        library.failCatalog = outcome === "failure";
      }, outcome);
      await page.clock.runFor(5100);
      if (outcome === "success") await expect(success).toBeVisible();
      else {
        await expect(success).toHaveCount(0);
        await expect(page.getByRole("alert")).toContainText(
          `Couldn’t refresh local ${label.toLowerCase()}`,
        );
      }
      await expect(refresh).toBeEnabled();
      await expect(item).toBeVisible();
    });

test("cached revalidation during a manual refresh waits for discovery feedback", async ({
  page,
}) => {
  await page.clock.install();
  await resourceLibraryFixture(page, { cachedLocal: true });
  await page.getByRole("button", { name: /^Sessions/ }).click();
  const refresh = page.getByRole("button", {
    name: "Refresh local items",
    exact: true,
  });
  await expect(refresh).toBeEnabled();
  await page.evaluate(() => {
    (window as unknown as LibraryWindow).library.busyCatalog = true;
  });
  await refresh.click();
  await page.clock.runFor(100);
  await expect(refresh).toBeDisabled();
  await page.evaluate(() => {
    const library = (window as unknown as LibraryWindow).library;
    library.busyCatalog = false;
    library.deferCatalog = true;
    library.folderState = "reconnect";
  });
  await page.clock.runFor(3100);
  await expect
    .poll(() =>
      page.evaluate(
        () => typeof (window as unknown as LibraryWindow).library.finishCatalog,
      ),
    )
    .toBe("function");
  const success = page.getByText("Local sessions refreshed", { exact: true });
  await expect(success).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Private session notes", exact: true }),
  ).toBeVisible();
  await page.evaluate(() =>
    (window as unknown as LibraryWindow).library.finishCatalog?.(),
  );
  await expect(success).toBeVisible();
  await expect(refresh).toBeEnabled();
});

for (const { kind, label } of kinds)
  test(`${label} include private content with sharing off and filter by person`, async ({
    page,
  }) => {
    await resourceLibraryFixture(page);
    await page.getByRole("button", { name: new RegExp(`^${label}`) }).click();
    const table = page.getByRole("table");
    await expect(
      table.getByRole("button", { name: `Private ${kind} notes`, exact: true }),
    ).toBeVisible();
    await expect(table.locator("tbody tr")).toHaveCount(4);
    const person = personLabel(kind);
    // Memories credit whoever last updated them, other lists their owner.
    const teammate = kind === "memory" ? `My shared ${kind}` : `Mira's ${kind}`;
    await pick(page, person, "Mira");
    await expect(table.locator("tbody tr")).toHaveCount(1);
    const row = table.getByRole("row", { name: new RegExp(teammate) });
    await expect(row).toContainText("Mira");
    await row.getByRole("button", { name: teammate, exact: true }).click();
    await page
      .getByRole("button", { name: `Back to ${label}`, exact: true })
      .click();
    await expect(
      page.getByRole("group", { name: "Active filters" }),
    ).toHaveText(`${person}Mira`);
    await expect(
      table.getByRole("button", { name: teammate, exact: true }),
    ).toBeFocused();
    const calls = await page.evaluate(
      () => (window as unknown as LibraryWindow).library.calls,
    );
    expect(
      calls.some((call) => call.command === "local_resource_catalog"),
    ).toBe(true);
    expect(
      calls.filter((call) =>
        /^(sync_now|cloud_action|session_action|set_project_sharing)$/.test(
          call.command,
        ),
      ),
    ).toEqual([]);
  });

for (const { kind, label } of kinds) {
  test(`${label} private detail remains readable offline without shared history actions`, async ({
    page,
  }) => {
    await resourceLibraryFixture(page);
    await page.getByRole("button", { name: new RegExp(`^${label}`) }).click();
    await page
      .getByRole("button", { name: `Private ${kind} notes`, exact: true })
      .click();
    if (kind === "session")
      await expect(
        page.getByLabel("Conversation", { exact: true }),
      ).toContainText("Private session conversation");
    else
      await expect(
        page.getByRole("article", { name: "Rendered Markdown" }),
      ).toContainText("Local content remains readable offline");
    await expect(
      page.locator(".detail-title-card .detail-status"),
    ).toContainText("On this Mac");
    await page
      .getByRole("button", { name: "More resource actions", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "Copy link", exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", {
        name: "Compare with previous revision",
        exact: true,
      }),
    ).toHaveCount(0);
  });
}

test("person, repository, agent, and search filters compose", async ({
  page,
}) => {
  await resourceLibraryFixture(page);
  await page.getByRole("button", { name: /^Sessions/ }).click();
  await pick(page, "Owner", "You");
  await pick(page, "Repository", "backend");
  await page.getByRole("searchbox", { name: "Search sessions" }).fill("notes");
  const table = page.getByRole("table");
  await expect(table.locator("tbody tr")).toHaveCount(1);
  await expect(table).toContainText("Backend session notes");
  await pick(page, "Agent", "Codex");
  await expect(
    page.getByRole("heading", {
      name: "No sessions match “notes” with these filters",
    }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: /^Filter/ })).toBeVisible();
});

test("an empty collection shows its empty state without tools", async ({
  page,
}) => {
  await resourceLibraryFixture(page, { emptyShared: true, emptyLocal: true });
  await page.getByRole("button", { name: /^Sessions/ }).click();
  await expect(
    page.getByRole("heading", { name: "No sessions yet", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("searchbox", { name: "Search sessions" }),
  ).toHaveCount(0);
  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations).toEqual([]);
});

test("a pending local scan does not report an empty collection", async ({
  page,
}) => {
  await resourceLibraryFixture(page, { emptyShared: true, defer: true });
  await page.getByRole("button", { name: /^Sessions/ }).click();
  await expect
    .poll(() =>
      page.evaluate(
        () => typeof (window as unknown as LibraryWindow).library.finishCatalog,
      ),
    )
    .toBe("function");
  await expect(
    page.getByRole("heading", { name: "No sessions yet", exact: true }),
  ).toHaveCount(0);
  await page.evaluate(() =>
    (window as unknown as LibraryWindow).library.finishCatalog?.(),
  );
  await expect(
    page.getByRole("button", { name: "Private session notes", exact: true }),
  ).toBeVisible();
});

for (const [kind, label] of [
  ["memory", "Memories"],
  ["session", "Sessions"],
  ["plan", "Plans"],
])
  test(`${label} show saved local rows while startup discovery is pending`, async ({
    page,
  }) => {
    await resourceLibraryFixture(page, {
      emptyShared: true,
      cachedLocal: true,
      defer: true,
    });
    await page.getByRole("button", { name: new RegExp(`^${label}`) }).click();
    await expect(
      page.getByRole("button", {
        name: `Private ${kind} notes`,
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", {
        name: "Refresh local items",
        exact: true,
      }),
    ).toBeDisabled();
    await expect(page.getByRole("alert")).toHaveCount(0);
    await page.evaluate(() =>
      (window as unknown as LibraryWindow).library.finishCatalog?.(),
    );
    await expect(
      page.getByRole("button", {
        name: "Refresh local items",
        exact: true,
      }),
    ).toBeEnabled();
  });

test("refresh failures retain private entries and retry discovery without syncing", async ({
  page,
}) => {
  await resourceLibraryFixture(page);
  await page.getByRole("button", { name: /^Sessions/ }).click();
  const privateItem = page.getByRole("button", {
    name: "Private session notes",
    exact: true,
  });
  await expect(privateItem).toBeVisible();
  await page.evaluate(() => {
    (window as unknown as LibraryWindow).library.failCatalog = true;
  });
  await page
    .getByRole("button", { name: "Refresh local items", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText(
    "Local folder temporarily unavailable",
  );
  await expect(privateItem).toBeVisible();
  await page.evaluate(() => {
    (window as unknown as LibraryWindow).library.failCatalog = false;
  });
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(
    page.getByText("Local sessions refreshed", { exact: true }),
  ).toBeVisible();
  await expect(privateItem).toBeVisible();
});

for (const { kind, label } of kinds) {
  for (const width of [1160, 900]) {
    test(`${label} discovery banner keeps its action left and reports retry outcomes at ${width}px`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: width === 900 ? 640 : 800 });
      await resourceLibraryFixture(page);
      await page.getByRole("button", { name: new RegExp(`^${label}`) }).click();
      const item = page.getByRole("button", {
        name: `Private ${kind} notes`,
        exact: true,
      });
      await expect(item).toBeVisible();
      await page.evaluate(() => {
        const library = (window as unknown as LibraryWindow).library;
        library.failCatalog = true;
        library.catalogError =
          "A sync or project operation is in progress. Wait for it to finish and try again.";
      });
      await page
        .getByRole("button", { name: "Refresh local items", exact: true })
        .click();
      const banner = page.locator(".resource-discovery-status");
      await expect(banner.getByRole("alert")).toContainText(
        "A sync or project operation is in progress",
      );
      const action = banner.getByRole("button", {
        name: "Try again",
        exact: true,
      });
      await expect(action).toBeEnabled();
      const geometry = await banner.evaluate((element) => {
        const style = getComputedStyle(element);
        const left =
          element.getBoundingClientRect().left +
          parseFloat(style.borderLeftWidth) +
          parseFloat(style.paddingLeft);
        return {
          left,
          button: element.querySelector("button")!.getBoundingClientRect().left,
          border: style.borderTopWidth,
          overflow: element.scrollWidth > element.clientWidth,
        };
      });
      expect(geometry.border).toBe("1px");
      expect(Math.abs(geometry.left - geometry.button)).toBeLessThanOrEqual(1);
      expect(geometry.overflow).toBe(false);
      const search = page.getByRole("searchbox", {
        name: `Search ${label.toLowerCase()}`,
      });
      await search.fill("Mira");
      await expect(banner).toBeVisible();
      await search.clear();
      await expect(banner).toBeVisible();
      await page.evaluate(() => {
        (window as unknown as LibraryWindow).library.deferCatalog = true;
      });
      await action.focus();
      await page.keyboard.press("Enter");
      await expect(
        banner.getByRole("button", { name: "Checking…", exact: true }),
      ).toBeDisabled();
      await expect(banner.getByRole("status")).toContainText(
        `Checking local ${label.toLowerCase()}…`,
      );
      await expect(banner).not.toContainText("A sync or project operation");
      await expect(item).toBeVisible();
      await page.evaluate(() =>
        (window as unknown as LibraryWindow).library.finishCatalog?.(),
      );
      await expect(action).toBeEnabled();
      await expect(banner.getByRole("alert")).toContainText(
        `Couldn’t refresh local ${label.toLowerCase()}`,
      );
      await page.evaluate(() => {
        (window as unknown as LibraryWindow).library.failCatalog = false;
      });
      await action.click();
      await expect(
        banner.getByRole("button", { name: "Checking…", exact: true }),
      ).toBeDisabled();
      await page.evaluate(() =>
        (window as unknown as LibraryWindow).library.finishCatalog?.(),
      );
      await expect(banner).toHaveCount(0);
      await expect(
        page.getByText(`Local ${label.toLowerCase()} refreshed`, {
          exact: true,
        }),
      ).toBeVisible();
      await expect(item).toBeVisible();
      const calls = await page.evaluate(
        () => (window as unknown as LibraryWindow).library.calls,
      );
      expect(
        calls.filter(
          (call) =>
            call.command === "local_resource_catalog" &&
            call.args.refresh !== false,
        ),
      ).toHaveLength(4);
      expect(
        calls.some((call) =>
          /^(sync_now|cloud_action|session_action|set_project_sharing)$/.test(
            call.command,
          ),
        ),
      ).toBe(false);
    });
  }
}

test("empty discovery failures explain the error and offer a retry", async ({
  page,
}) => {
  await resourceLibraryFixture(page, { emptyShared: true, emptyLocal: true });
  await page.evaluate(() => {
    (window as unknown as LibraryWindow).library.catalogErrors = [
      "Could not read the project folder.",
    ];
  });
  await page.getByRole("button", { name: /^Plans/ }).click();
  const plans = page.getByRole("region", { name: "plans", exact: true });
  const empty = plans.getByRole("heading", { name: "No plans yet" });
  await expect(
    plans.getByRole("heading", { name: "Couldn’t load plans" }),
  ).toBeVisible();
  await expect(plans.getByRole("status")).toContainText(
    "Orka couldn’t check this Mac for plans.",
  );
  await plans.getByText("Details", { exact: true }).click();
  await expect(
    plans.getByText("Could not read the project folder."),
  ).toBeVisible();
  await expect(plans.getByText("Previously discovered items")).toHaveCount(0);
  await expect(plans.getByRole("searchbox")).toHaveCount(0);
  await expect(empty).toHaveCount(0);

  await page.evaluate(() => {
    (window as unknown as LibraryWindow).library.catalogErrors = [];
  });
  await plans.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(empty).toBeVisible();
  await expect(
    plans.getByRole("heading", { name: "Couldn’t load plans" }),
  ).toHaveCount(0);
});

test("partial discovery errors wrap inside the banner with the sidebar collapsed", async ({
  page,
}) => {
  await page.setViewportSize({ width: 900, height: 640 });
  await resourceLibraryFixture(page);
  await page.evaluate(() => {
    (window as unknown as LibraryWindow).library.catalogErrors = [
      `Could not read /synthetic/${"long-folder-name/".repeat(30)}plans`,
      "One repository is temporarily unavailable.",
    ];
  });
  await page.getByRole("button", { name: /^Plans/ }).click();
  const banner = page.locator(".resource-discovery-status");
  await expect(banner).toContainText(
    "One repository is temporarily unavailable.",
  );
  await page
    .getByRole("button", { name: "Collapse sidebar", exact: true })
    .click();
  expect(
    await banner.evaluate(
      (element) => element.scrollWidth <= element.clientWidth,
    ),
  ).toBe(true);
  await expect(
    page.getByRole("button", { name: "Private plan notes", exact: true }),
  ).toBeVisible();
  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations).toEqual([]);
});

test("restricted shared access does not suppress independent local content", async ({
  page,
}) => {
  await resourceLibraryFixture(page, { emptyShared: true, restricted: true });
  await page.getByRole("button", { name: /^Memories/ }).click();
  await expect(
    page.getByRole("button", { name: "Private memory notes", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("searchbox", { name: "Search memories" }),
  ).toBeVisible();
});

test("an account change discards a late private catalog response", async ({
  page,
}) => {
  await page.clock.install();
  await resourceLibraryFixture(page, { emptyShared: true, defer: true });
  await page.getByRole("button", { name: /^Sessions/ }).click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as LibraryWindow).library.finishCatalogs.length,
      ),
    )
    .toBe(1);
  await page.evaluate(() => {
    (window as unknown as LibraryWindow).library.user = "other-account";
  });
  await page.clock.runFor(3100);
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as LibraryWindow).library.finishCatalogs.length,
      ),
    )
    .toBe(2);
  await page.evaluate(() =>
    (window as unknown as LibraryWindow).library.finishCatalogs[0](),
  );
  await expect(
    page.getByRole("button", { name: "Private session notes", exact: true }),
  ).toHaveCount(0);
});

test("new private session turns refresh without a published revision", async ({
  page,
}) => {
  await page.clock.install();
  await resourceLibraryFixture(page);
  await page.getByRole("button", { name: /^Sessions/ }).click();
  await page
    .getByRole("button", { name: "Private session notes", exact: true })
    .click();
  await expect(page.getByLabel("Conversation", { exact: true })).toContainText(
    "Private session conversation 0",
  );
  await page.evaluate(() => {
    (window as unknown as LibraryWindow).library.tail = 1;
  });
  await page.clock.runFor(60_100);
  await expect(page.getByLabel("Conversation", { exact: true })).toContainText(
    "Private session conversation 1",
  );
});

test("configured sync timing refreshes local-only rows without clearing collection counts", async ({
  page,
}) => {
  await page.clock.install();
  await resourceLibraryFixture(page);
  const sessions = page.getByRole("button", { name: /^Sessions/ });
  await sessions.click();
  const table = page.getByRole("table");
  await expect(table.locator("tbody tr")).toHaveCount(4);
  await expect(sessions).toContainText("4");
  const catalogs = () =>
    page.evaluate(() =>
      (window as unknown as LibraryWindow).library.calls.filter(
        (call) =>
          call.command === "local_resource_catalog" &&
          call.args.refresh !== false,
      ),
    );
  await page.evaluate(() => {
    (window as unknown as LibraryWindow).library.syncMinutes = 5;
  });
  await page.clock.runFor(63_100);
  expect(await catalogs()).toHaveLength(1);
  await page.evaluate(() => {
    const library = (window as unknown as LibraryWindow).library;
    library.deferCatalog = true;
    library.syncMinutes = 1;
  });
  await page.clock.runFor(3_100);
  await expect.poll(async () => (await catalogs()).length).toBe(2);
  await expect(table.locator("tbody tr")).toHaveCount(4);
  await expect(sessions).toContainText("4");
  await expect(
    page.getByRole("button", { name: "Private session notes", exact: true }),
  ).toBeEnabled();
  const calls = await page.evaluate(
    () => (window as unknown as LibraryWindow).library.calls,
  );
  expect(
    calls.filter((call) =>
      /^(sync_now|cloud_action|set_project_sharing)$/.test(call.command),
    ),
  ).toEqual([]);
  await page.evaluate(() =>
    (window as unknown as LibraryWindow).library.finishCatalog?.(),
  );
  await expect(table.locator("tbody tr")).toHaveCount(4);
  await expect(sessions).toContainText("4");
});

for (const { kind, label } of kinds)
  test(`${label} lists a large collection in one scrolling list`, async ({
    page,
  }) => {
    await resourceLibraryFixture(page, {
      extraRows: 50,
      emptyLocal: true,
      defer: true,
    });
    await page.getByRole("button", { name: new RegExp(`^${label}`) }).click();
    const table = page.getByRole("table");
    const rows = table.locator("tbody tr");
    await expect(rows).toHaveCount(52);
    await expect(page.getByRole("navigation", { name: /pages$/ })).toHaveCount(
      0,
    );
    const item = table.getByRole("button", {
      name: `Archive ${kind} 49`,
      exact: true,
    });
    await item.scrollIntoViewIfNeeded();
    await item.press("Enter");
    await page
      .getByRole("button", { name: `Back to ${label}`, exact: true })
      .click();
    await expect(item).toBeFocused();
    await expect(item).toBeInViewport();
    const search = page.getByRole("searchbox", {
      name: `Search ${label.toLowerCase()}`,
    });
    await search.fill(`Archive ${kind} 1`);
    await expect(rows).toHaveCount(11);
    await search.clear();
    await expect(rows).toHaveCount(52);
  });

test("a session fork lists flat with a marker after its title", async ({
  page,
}) => {
  await resourceLibraryFixture(page, {
    extraRows: 50,
    emptyLocal: true,
    boundaryFork: true,
  });
  await page.getByRole("button", { name: /^Sessions/ }).click();
  const fork = page.getByRole("button", {
    name: "Archived session fork",
    exact: true,
  });
  const row = page.getByRole("row", { name: /Archived session fork/ });
  await expect(row.getByRole("img", { name: "Forked session" })).toBeVisible();
  await expect(
    page.getByRole("row", { name: /Archive session 37/ }).getByRole("img", {
      name: "Forked session",
    }),
  ).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Expand/ })).toHaveCount(0);
  await fork.click();
  await page.getByRole("button", { name: "Back to Sessions" }).click();
  await expect(fork).toBeFocused();
});

test("a focused session stays focused when its display title moves it", async ({
  page,
}) => {
  await resourceLibraryFixture(page, {
    extraRows: 50,
    emptyLocal: true,
    deferredTitleId: "session-extra-0",
  });
  await page.getByRole("button", { name: /^Sessions/ }).click();
  await page.getByRole("button", { name: /^Sort/ }).click();
  await page.getByRole("menuitemradio", { name: "Name", exact: true }).click();
  const item = page.locator('[data-resource-id="session-extra-0"]');
  await item.focus();
  await expect(item).toBeFocused();
  await page.waitForFunction(
    () => (window as unknown as LibraryWindow).library.finishTitle,
  );
  await page.evaluate(() =>
    (window as unknown as LibraryWindow).library.finishTitle?.("Zulu Page B"),
  );
  await expect(item).toHaveText("Zulu Page B");
  await expect(page.locator(".index-table-open").last()).toHaveText(
    "Zulu Page B",
  );
  await expect(item).toBeFocused();
});

for (const mode of ["keyboard focus", "an open menu"] as const) {
  test(`a session with ${mode} remains reachable when discovery adds its fork parent`, async ({
    page,
  }) => {
    await resourceLibraryFixture(page, {
      defer: true,
      extraRows: 1,
      nativeForkAfterRefresh: true,
    });
    await page.getByRole("button", { name: /^Sessions/ }).click();
    const fork = page.getByRole("button", {
      name: "My shared session",
      exact: true,
    });
    const row = fork.locator("xpath=ancestor::tr");
    const menu = page.getByRole("menu");
    if (mode === "keyboard focus") {
      await fork.focus();
      await expect(fork).toBeFocused();
    } else {
      await row
        .getByRole("button", { name: "Actions for My shared session" })
        .press("Enter");
      await expect(menu).toBeVisible();
    }
    await page.waitForFunction(
      () => (window as unknown as LibraryWindow).library.finishCatalog,
    );
    await page.evaluate(() =>
      (window as unknown as LibraryWindow).library.finishCatalog?.(),
    );
    await expect(row).toContainText("Local edits");
    if (mode === "keyboard focus") {
      await expect(fork).toBeFocused();
    } else {
      await expect(menu).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(menu).toBeHidden();
    }
    await page.getByRole("searchbox", { name: "Search sessions" }).focus();
    await expect(
      row.getByRole("img", { name: "Forked session" }),
    ).toBeVisible();
  });
}

for (const mode of ["button", "context menu"] as const) {
  test(`an open resource ${mode} stays available when its session moves`, async ({
    page,
  }) => {
    await resourceLibraryFixture(page, {
      extraRows: 50,
      emptyLocal: true,
      deferredTitleId: "session-extra-0",
    });
    await page.getByRole("button", { name: /^Sessions/ }).click();
    await page.getByRole("button", { name: /^Sort/ }).click();
    await page
      .getByRole("menuitemradio", { name: "Name", exact: true })
      .click();
    const item = page.locator('[data-resource-id="session-extra-0"]');
    if (mode === "button")
      await page
        .getByRole("button", {
          name: "Actions for Archive session 0",
          exact: true,
        })
        .press("Enter");
    else await item.press("Shift+F10");

    const menu = page.getByRole("menu");
    await expect(menu).toBeVisible();
    await page.waitForFunction(
      () => (window as unknown as LibraryWindow).library.finishTitle,
    );
    await page.evaluate(() =>
      (window as unknown as LibraryWindow).library.finishTitle?.("Zulu Page B"),
    );
    await expect(item).toHaveText("Zulu Page B");
    await expect(menu).toBeVisible();
    await menu.getByRole("menuitem", { name: "Open", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "Back to Sessions" }),
    ).toBeVisible();
  });
}
