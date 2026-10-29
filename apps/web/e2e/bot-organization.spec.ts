import { expect, test } from "@playwright/test";
import {
  activeBotId,
  captureScreenshot,
  completeOnboarding,
  createIsolatedSpace,
  openUserSettings,
  rpc,
  signup,
  spaceRoster,
} from "./helpers";

/**
 * A test's own Space keeps its roster, sections, and groups out of other
 * specs'; group keys carry the Space id once the sidebar lists more than one.
 */
function spaceGroup(page: import("@playwright/test").Page, spaceId: string, key: string) {
  return page.locator(`[data-sidebar-group="space:${spaceId}:${key}"]`);
}

function spaceSectionGroups(page: import("@playwright/test").Page, spaceId: string) {
  return page.locator(`[data-sidebar-group^="space:${spaceId}:section:"]`);
}

test("pinned bots and sidebar sections persist", async ({ page }, testInfo) => {
  const stamp = Date.now();
  const spaceId = await createIsolatedSpace(page, `bot organize ${stamp}`);
  await signup(page, `bot-organize-${stamp}@rakazo.test`, "password12", "Test User");
  await completeOnboarding(page);
  await page.goto("/app");
  await page.waitForURL(/\/app\/[^/]+$/);

  const sidebar = spaceRoster(page, spaceId);
  const bot = sidebar.getByRole("button", { name: /^Chief/ });

  await bot.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Pin", exact: true }).click();
  await expect(spaceGroup(page, spaceId, "pinned")).toContainText("Chief");
  await captureScreenshot(page, testInfo, "pinned-bots");

  await bot.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Unpin", exact: true }).click();
  await expect(spaceGroup(page, spaceId, "pinned")).toHaveCount(0);

  await bot.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Move to", exact: true }).hover();
  const moveMenu = page.getByRole("menu", { name: "Move to", exact: true });
  await expect(moveMenu).toBeVisible();
  await captureScreenshot(page, testInfo, "move-to-section-menu");
  await moveMenu.getByText("New section").click();
  const dialog = page.getByRole("dialog", { name: "New section" });
  await dialog.getByLabel("Name").fill("Projects");
  await dialog.getByRole("button", { name: "Create" }).click();

  const projects = spaceSectionGroups(page, spaceId);
  await expect(projects).toContainText("Projects");
  await expect(projects).toContainText("Chief");
  await captureScreenshot(page, testInfo, "bot-sections");

  await page.reload();
  await expect(projects).toContainText("Projects");
  await expect(projects).toContainText("Chief");

  await bot.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Move to", exact: true }).hover();
  await page
    .getByRole("menu", { name: "Move to", exact: true })
    .getByRole("menuitem", { name: "Rename section", exact: true })
    .click();
  const renameDialog = page.getByRole("dialog", { name: "Rename section" });
  await renameDialog.getByLabel("Name").fill("Delivery");
  await captureScreenshot(page, testInfo, "rename-bot-section");
  await renameDialog.getByRole("button", { name: "Save" }).click();
  await expect(projects).toContainText("Delivery");
  await expect(projects).not.toContainText("Projects");

  await bot.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Move to", exact: true }).hover();
  await page
    .getByRole("menu", { name: "Move to", exact: true })
    .getByRole("menuitem", { name: "Unassigned", exact: true })
    .click();
  await expect(spaceGroup(page, spaceId, "unassigned")).toContainText("Chief");
});

