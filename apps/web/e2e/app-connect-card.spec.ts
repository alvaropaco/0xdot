import { expect, test } from "@playwright/test";
import {
  activeBotId,
  captureScreenshot,
  completeOnboarding,
  createIsolatedSpace,
  createNamedBot,
  rpc,
  signup,
} from "./helpers";

test("a bot connects an app inline in a normal chat", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  // The scripted reply differs once Gmail is connected in the Space, so the
  // connect flow must run against its own Space's connection state.
  const spaceId = await createIsolatedSpace(page, `inline connect ${Date.now()}`);
  const spaceHeaders = { "x-rakazo-space-id": spaceId };
  await signup(page, `inline-connect-${Date.now()}@rakazo.test`, "password12", "Sample");
  await completeOnboarding(page);
  const botId = activeBotId(page);
  await rpc(page, "onboarding/dismissFocus", { botId }, spaceHeaders);
  await page.getByPlaceholder(/Message/).fill("Can you check my Gmail inbox?");
  await page.keyboard.press("Enter");
  const card = page.getByRole("group", { name: "Gmail connection", exact: true });
  await expect(card).toBeVisible();
  await expect(
    page
      .getByTestId("message-bot-bubble")
      .getByText("Connect Gmail and I’ll check your inbox.", { exact: true }),
  ).toBeVisible();
  for (const theme of ["light", "dark"]) {
    await page.evaluate(
      (value) => document.documentElement.setAttribute("data-theme", value),
      theme,
    );
    await captureScreenshot(page, testInfo, `web-pending-${theme}`);
  }
  await card.getByRole("button", { name: "Authorize", exact: true }).click();
  await expect(card.getByText("Connected", { exact: true })).toBeVisible();
  await page.reload();
  await expect(card.getByText("Connected", { exact: true })).toBeVisible();
  for (const theme of ["light", "dark"]) {
    await page.evaluate(
      (value) => document.documentElement.setAttribute("data-theme", value),
      theme,
    );
    await captureScreenshot(page, testInfo, `web-connected-${theme}`);
  }
  // The connector emulator keys connected apps by user, not Space. Revoke the
  // connection so the group-card test below still sees Gmail as unconnected.
  const connections = await rpc<Array<{ id: string; provider: string; status: string }>>(
    page,
    "connections/list",
    {},
    spaceHeaders,
  );
  for (const connection of connections) {
    await rpc(page, "connections/revoke", { connectionId: connection.id }, spaceHeaders);
  }
});

test("a group card authorizes in its own thread without duplicate pending cards", async ({
  page,
}, testInfo) => {
  const groupSpaceId = await createIsolatedSpace(page, `group connect ${Date.now()}`);
  const spaceHeaders = { "x-rakazo-space-id": groupSpaceId };
  await signup(page, `group-connect-${Date.now()}@rakazo.test`, "password12", "Sample");
  await completeOnboarding(page);
  const firstBotId = activeBotId(page);
  const peerId = await createNamedBot(page, "Assistant", { headers: spaceHeaders });
  const group = await rpc<{ id: string }>(
    page,
    "groups/create",
    {
      name: "Team",
      botIds: [firstBotId, peerId],
    },
    spaceHeaders,
  );
  await page.goto(`/app/g/${group.id}`);
  await page.getByRole("combobox", { name: "Message Team" }).fill("Can you check my Gmail inbox?");
  await page.keyboard.press("Enter");
  const card = page.getByRole("group", { name: "Gmail connection", exact: true });
  await expect(card).toHaveCount(1);
  await expect(card.getByRole("button", { name: "Authorize", exact: true })).toBeVisible();
  await captureScreenshot(page, testInfo, "group-app-connect-pending");
  await card.getByRole("button", { name: "Authorize", exact: true }).click();
  await expect(card.getByText("Connected", { exact: true })).toBeVisible();
  await page.reload();
  await expect(card.getByText("Connected", { exact: true })).toBeVisible();
  await captureScreenshot(page, testInfo, "group-app-connect-connected");
});
