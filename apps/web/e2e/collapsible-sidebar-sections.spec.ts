import { expect, test } from "@playwright/test";
import {
  activeBotId,
  captureScreenshot,
  completeOnboarding,
  createIsolatedSpace,
  signup,
} from "./helpers";

test("titled sidebar section expands and collapses", async ({ page }, testInfo) => {
  const stamp = Date.now();
  // Sections and roster entries are visible across Spaces; the test's own
  // Space keeps its section (and its Chief) apart from other specs'.
  await createIsolatedSpace(page, `sidebar sections ${stamp}`);
  await signup(page, `sidebar-collapse-${stamp}@rakazo.test`, "password12", "Test User");
  await completeOnboarding(page);
  await page.goto("/app");
  await page.waitForURL(/\/app\/[^/]+$/);
  const chiefId = activeBotId(page);

  const sidebar = page.locator("aside").first();
  // Roster entries carry the bot id, which is unique across Spaces.
  const bot = page.locator(`[data-roster-bot-id="${chiefId}"]`);

  await bot.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Move to", exact: true }).hover();
  await page.getByRole("menu", { name: "Move to", exact: true }).getByText("New section").click();
  const dialog = page.getByRole("dialog", { name: "New section" });
  await dialog.getByLabel("Name").fill("Projects");
  await dialog.getByRole("button", { name: "Create" }).click();

  // The section group that holds this test's Chief, however the group key is
  // namespaced when the sidebar lists more than one Space.
  const projects = sidebar
    .locator("[data-sidebar-group]")
    .filter({ has: page.locator(`[data-roster-bot-id="${chiefId}"]`) });
  await expect(projects).toContainText("Projects");
  await expect(projects).toContainText("Chief");

  // Collapsing unmounts the section's roster, so the "group containing Chief"
  // filter goes blind; pin the group by its key before the first collapse.
  const projectsKey = await projects.getAttribute("data-sidebar-group");
  const sectionGroup = page.locator(`[data-sidebar-group="${projectsKey}"]`);

  // Prefixed group titles read "Space · Projects", so keep the section name
  // unanchored in the toggle's accessible name.
  const toggle = sectionGroup.getByRole("button", { name: /(?:Collapse|Expand) .*Projects/ });
  await expect(toggle).toHaveAttribute("aria-expanded", "true");

  // Rest (no hover): move pointer off the header before capturing.
  await sidebar.getByPlaceholder("Search").hover();
  await captureScreenshot(page, testInfo, "sidebar-section-expanded");

  // Hover header with Chief selected underneath — outer edges must match.
  await bot.click();
  await toggle.hover();
  const headerBox = await toggle.boundingBox();
  const botBox = await bot.boundingBox();
  expect(headerBox).toBeTruthy();
  expect(botBox).toBeTruthy();
  expect(headerBox!.x).toBeCloseTo(botBox!.x, 0);
  expect(headerBox!.x + headerBox!.width).toBeCloseTo(botBox!.x + botBox!.width, 0);
  await captureScreenshot(page, testInfo, "sidebar-section-hover");

  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(sectionGroup.locator(`[data-roster-bot-id="${chiefId}"]`)).toHaveCount(0);
  await sidebar.getByPlaceholder("Search").hover();
  await captureScreenshot(page, testInfo, "sidebar-section-collapsed");

  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(sectionGroup.locator(`[data-roster-bot-id="${chiefId}"]`)).toHaveCount(1);
});