test("deleting a section keeps its bots and groups", async ({ page }, testInfo) => {
  const spaceId = await createIsolatedSpace(page, `section delete ${Date.now()}`);
  const spaceHeaders = { "x-rakazo-space-id": spaceId };
  await signup(page, `section-delete-${Date.now()}@rakazo.test`, "password12", "Section Delete");
  await completeOnboarding(page);
  const chiefId = activeBotId(page);
  const alpha = await rpc<{ id: string }>(
    page,
    "bots/create",
    { name: "Alpha", computerMode: "team" },
    spaceHeaders,
  );
  const section = await rpc<{ id: string }>(
    page,
    "botSections/create",
    { botId: alpha.id, name: "Projects" },
    spaceHeaders,
  );
  await rpc(page, "bots/update", { botId: chiefId, sectionId: section.id }, spaceHeaders);
  const group = await rpc<{ id: string }>(
    page,
    "groups/create",
    { name: "Review room", botIds: [chiefId, alpha.id] },
    spaceHeaders,
  );
  await rpc(page, "groups/update", { groupId: group.id, sectionId: section.id }, spaceHeaders);
  await page.reload();

  const sidebar = spaceRoster(page, spaceId);
  const sectionRows = spaceGroup(page, spaceId, `section:${section.id}`);
  await sectionRows
    .getByRole("button", { name: /(?:Collapse|Expand) .*Projects/ })
    .click({ button: "right" });
  await page
    .getByRole("menu", { name: "Actions for Projects" })
    .getByRole("menuitem", { name: "Delete section", exact: true })
    .click();
  const dialog = page.getByRole("alertdialog", { name: "Delete Projects?" });
  await expect(dialog).toContainText("Its bots and groups are kept and leave the section.");
  await captureScreenshot(page, testInfo, "delete-section-dialog");
  await dialog.getByRole("button", { name: "Delete", exact: true }).click();

  await expect(sectionRows).toHaveCount(0);
  for (const id of [chiefId, alpha.id]) {
    await expect(sidebar.locator(`[data-roster-bot-id="${id}"]`)).toBeVisible();
  }
  await expect(sidebar.getByRole("button", { name: /^Review room/ })).toBeVisible();
  await captureScreenshot(page, testInfo, "section-deleted");
});

test("an empty section can be deleted after its last bot leaves", async ({ page }, testInfo) => {
  const spaceId = await createIsolatedSpace(page, `empty section ${Date.now()}`);
  const spaceHeaders = { "x-rakazo-space-id": spaceId };
  await signup(page, `empty-section-${Date.now()}@rakazo.test`, "password12", "Empty Section");
  await completeOnboarding(page);
  const botId = activeBotId(page);
  const section = await rpc<{ id: string }>(
    page,
    "botSections/create",
    { botId, name: "Old ideas" },
    spaceHeaders,
  );
  await rpc(page, "bots/update", { botId, sectionId: null }, spaceHeaders);
  await page.reload();
  const sidebar = spaceRoster(page, spaceId);
  const heading = spaceGroup(page, spaceId, `section:${section.id}`);
  await heading
    .getByRole("button", { name: /(?:Collapse|Expand) .*Old ideas/ })
    .click({ button: "right" });
  await page.getByRole("menuitem", { name: "Delete section", exact: true }).click();
  const dialog = page.getByRole("alertdialog", { name: "Delete Old ideas?" });
  await captureScreenshot(page, testInfo, "delete-empty-section");
  await dialog.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(heading).toHaveCount(0);
  await expect(sidebar.locator(`[data-roster-bot-id="${botId}"]`)).toBeVisible();
});

