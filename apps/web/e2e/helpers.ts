import type { Locator, Page, TestInfo } from "@playwright/test";
import { expect } from "@playwright/test";

export function isRealSandboxProvider(provider = process.env.SANDBOX_PROVIDER) {
  return provider === "e2b" || provider === "daytona" || provider === "boat";
}

export function realSandboxTimeout(real: number, emulated: number) {
  if (process.env.SANDBOX_PROVIDER === "boat") return Math.max(real, 300_000);
  return isRealSandboxProvider() ? real : emulated;
}

export function activeBotId(page: Page) {
  const id = new URL(page.url()).pathname.split("/").filter(Boolean).at(-1);
  if (!id || id === "app") throw new Error(`missing bot id in ${page.url()}`);
  return id;
}

export async function rpc<T>(
  page: Page,
  procedure: string,
  body: unknown,
  headers?: Record<string, string>,
): Promise<T> {
  const response = await page.request.post(`/rpc/${procedure}`, {
    data: { json: body },
    headers,
  });
  const parsed = (await response.json()) as { json?: T; error?: { message?: string } };
  if (!response.ok() || parsed.error) {
    throw new Error(`${procedure} ${response.status()}: ${parsed.error?.message ?? "failed"}`);
  }
  return parsed.json as T;
}

/**
 * There is one deployment owner, so connected model credentials are shared by
 * every spec in a shard. Tests that assert a pristine catalog (a native Model
 * select, one Connected marker, exact option counts) disconnect everything
 * first instead of assuming they run before the first connect. Providers in
 * `except` are left alone, so a spec can keep its own small fixture credential
 * without other specs' resets tearing it down mid-run.
 */
export async function resetModelCredentials(page: Page, options: { except?: string[] } = {}) {
  const keep = new Set(options.except ?? []);
  const credentials = await rpc<Array<{ provider: string }>>(page, "models/credentials", {});
  for (const provider of [...new Set(credentials.map((entry) => entry.provider))]) {
    if (keep.has(provider)) continue;
    await rpc(page, "models/disconnect", { provider });
  }
}

/**
 * Puts the page in its own Space for the rest of the test: the web app sends
 * `x-rakazo-space-id` from this localStorage key on every request. Bots, bots'
 * threads, onboarding state, and panel preferences stay out of the shared
 * owner Space, so exact-count and thread-local assertions hold. Pass the
 * returned id as the `x-rakazo-space-id` header on test-side `rpc` calls.
 */
export async function createIsolatedSpace(page: Page, name: string): Promise<string> {
  const space = await rpc<{ id: string }>(page, "spaces/create", { name });
  await page.addInitScript((spaceId) => {
    try {
      window.localStorage.setItem("rakazo:space-id", spaceId);
    } catch {
      // Storage unavailable: the test will fail on its first cross-space assertion.
    }
  }, space.id);
  return space.id;
}

export async function completeOnboarding(page: Page, testInfo?: TestInfo) {
  await page.waitForURL(/\/(onboarding|app)/, { timeout: 20_000 });
  // Optional Server integrations step (needsSetup). Skip when shown, then the
  // first bot is created automatically — land in Chief's chat with no form.
  const integrations = page.getByRole("heading", { name: "Server integrations", exact: true });
  const chief = page.getByText("Chief").first();
  await integrations.or(chief).or(page.getByText("Opening chat…")).waitFor({ timeout: 20_000 });
  if ((await chief.isVisible().catch(() => false)) && page.url().includes("/app")) {
    if (testInfo) {
      await captureScreenshot(page, testInfo, "03-create-first-bot");
      await captureScreenshot(page, testInfo, "06-onboarding-complete");
    }
    return;
  }
  if (await integrations.isVisible().catch(() => false)) {
    if (testInfo) await captureScreenshot(page, testInfo, "02-connect-apps");
    await page.getByRole("button", { name: "Skip", exact: true }).click();
  }
  await page.waitForURL(/\/app\//, { timeout: 20_000 });
  await expect(page.getByText("Chief").first()).toBeVisible();
  if (testInfo) {
    await captureScreenshot(page, testInfo, "03-create-first-bot");
    await captureScreenshot(page, testInfo, "06-onboarding-complete");
  }
}

/**
 * There is no account to create: the API acts as its single deployment owner.
 * The old helper navigated to the app after signing up, so this still starts a
 * fresh onboarding (it redirects to the shell when nothing is left to set up).
 */
export async function signup(
  page: Page,
  _email: string,
  _password: string,
  _name: string,
  _testInfo?: TestInfo,
) {
  await page.goto("/onboarding");
}

/** Open Advanced through its trigger, preserving an already-expanded section. */
export async function expandAdvancedSection(section: Locator) {
  const trigger = section.getByRole("button", { name: "Advanced", exact: true });
  if ((await trigger.getAttribute("aria-expanded")) === "false") await trigger.click();
  await expect(trigger).toHaveAttribute("aria-expanded", "true");
  await waitForTransitions(section);
}

/** Waits for fold-outs to settle before clicking or dragging their contents. */
async function waitForTransitions(element: Locator) {
  // Base UI starts a fold a frame after the toggle.
  await element.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve(undefined))),
      ),
  );
  await expect
    .poll(() =>
      element.evaluate(
        (node) =>
          node
            .getAnimations({ subtree: true })
            .filter((animation) => animation instanceof CSSTransition).length,
      ),
    )
    .toBe(0);
}

