import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, openUserSettings, signup } from "./helpers";

test("account settings language picker includes Hebrew and mirrors the UI right-to-left", async ({
  page,
}, testInfo) => {
  const stamp = Date.now();
  await signup(page, `ui-locale-he-${stamp}@rakazo.test`, "password12", "Locale QA");
  await completeOnboarding(page, testInfo);

  const settings = await openUserSettings(page);

  const picker = settings.getByTestId("ui-locale-select");
  await picker.click();
  await expect(page.getByRole("option", { name: "עברית", exact: true })).toBeVisible();
  await expect(page.getByRole("option", { name: "日本語", exact: true })).toBeVisible();
  await captureScreenshot(page, testInfo, "ui-locale-picker-he");

  // עברית sits at the bottom of the long list. Scroll it into view first so the
  // pointer lands on the item, not the list's clipped edge, and let the click
  // retry if the popup is still settling.
  const hebrew = page.getByRole("option", { name: "עברית", exact: true });
  await hebrew.scrollIntoViewIfNeeded();
  await hebrew.click();
  await expect(settings.getByRole("heading", { name: "כללי", exact: true })).toBeVisible();
  await expect(settings.getByRole("heading", { name: "מראה", exact: true })).toBeVisible();
  await expect(settings.getByRole("heading", { name: "שפה", exact: true })).toBeVisible();
  await expect(picker).toHaveText("עברית");
  await expect(page.locator("html")).toHaveAttribute("lang", "he");
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await captureScreenshot(page, testInfo, "ui-locale-settings-he");

  // The locale lives in this context's localStorage, so it survives reloads and
  // no other spec's browser can change it.
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("lang", "he", { timeout: 30_000 });
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl", { timeout: 30_000 });

  await page.goto("/app");
  await page.waitForURL(/\/app\/[^/]+$/);
  const sidebar = page.getByTestId("bots-sidebar");
  await expect(sidebar).toBeInViewport({ ratio: 1 });
  const box = await sidebar.boundingBox();
  expect((box?.x ?? 0) + (box?.width ?? 0)).toBeCloseTo(page.viewportSize()?.width ?? 0, 0);
  await captureScreenshot(page, testInfo, "ui-locale-app-he");
});