test("bots can be reordered by drag or keyboard and keep that order", async ({ page }) => {
  const stamp = Date.now();
  // Order assertions must see only this Space's roster.
  const spaceId = await createIsolatedSpace(page, `bot reorder ${stamp}`);
  const spaceHeaders = { "x-rakazo-space-id": spaceId };
  await signup(page, `bot-reorder-${stamp}@rakazo.test`, "password12", "Bot Order");
  await completeOnboarding(page);
  await page.goto("/app");
  await page.waitForURL(/\/app\/[^/]+$/);

  const chiefId = activeBotId(page);
  const alpha = await rpc<{ id: string }>(
    page,
    "bots/create",
    {
      name: "Alpha",
      title: "",
      description: "",
      instructions: "",
      notifyOnFinish: true,
      computerMode: "team",
    },
    spaceHeaders,
  );
  const beta = await rpc<{ id: string }>(
    page,
    "bots/create",
    {
      name: "Beta",
      title: "",
      description: "",
      instructions: "",
      notifyOnFinish: true,
      computerMode: "team",
    },
    spaceHeaders,
  );
  await page.reload();

  const sidebar = spaceRoster(page, spaceId);
  const rows = sidebar.locator("[data-roster-bot-id]");
  const order = () =>
    rows.evaluateAll((items) => items.map((item) => item.getAttribute("data-roster-bot-id")));
  await expect.poll(order).toEqual([chiefId, alpha.id, beta.id]);

  let releaseStaleList!: () => void;
  let markStaleListReady!: () => void;
  let markStaleListDelivered!: () => void;
  const staleListReady = new Promise<void>((resolve) => {
    markStaleListReady = resolve;
  });
  const staleListDelivered = new Promise<void>((resolve) => {
    markStaleListDelivered = resolve;
  });
  const staleListGate = new Promise<void>((resolve) => {
    releaseStaleList = resolve;
  });
  let interceptedList = false;
  await page.route("**/rpc/spaces/list", async (route) => {
    if (interceptedList) {
      await route.continue();
      return;
    }
    interceptedList = true;
    const staleResponse = await route.fetch();
    markStaleListReady();
    await staleListGate;
    await route.fulfill({ response: staleResponse });
    markStaleListDelivered();
  });
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await staleListReady;

  const reorderSaved = page.waitForResponse(
    (response) => response.url().includes("/rpc/bots/reorder") && response.ok(),
  );
  await sidebar
    .locator(`[data-roster-bot-id="${beta.id}"]`)
    .dragTo(sidebar.locator(`[data-roster-bot-id="${chiefId}"]`));
  await reorderSaved;
  releaseStaleList();
  await staleListDelivered;
  await expect.poll(order).toEqual([beta.id, chiefId, alpha.id]);
  await page.reload();
  await expect.poll(order).toEqual([beta.id, chiefId, alpha.id]);

  const betaRow = sidebar.locator(`[data-roster-bot-id="${beta.id}"]`);
  await betaRow.focus();
  await page.keyboard.press("Alt+ArrowDown");
  await expect.poll(order).toEqual([chiefId, beta.id, alpha.id]);
  await page.reload();
  await expect.poll(order).toEqual([chiefId, beta.id, alpha.id]);

  let releaseRejectedReorder!: () => void;
  let markRejectedReorderStarted!: () => void;
  const rejectedReorderStarted = new Promise<void>((resolve) => {
    markRejectedReorderStarted = resolve;
  });
  const rejectReorder = new Promise<void>((resolve) => {
    releaseRejectedReorder = resolve;
  });
  await page.route(
    "**/rpc/bots/reorder",
    async (route) => {
      markRejectedReorderStarted();
      await rejectReorder;
      await route.fulfill({ status: 500, contentType: "application/json", body: "{}" });
    },
    { times: 1 },
  );
  await sidebar
    .locator(`[data-roster-bot-id="${alpha.id}"]`)
    .dragTo(sidebar.locator(`[data-roster-bot-id="${chiefId}"]`));
  await rejectedReorderStarted;

  const queuedReorderSaved = page.waitForResponse(
    (response) => response.url().includes("/rpc/bots/reorder") && response.ok(),
  );
  await sidebar
    .locator(`[data-roster-bot-id="${beta.id}"]`)
    .dragTo(sidebar.locator(`[data-roster-bot-id="${alpha.id}"]`));
  releaseRejectedReorder();
  await queuedReorderSaved;
  await expect.poll(order).toEqual([beta.id, alpha.id, chiefId]);
  await page.reload();
  await expect.poll(order).toEqual([beta.id, alpha.id, chiefId]);
});

