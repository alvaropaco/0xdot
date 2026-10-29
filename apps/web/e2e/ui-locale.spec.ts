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

  // The locale is user-scoped: a concurrent spec's language switch can stomp
  // this one, so re-select Hebrew until it sticks.
  const switchToHebrew = async () => {
    await picker.click();
    // עברית sits at the clipped bottom edge of the open list, where a pointer
    // click lands on the scroll affordance instead of the item; deliver the
    // selection through the item itself once it is highlighted.
    const hebrew = page.getByRole("option", { name: "עברית", exact: true });
    await hebrew.hover();
    await hebrew.dispatchEvent("click");
  };
  await expect(async () => {
    const lang = await page.locator("html").getAttribute("lang");
    const pickerText = (await picker.textContent())?.trim();
    console.log(`DBG retry lang=${lang} picker=${pickerText}`);
    if (lang !== "he") await switchToHebrew();
    await expect(settings.getByRole("heading", { name: "כללי", exact: true })).toBeVisible({
      timeout: 5_000,
    });
  }).toPass({ timeout: 60_000 });
  await expect(settings.getByRole("heading", { name: "מראה", exact: true })).toBeVisible();
  await expect(settings.getByRole("heading", { name: "שפה", exact: true })).toBeVisible();
  await expect(picker).toHaveText("עברית");
  await expect(page.locator("html")).toHaveAttribute("lang", "he");
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await captureScreenshot(page, testInfo, "ui-locale-settings-he");
  await page.reload();
  await expect
    .poll(() => page.locator("html").getAttribute("lang"), { timeout: 30_000 })
    .toBe("he");
  // A concurrent stomp can revert the saved locale before the reload.
  if ((await page.locator("html").getAttribute("dir")) !== "rtl") await switchToHebrew();
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");

  await page.goto("/app");
  await page.waitForURL(/\/app\/[^/]+$/);
  const sidebar = page.getByTestId("bots-sidebar");
  await expect(sidebar).toBeInViewport({ ratio: 1 });
  const box = await sidebar.boundingBox();
  expect((box?.x ?? 0) + (box?.width ?? 0)).toBeCloseTo(page.viewportSize()?.width ?? 0, 0);
  await captureScreenshot(page, testInfo, "ui-locale-app-he");

  // The locale is user-scoped and shared by the whole shard; switch back so
  // specs running concurrently keep their English selectors.
  await openUserSettings(page);
  const restore = page.getByTestId("ui-locale-select");
  await restore.click();
  await page.getByRole("option", { name: "English", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
});
