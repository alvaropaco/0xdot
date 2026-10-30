import type { Locator } from "@playwright/test";
import { expect, test } from "@playwright/test";
import {
  activeBotId,
  captureScreenshot,
  completeOnboarding,
  createIsolatedSpace,
  signup,
  spaceRoster,
} from "./helpers";

/** Rows of one roster scope (this Space's groups only), matched by bot name. */
function rosterRow(root: Locator, name: RegExp) {
  return root.locator("[data-roster-bot-id]").filter({
    has: root.page().locator("[data-roster-bot-name]").filter({ hasText: name }),
  });
}

test("created bots appear as regular bots and reorder across their creator", async ({
  page,
}, testInfo) => {
  const stamp = Date.now();
  // Own Space: the sidebar lists every Space's roster, and concurrent specs'
  // Chiefs and Scouts would strict-mode these row lookups and exact counts.
  const spaceId = await createIsolatedSpace(page, `Created bots ${stamp}`);
  await signup(page, `created-bots-${stamp}@rakazo.test`, "password12", "Test User");
  await completeOnboarding(page);
  const chiefId = activeBotId(page);

  const composer = page.locator('textarea[name="chat-message"]');
  await composer.fill("spawn a bot named Scout to research venues");
  await page.keyboard.press("Enter");

  const sidebar = spaceRoster(page, spaceId);
  const scout = rosterRow(sidebar, /Scout/);
  const chief = sidebar.locator(`[data-roster-bot-id="${chiefId}"]`);
  await expect(scout).toBeVisible({ timeout: 30_000 });
  await expect(chief).toBeVisible();
  await expect(sidebar.getByRole("button", { name: /^(Collapse|Expand) Chief$/ })).toHaveCount(0);
  // Both rows use the same inset; creation provenance must not indent a bot.
  const inset = (row: ReturnType<typeof rosterRow>) =>
    row.evaluate((element) => getComputedStyle(element).paddingInlineStart);
  expect(await inset(scout)).toEqual(await inset(chief));
  await page.locator("aside").first().getByPlaceholder("Search").hover();
  await captureScreenshot(page, testInfo, "sidebar-created-bots");

  await page.reload();
  await expect(scout).toBeVisible();
  await expect(chief).toBeVisible();

  const rosterOrder = () => sidebar.locator("[data-roster-bot-name]").allTextContents();
  const before = await rosterOrder();
  expect(before).toHaveLength(2);
  const last = before[1] === "Scout" ? scout : chief;
  await last.focus();
  await page.keyboard.press("Alt+ArrowUp");
  await expect.poll(rosterOrder).toEqual([before[1], before[0]]);

  await scout.click();
  await expect(page).toHaveURL(/\/app\/[^/]+$/);
  await expect(page.getByPlaceholder("Message Scout")).toBeVisible();
});