test("chat composer controls are vertically centered", async ({ page }, testInfo) => {
  const stamp = Date.now();
  await signup(page, `composer-layout-${stamp}@rakazo.test`, "password12", "Composer Layout");
  await completeOnboarding(page);

  const bar = page.getByTestId("composer-bar");
  const composer = page.getByRole("combobox", { name: "Message Chief" });
  const centers = await bar.evaluate((composerBar) =>
    ["Attach file", "Message Chief", "Hold to talk", "Send"].map((label) => {
      const element = composerBar.querySelector<HTMLElement>(`[aria-label="${label}"]`);
      if (!element) throw new Error(`Missing composer control: ${label}`);
      const box = element.getBoundingClientRect();
      return box.top + box.height / 2;
    }),
  );

  expect(Math.max(...centers) - Math.min(...centers)).toBeLessThanOrEqual(1);

  await composer.fill("Short note");
  await expect(bar).toHaveAttribute("data-expanded", "false");
  await captureScreenshot(page, testInfo, "composer-one-line");

  const wrappedDraft =
    "This draft is long enough to wrap onto its own row above the controls. ".repeat(16);
  await composer.fill(wrappedDraft);
  await expect(bar).toHaveAttribute("data-expanded", "true");
  // The field moves up from the one-line slot; its box overlaps the controls until that finishes.
  await expect
    .poll(() =>
      bar.evaluate((composerBar) => {
        const field = composerBar.querySelector("textarea")?.parentElement ?? null;
        return [composerBar, field].every(
          (element) =>
            element?.getAnimations().every((animation) => animation.playState !== "running") ??
            true,
        );
      }),
    )
    .toBe(true);
  const fieldBox = await composer.evaluate((element) => ({
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight,
    bottom: element.getBoundingClientRect().bottom,
  }));
  const sendTop = await bar
    .getByRole("button", { name: "Send", exact: true })
    .evaluate((element) => element.getBoundingClientRect().top);
  expect(fieldBox.scrollHeight).toBeGreaterThan(fieldBox.clientHeight);
  expect(fieldBox.clientHeight).toBeLessThanOrEqual(104);
  // Round both edges; a fractional bottom can sit just under a pixel past the slack.
  expect(Math.round(fieldBox.bottom)).toBeLessThanOrEqual(Math.round(sendTop) + 2);
  await captureScreenshot(page, testInfo, "composer-wrapped");
  await page.evaluate(
    () =>
      new Promise((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(resolve));
      }),
  );
  await expect(bar).toHaveAttribute("data-expanded", "true");

  await composer.fill("");
  await expect(composer).toHaveValue("");
  await expect(bar).toHaveAttribute("data-expanded", "false");

  await composer.fill(wrappedDraft);
  await expect(bar).toHaveAttribute("data-expanded", "true");
  await composer.press("Enter");
  await expect(composer).toHaveValue("");
  await expect(bar).toHaveAttribute("data-expanded", "false");
});

