import { expect, test } from "@playwright/test";
import {
  captureScreenshot,
  completeOnboarding,
  openNewSpace,
  rpc,
  signup,
  spaceRoster,
} from "./helpers";

test("the only space is named in the sidebar and chat creation requires approval", async ({
  page,
}, testInfo) => {
  const stamp = Date.now();
  await signup(page, `spaces-${stamp}@rakazo.test`, "password12", "Space Owner");
  await completeOnboarding(page);
  // The sidebar lists every Space the shard's owner has, so the Personal
  // Space's rows are scoped by id (captured before any other Space exists).
  const nav1 = await rpc<{ current: { id: string } }>(page, "spaces/list", {});
  const personalSpaceId = nav1.current.id;
  const personalRoster = spaceRoster(page, personalSpaceId);

  const sidebar = page.locator("aside").first();
  await expect(personalRoster.getByText("Personal").first()).toBeVisible();
  await expect(personalRoster.getByRole("button", { name: /^Chief/ })).toHaveCount(1);
  await personalRoster.getByRole("button", { name: "Actions for Personal" }).click();
  await expect(page.getByRole("menuitem", { name: "Rename space" })).toBeVisible();
  await page.getByRole("menuitem", { name: "Rename space" }).click();
  const singleSpaceRename = page.getByRole("dialog", { name: "Rename space" });
  await expect(singleSpaceRename.getByLabel("Name")).toHaveValue("Personal");
  await captureScreenshot(page, testInfo, "rename-only-space");
  await singleSpaceRename.getByRole("button", { name: "Cancel" }).click();
  await expect(singleSpaceRename).toHaveCount(0);
  await captureScreenshot(page, testInfo, "single-space-sidebar");

  await openNewSpace(page);
  const dialog = page.getByRole("dialog", { name: "New space" });
  await expect(dialog.getByLabel("Name")).toBeVisible();
  await dialog.getByLabel("Name").fill("Customer support");
  await captureScreenshot(page, testInfo, "new-space-dialog");
  await dialog.getByRole("button", { name: "Cancel" }).click();

  const composer = page.getByRole("combobox", { name: "Message Chief" });
  await composer.fill("Create a space named Customer support");
  await composer.press("Enter");
  await expect(page.getByRole("button", { name: "Create space", exact: true })).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByRole("button", { name: "Cancel", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Always allow this tool" })).toHaveCount(0);
  await expect(sidebar.getByText("Customer support", { exact: true })).toHaveCount(0);
  await captureScreenshot(page, testInfo, "create-space-chat-approval");
  await page.getByRole("button", { name: "Create space", exact: true }).click();
  await expect(page.getByText("Created", { exact: true })).toBeVisible();

  await expect(personalRoster.getByText("Personal").first()).toBeVisible();
  const supportSpace = sidebar
    .locator('[data-sidebar-group^="space:"]')
    .filter({ hasText: "Customer support" });
  await expect(supportSpace).toBeVisible({ timeout: 15_000 });
  const supportSpaceGroup = await supportSpace.getAttribute("data-sidebar-group");
  const supportSpaceId = supportSpaceGroup?.split(":")[1];
  expect(supportSpaceId).toBeTruthy();
  await supportSpace.getByRole("button", { name: "Open Customer support" }).click();
  await page.waitForURL(/\/(onboarding|app)/);
  await expect
    .poll(() => page.evaluate(() => window.localStorage.getItem("rakazo:space-id")))
    .toBe(supportSpaceId);
  await completeOnboarding(page);

  await expect(personalRoster.getByText("Personal").first()).toBeVisible();
  await expect(supportSpace.getByText("Customer support").first()).toBeVisible();
  await expect(personalRoster.getByRole("button", { name: /^Chief/ })).toHaveCount(1);
  await expect(supportSpace.getByRole("button", { name: /^Chief/ })).toHaveCount(1);
  await captureScreenshot(page, testInfo, "spaces-sidebar");

  await personalRoster.getByRole("button", { name: /^Chief/ }).click();
  await page.waitForURL(/\/app\/[^/]+$/);
  await expect
    .poll(() => page.evaluate(() => window.localStorage.getItem("rakazo:space-id")))
    .toBe(personalSpaceId);
  await expect(supportSpace.getByText("Customer support").first()).toBeVisible();
});

test("a new space auto-completes onboarding, can be renamed while occupied, and deleted once empty", async ({
  page,
}, testInfo) => {
  const stamp = Date.now();
  await signup(page, `spaces-delete-${stamp}@rakazo.test`, "password12", "Space Owner");
  await completeOnboarding(page);
  const nav = await rpc<{ current: { id: string } }>(page, "spaces/list", {});
  const personalSpaceId = nav.current.id;
  const personalRoster = spaceRoster(page, personalSpaceId);

  const sidebar = page.locator("aside").first();
  await openNewSpace(page);
  const dialog = page.getByRole("dialog", { name: "New space" });
  await dialog.getByLabel("Name").fill("Typo space");
  await dialog.getByRole("button", { name: "Create space", exact: true }).click();

  // Model is already connected, so onboarding skips the form and lands in Chief.
  await completeOnboarding(page);
  await expect(page).toHaveURL(/\/app\//);
  const occupied = sidebar
    .locator('[data-sidebar-group^="space:"]')
    .filter({ hasText: "Typo space" });
  await expect(occupied.getByText("Typo space").first()).toBeVisible();
  await expect(occupied.getByRole("button", { name: /^Chief/ })).toBeVisible();
  await expect(personalRoster.getByRole("button", { name: /^Chief/ })).toHaveCount(1);
  await expect(occupied.getByRole("button", { name: /^Chief/ })).toHaveCount(1);
  await captureScreenshot(page, testInfo, "new-space-after-onboarding");

  // An occupied space can be renamed but not deleted.
  await sidebar.getByRole("button", { name: "Actions for Typo space" }).click();
  await expect(page.getByRole("menuitem", { name: "Rename space" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Delete space" })).toHaveCount(0);
  await page.getByRole("menuitem", { name: "Rename space" }).click();

  const renameDialog = page.getByRole("dialog", { name: "Rename space" });
  await expect(renameDialog.getByLabel("Name")).toHaveValue("Typo space");
  await renameDialog.getByLabel("Name").fill("Temporary");
  await captureScreenshot(page, testInfo, "rename-space-dialog");
  await renameDialog.getByRole("button", { name: "Save" }).click();

  const temporarySpace = sidebar
    .locator('[data-sidebar-group^="space:"]')
    .filter({ hasText: "Temporary" });
  await expect(temporarySpace.getByText("Temporary").first()).toBeVisible();
  await expect(sidebar.getByText("Typo space", { exact: true })).toHaveCount(0);
  await expect(temporarySpace.getByRole("button", { name: /^Chief/ })).toBeVisible();
  await page.reload();
  await expect(temporarySpace.getByText("Temporary").first()).toBeVisible();

  // Spaces can only be deleted when empty — remove auto-created Chief first.
  await temporarySpace.getByRole("button", { name: /^Chief/ }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Delete" }).click();
  const deleteBotDialog = page.getByRole("alertdialog", { name: /Delete Chief/ });
  await expect(deleteBotDialog).toBeVisible();
  await deleteBotDialog.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(temporarySpace.getByRole("button", { name: /^Chief/ })).toHaveCount(0);

  // The emptied space stays selectable instead of trapping the user.
  await expect(sidebar.getByRole("button", { name: "Open Temporary" })).toBeVisible();

  // Deletion is discoverable through the visible Space actions menu.
  await sidebar.getByRole("button", { name: "Actions for Temporary" }).click();
  await captureScreenshot(page, testInfo, "space-actions-menu");
  await page.getByRole("menuitem", { name: "Delete space" }).click();
  const deleteSpaceDialog = page.getByRole("alertdialog", { name: "Delete Temporary?" });
  await expect(deleteSpaceDialog).toBeVisible();
  await captureScreenshot(page, testInfo, "delete-space-dialog");
  await deleteSpaceDialog.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(sidebar.getByText("Temporary", { exact: true })).toHaveCount(0);
  await expect(page).not.toHaveURL(/\/onboarding/);
  await expect(personalRoster.getByRole("button", { name: /^Chief/ })).toHaveCount(1);

  // A stale onboarding URL recovers without duplicating the bot.
  await page.goto("/onboarding");
  await page.waitForURL(/\/app/);
  await expect(page).not.toHaveURL(/\/onboarding/);
  await expect(personalRoster.getByRole("button", { name: /^Chief/ })).toHaveCount(1);
});

test("deleting the last bot in a space stays in the app after first use", async ({ page }) => {
  const stamp = Date.now();
  await signup(page, `spaces-empty-${stamp}@rakazo.test`, "password12", "Space Owner");
  await completeOnboarding(page);
  const [chief] = await rpc<Array<{ id: string }>>(page, "bots/list", {});
  expect(chief).toBeTruthy();
  await rpc(page, "bots/archive", { botId: chief!.id });
  await page.reload();
  await expect(page).not.toHaveURL(/\/onboarding/);

  const sidebar = page.locator("aside").first();
  await openNewSpace(page);
  const dialog = page.getByRole("dialog", { name: "New space" });
  await dialog.getByLabel("Name").fill("Side");
  await dialog.getByRole("button", { name: "Create space", exact: true }).click();
  await page.waitForURL(/\/(onboarding|app)/);
  await completeOnboarding(page);
  await expect(sidebar.getByText("Side", { exact: true })).toBeVisible();

  // Delete the only bot in the new space: the app must stay put instead of
  // forcing onboarding again.
  const sideBot = sidebar
    .locator('[data-sidebar-group^="space:"]')
    .filter({ hasText: "Side" })
    .getByRole("button", { name: /^Chief/ });
  await sideBot.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Delete" }).click();
  const deleteDialog = page.getByRole("alertdialog", { name: /Delete Chief/ });
  await expect(deleteDialog).toBeVisible();
  await deleteDialog.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(sideBot).toHaveCount(0);
  await expect(page).not.toHaveURL(/\/onboarding/);
  await page.reload();
  await expect(page).not.toHaveURL(/\/onboarding/);
  await expect(sidebar.getByRole("button", { name: "Open Side" })).toBeVisible();
  await expect(
    page.locator("main").getByRole("button", { name: "Create new Bot", exact: true }),
  ).toBeVisible();

  await sidebar.getByRole("button", { name: "Actions for Side" }).click();
  await page.getByRole("menuitem", { name: "Delete space" }).click();
  await page
    .getByRole("alertdialog", { name: "Delete Side?" })
    .getByRole("button", { name: "Delete", exact: true })
    .click();
  await expect(sidebar.getByText("Side", { exact: true })).toHaveCount(0);
  await sidebar.getByRole("button", { name: /^Archived/ }).click();
  // The archived fold-out lists the bot with its Restore control.
  await expect(sidebar.getByRole("button", { name: "Restore", exact: true })).toBeVisible();
});

test("a space's menu opens its settings in place, and settings can switch space", async ({
  page,
}, testInfo) => {
  const stamp = Date.now();
  await signup(page, `spaces-settings-${stamp}@rakazo.test`, "password12", "Space Owner");
  await completeOnboarding(page);

  const sidebar = page.locator("aside").first();
  await openNewSpace(page);
  const dialog = page.getByRole("dialog", { name: "New space" });
  await dialog.getByLabel("Name").fill("Support");
  await dialog.getByRole("button", { name: "Create space", exact: true }).click();
  await completeOnboarding(page);
  await expect(sidebar.getByText("Support", { exact: true })).toBeVisible();
  const chatPath = new URL(page.url()).pathname;
  // Settings stay on the chat's route; only the overlay params change.
  const onChat = () => {
    const url = new URL(page.url());
    expect(url.pathname).toBe(chatPath);
    expect(url.searchParams.get("settings")).toBe("models");
  };
  const selected = await page.evaluate(() => localStorage.getItem("rakazo:space-id"));
  await page.evaluate(() => {
    document.documentElement.dataset.settingsTest = "same-document";
  });

  // Support is selected; Personal's menu opens Personal's settings without leaving Support.
  await sidebar.getByRole("button", { name: "Actions for Personal" }).click();
  await page.getByRole("menuitem", { name: "Settings" }).click();
  const settings = page.getByTestId("user-settings");
  await expect(settings).toHaveAttribute("data-settings-section", "models");
  const picker = settings.getByTestId("settings-space");
  await expect(picker).toHaveText("Personal");
  onChat();
  expect(await page.evaluate(() => localStorage.getItem("rakazo:space-id"))).toBe(selected);
  await expect(page.locator("html")).toHaveAttribute("data-settings-test", "same-document");
  await captureScreenshot(page, testInfo, "space-settings-from-menu");

  await picker.click();
  await expect(page.getByRole("option", { name: "Support", exact: true })).toBeVisible();
  await captureScreenshot(page, testInfo, "space-settings-switcher");
  await page.getByRole("option", { name: "Support", exact: true }).click();
  await expect(picker).toHaveText("Support");
  await expect(settings).toHaveAttribute("data-settings-section", "models");
  onChat();
  expect(await page.evaluate(() => localStorage.getItem("rakazo:space-id"))).toBe(selected);
  await expect(page.locator("html")).toHaveAttribute("data-settings-test", "same-document");

  // Sections that are not per space show no picker.
  await settings.getByTestId("settings-nav-general").click();
  await expect(settings.getByTestId("settings-space")).toHaveCount(0);
});
