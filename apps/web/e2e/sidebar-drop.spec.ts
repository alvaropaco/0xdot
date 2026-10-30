import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import {
  activeBotId,
  captureScreenshot,
  completeOnboarding,
  createIsolatedSpace,
  rpc,
  signup,
  spaceRoster,
  waitForSidebarTransitions,
} from "./helpers";

/**
 * The test runs in its own Space, so with at least two Spaces in the sidebar
 * every group key is prefixed with `space:<id>:` and group titles start with
 * the Space name. Plain `section:` keys or exact "Collapse Projects" button
 * names would resolve to nothing once another spec's Space exists.
 */
function spaceGroup(page: Page, spaceId: string, key: string) {
  return page.locator(`[data-sidebar-group="space:${spaceId}:${key}"]`);
}

test("drag bots into collapsed sections, another section's row, and group chats", async ({
  page,
}, testInfo) => {
  const stamp = Date.now();
  // The name avoids the "Side" substring spaces.spec filters rosters by.
  const spaceId = await createIsolatedSpace(page, `Drag drop ${stamp}`);
  const spaceHeaders = { "x-rakazo-space-id": spaceId };
  await signup(page, `sidebar-drop-${stamp}@rakazo.test`, "password12", "Sidebar Drop");
  await completeOnboarding(page);
  const chiefId = activeBotId(page);
  const alpha = await rpc<{ id: string }>(
    page,
    "bots/create",
    { name: "Alpha", computerMode: "team" },
    spaceHeaders,
  );
  const beta = await rpc<{ id: string }>(
    page,
    "bots/create",
    { name: "Beta", computerMode: "team" },
    spaceHeaders,
  );
  const section = await rpc<{ id: string }>(
    page,
    "botSections/create",
    { botId: alpha.id, name: "Projects" },
    spaceHeaders,
  );
  const group = await rpc<{ id: string }>(
    page,
    "groups/create",
    { name: "Review room", botIds: [alpha.id, beta.id] },
    spaceHeaders,
  );
  await page.reload();
  const sidebar = spaceRoster(page, spaceId);
  const sectionRows = spaceGroup(page, spaceId, `section:${section.id}`);
  const unassigned = spaceGroup(page, spaceId, "unassigned");
  const chief = sidebar.locator(`[data-roster-bot-id="${chiefId}"]`);
  await sectionRows.getByRole("button", { name: /Collapse .*Projects/ }).click();
  await waitForSidebarTransitions(page);
  await chief.dragTo(sectionRows.getByRole("button", { name: /Expand .*Projects/ }));
  await expect
    .poll(async () => {
      const bot = await rpc<{ sectionId: string | null }>(
        page,
        "bots/get",
        { botId: chiefId },
        spaceHeaders,
      );
      return bot.sectionId;
    })
    .toBe(section.id);
  await sectionRows.getByRole("button", { name: /Expand .*Projects/ }).click();
  await waitForSidebarTransitions(page);
  await expect(sectionRows.locator(`[data-roster-bot-id="${chiefId}"]`)).toBeVisible();
  await sidebar.locator(`[data-roster-bot-id="${beta.id}"]`).dragTo(chief);
  await expect(sectionRows.locator(`[data-roster-bot-id="${beta.id}"]`)).toBeVisible();
  await captureScreenshot(page, testInfo, "dragged-bots-in-section");
  // A failed save must leave the section assignment unchanged and surface an error.
  await page.route(
    "**/rpc/bots/update",
    async (route) => {
      await route.fulfill({ status: 500, contentType: "application/json", body: "{}" });
    },
    { times: 1 },
  );
  await chief.dragTo(unassigned.getByRole("button", { name: /Collapse .*Unassigned/ }));
  await expect(page.getByRole("alert").filter({ hasText: "Internal Server Error" })).toBeVisible();
  await expect(sectionRows.locator(`[data-roster-bot-id="${chiefId}"]`)).toBeVisible();
  // Moving the last bot out leaves an empty section as a usable drop target.
  await chief.dragTo(unassigned.getByRole("button", { name: /Collapse .*Unassigned/ }));
  await expect(unassigned.locator(`[data-roster-bot-id="${chiefId}"]`)).toBeVisible();
  await sidebar
    .locator(`[data-roster-bot-id="${alpha.id}"]`)
    .dragTo(unassigned.getByRole("button", { name: /Collapse .*Unassigned/ }));
  // Wait for the save and roster refresh before dragging a row whose position changes.
  await expect(unassigned.locator(`[data-roster-bot-id="${alpha.id}"]`)).toBeVisible();
  await sidebar
    .locator(`[data-roster-bot-id="${beta.id}"]`)
    .dragTo(unassigned.getByRole("button", { name: /Collapse .*Unassigned/ }));
  await expect(sectionRows.locator("[data-roster-bot-id]")).toHaveCount(0);
  await chief.dragTo(sectionRows.getByRole("button", { name: /Collapse .*Projects/ }));
  await expect(sectionRows.locator(`[data-roster-bot-id="${chiefId}"]`)).toBeVisible();
  // Joining a chat does not move the bot out of its section.
  await sidebar.getByRole("button", { name: /^Review room/ }).click();
  await chief.dragTo(sidebar.getByRole("button", { name: /^Review room/ }));
  await expect
    .poll(async () => {
      const room = await rpc<{ members: { botId: string }[] }>(
        page,
        "groups/get",
        { groupId: group.id },
        spaceHeaders,
      );
      return room.members.map((member) => member.botId).sort();
    })
    .toEqual([alpha.id, beta.id, chiefId].sort());
  await page.reload();
  await expect(sectionRows.locator(`[data-roster-bot-id="${chiefId}"]`)).toBeVisible();
  await captureScreenshot(page, testInfo, "dragged-bot-joins-group");
});