test("group chats share every context-menu action", async ({ page }, testInfo) => {
  const stamp = Date.now();
  const spaceId = await createIsolatedSpace(page, `group menu ${stamp}`);
  const spaceHeaders = { "x-rakazo-space-id": spaceId };
  await signup(page, `group-organize-${stamp}@rakazo.test`, "password12", "Group Menu");
  await completeOnboarding(page);
  await page.goto("/app");
  await page.waitForURL(/\/app\/[^/]+$/);

  const chiefId = activeBotId(page);
  const partner = await rpc<{ id: string }>(
    page,
    "bots/create",
    {
      name: "Partner",
      title: "",
      description: "",
      instructions: "",
      notifyOnFinish: true,
      computerMode: "team",
    },
    spaceHeaders,
  );
  await rpc(
    page,
    "groups/create",
    { name: "Group menu", botIds: [chiefId, partner.id] },
    spaceHeaders,
  );
  await page.reload();

  const sidebar = spaceRoster(page, spaceId);
  const group = sidebar.getByRole("button", { name: /^Group menu/ });
  await group.click({ button: "right" });
  for (const action of [
    "Pin",
    "Move to",
    "Mark as Unread",
    "Edit Profile",
    "Duplicate",
    "Clear conversation",
    "Archive",
    "Delete",
  ]) {
    await expect(page.getByRole("menuitem", { name: action, exact: true })).toBeVisible();
  }
  await captureScreenshot(page, testInfo, "group-context-menu-desktop");

  await page.getByRole("menuitem", { name: "Mark as Unread", exact: true }).click();
  await group.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Mark as Read", exact: true }).click();

  await group.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Pin", exact: true }).click();
  await expect(spaceGroup(page, spaceId, "pinned")).toContainText("Group menu");

  await group.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Unpin", exact: true }).click();
  await group.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Move to", exact: true }).hover();
  await page
    .getByRole("menu", { name: "Move to", exact: true })
    .getByRole("menuitem", { name: "New section", exact: true })
    .click();
  const sectionDialog = page.getByRole("dialog", { name: "New section" });
  await sectionDialog.getByLabel("Name").fill("Teams");
  await sectionDialog.getByRole("button", { name: "Create" }).click();
  await expect(spaceSectionGroups(page, spaceId)).toContainText("Group menu");

  await group.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Clear conversation", exact: true }).click();
  await expect(
    page.getByRole("alertdialog", { name: "Clear Group menu’s conversation?" }),
  ).toBeVisible();
  await captureScreenshot(page, testInfo, "group-clear-conversation-confirmation");
  await page.getByRole("button", { name: "Clear", exact: true }).click();
  await expect(
    page.getByRole("alertdialog", { name: "Clear Group menu’s conversation?" }),
  ).toHaveCount(0);

  await group.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Duplicate", exact: true }).click();
  const copy = sidebar.getByRole("button", { name: /^Group menu copy/ });
  await expect(copy).toBeVisible();

  await copy.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Delete", exact: true }).click();
  await expect(page.getByRole("alertdialog", { name: "Delete Group menu copy?" })).toBeVisible();
  await page.getByRole("button", { name: "Cancel" }).click();

  await copy.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Archive", exact: true }).click();
  await expect(sidebar.getByRole("button", { name: /^Group menu copy/ })).toHaveCount(0);
  // The Archived fold-out is not a roster group; it sits directly in the aside.
  await expect(page.locator("aside").first().getByText("Archived", { exact: true })).toBeVisible();

  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Open navigation" }).click();
  await group.click({ button: "right" });
  await captureScreenshot(page, testInfo, "group-context-menu-mobile");
  await page.keyboard.press("Escape");
  await page.setViewportSize({ width: 1280, height: 800 });

  await group.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Edit Profile", exact: true }).click();
  await expect(page.getByTestId("side-panel")).toHaveAttribute("data-panel", "group-settings");
});

test("built-in sidebar headings follow the language without renaming custom sections", async ({
  page,
}, testInfo) => {
  const localeSpaceId = await createIsolatedSpace(page, `section locale ${Date.now()}`);
  await signup(page, `section-locale-${Date.now()}@rakazo.test`, "password12", "Locale QA");
  await completeOnboarding(page);
  const sidebar = spaceRoster(page, localeSpaceId);
  const bot = sidebar.getByRole("button", { name: /^Chief/ });
  await bot.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Move to", exact: true }).hover();
  await page.getByRole("menu", { name: "Move to", exact: true }).getByText("New section").click();
  const dialog = page.getByRole("dialog", { name: "New section" });
  await dialog.getByLabel("Name").fill("Pinned");
  await dialog.getByRole("button", { name: "Create", exact: true }).click();
  await bot.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Pin", exact: true }).click();
  const settings = await openUserSettings(page);
  await settings.getByTestId("ui-locale-select").click();
  await page.getByRole("option", { name: "Deutsch", exact: true }).click();
  await page.getByRole("button", { name: "Benutzereinstellungen schließen", exact: true }).click();
  await expect(settings).not.toBeVisible();
  await expect(spaceGroup(page, localeSpaceId, "pinned")).toContainText("Angeheftet");
  await expect(spaceGroup(page, localeSpaceId, "unassigned")).toContainText("Nicht zugewiesen");
  await expect(spaceSectionGroups(page, localeSpaceId)).toContainText("Pinned");
  await captureScreenshot(page, testInfo, "localized-sidebar-headings-de");
});