export async function waitForSidebarTransitions(page: Page) {
  await waitForTransitions(page.locator("aside").first());
}

/**
 * A card inside the fit-content bubble frame fills its fixed width and shrinks only to the
 * frame's cap. A percentage width would resolve against the card's own content instead.
 */
export async function expectCardWidth(card: Locator, width: number) {
  const measured = await card.evaluate((element) => ({
    card: element.getBoundingClientRect().width,
    frame:
      element.closest('[data-testid="message-bubble-frame"]')?.getBoundingClientRect().width ??
      Number.NaN,
  }));
  expect(Math.abs(measured.card - Math.min(width, measured.frame))).toBeLessThan(1);
}

export async function captureScreenshot(page: Page, testInfo: TestInfo, name: string) {
  const screenshotPath = testInfo.outputPath(`${name}.png`);
  await page.screenshot({
    animations: "disabled",
    caret: "hide",
    fullPage: true,
    path: screenshotPath,
  });
  await testInfo.attach(name, { contentType: "image/png", path: screenshotPath });
}

export async function openNewBot(page: Page) {
  await page.getByTestId("create-menu-trigger").click();
  await page.getByTestId("create-new-bot").click();
  await expect(page.getByTestId("create-bot-dialog")).toBeVisible();
}

export async function openNewGroup(page: Page) {
  await page.getByTestId("create-menu-trigger").click();
  await page.getByTestId("create-new-group").click();
}

export async function openNewSpace(page: Page) {
  await page.getByTestId("create-menu-trigger").click();
  await page.getByTestId("create-new-space").click();
}

/** Open the create dialog from the + picker, name the bot, and wait for the new chat. */
export async function createBotFromPicker(
  page: Page,
  { name = "New Bot" }: { name?: string } = {},
) {
  await openNewBot(page);
  const dialog = page.getByTestId("create-bot-dialog");
  await dialog.getByPlaceholder("Name your Bot").fill(name);
  await dialog.getByRole("button", { name: "Create", exact: true }).click();
  await page.waitForURL(/\/app\/[^/]+$/);
  await expect(dialog).toBeHidden();
  await expect(page.getByTestId("side-panel")).toHaveAttribute("data-panel", "closed");
}

/** Open the user Settings overlay, optionally switching to a sidebar section. */
export async function openUserSettings(
  page: Page,
  section?: "general" | "models" | "memory" | "voice" | "usage" | "computer" | "updates",
) {
  // A reload keeps settings open because the URL holds them; closing clears the URL at once.
  if (!new URL(page.url()).searchParams.has("settings")) {
    await page.getByTestId("user-menu-trigger").click();
    await page.getByRole("button", { name: "Settings", exact: true }).click();
  }
  const settings = page.getByTestId("user-settings");
  await expect(settings).toBeVisible();
  if (section && section !== "general") {
    await settings.getByTestId(`settings-nav-${section}`).click();
  }
  return settings;
}

/**
 * Sidebar roster groups for one Space. Once the sidebar lists more than one
 * Space (isolated-Space specs always see the owner's default Space too), group
 * keys are prefixed with `space:<id>:`; with a single Space they stay plain.
 * Scope name queries to these groups so another Space's identically named bot
 * cannot strict-mode the locator.
 */
export function spaceRoster(page: Page, spaceId: string) {
  return page
    .locator("aside")
    .first()
    .locator(
      [
        `[data-sidebar-group="space:${spaceId}"]`,
        `[data-sidebar-group^="space:${spaceId}:"]`,
        `[data-sidebar-group="unassigned"]`,
        `[data-sidebar-group="pinned"]`,
        `[data-sidebar-group^="section:"]`,
      ].join(", "),
    );
}

/** Create a named bot via RPC for test setup (skips the + picker). */
export async function createNamedBot(
  page: Page,
  name: string,
  options: { computerMode?: "team" | "dedicated"; headers?: Record<string, string> } = {},
) {
  const bot = await rpc<{ id: string; name: string }>(
    page,
    "bots/create",
    {
      name,
      title: "",
      description: "",
      notifyOnFinish: true,
      computerMode: options.computerMode ?? "team",
    },
    options.headers,
  );
  await page.goto(`/app/${bot.id}`);
  await expect(page.getByPlaceholder(`Message ${name}`)).toBeVisible();
  return bot.id;
}

/**
 * Picks an option from one of the kit's dropdowns. They open a menu of options rather than a
 * native select, so selectOption() does not apply; options are matched by their visible name.
 */
export async function chooseOption(trigger: Locator, option: string | { index: number }) {
  await trigger.click();
  const options = trigger.page().getByRole("option");
  await (typeof option === "string"
    ? trigger.page().getByRole("option", { name: option, exact: true })
    : options.nth(option.index)
  ).click();
}
