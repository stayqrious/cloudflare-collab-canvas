import { expect, type Page, test } from "@playwright/test";
import { createBoard, createInvite, isolatedContextOptions, openInvite } from "./helpers";

test("owners manage live participant roles and board permissions from Participants", async ({
  browser,
  page,
}, testInfo) => {
  const errors: string[] = [];
  const captureErrors = (target: Page) => {
    target.on("pageerror", (error) => errors.push(error.message));
    target.on("console", (message) => {
      // The failed-save check below deliberately returns HTTP 503.
      if (message.type() === "error" && !message.text().includes("503"))
        errors.push(message.text());
    });
  };
  captureErrors(page);
  await createBoard(page, "Participant permissions");
  await expect(page).toHaveTitle(/Participant permissions/u);
  const invite = await createInvite(page, "editor");
  await page.getByTestId("participants-button").click();
  const participants = page.getByTestId("participant-drawer");
  await expect(participants).toBeVisible();
  await expect(participants.getByRole("combobox")).toHaveCount(0);

  const context = await browser.newContext(isolatedContextOptions(testInfo, 81));
  const collaborator = await context.newPage();
  captureErrors(collaborator);
  try {
    await openInvite(collaborator, invite);
    const role = participants.getByRole("combobox");
    await expect(role).toHaveCount(1);
    await expect(role).toHaveValue("editor");
    await expect(participants.locator(".participant-row")).toHaveCount(2);

    await collaborator.getByTestId("participants-button").click();
    const collaboratorParticipants = collaborator.getByTestId("participant-drawer");
    await expect(collaboratorParticipants.getByRole("combobox")).toHaveCount(0);
    await expect(
      collaboratorParticipants.getByRole("group", { name: "Board permissions" }),
    ).toBeHidden();

    await role.selectOption("viewer");
    await expect(role).toHaveValue("viewer");
    await expect(collaborator.getByTestId("tool-pencil")).toBeDisabled();
    await expect(collaborator.getByTestId("save-status")).toContainText("Read only");
    await expect(collaboratorParticipants.getByRole("combobox")).toHaveCount(0);
    await role.selectOption("editor");
    await expect(collaborator.getByTestId("tool-pencil")).toBeEnabled();

    await participants.getByRole("button", { name: "View only", exact: true }).click();
    await expect(
      participants.getByRole("button", { name: "View only", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("tool-pencil")).toBeDisabled();
    await expect(collaborator.getByTestId("tool-pencil")).toBeDisabled();
    await expect(role).toHaveValue("editor");

    await participants.getByRole("button", { name: "Owners only", exact: true }).click();
    await expect(page.getByTestId("tool-pencil")).toBeEnabled();
    await expect(collaborator.getByTestId("tool-pencil")).toBeDisabled();
    await participants.getByRole("button", { name: "Allow editing", exact: true }).click();
    await expect(collaborator.getByTestId("tool-pencil")).toBeEnabled();

    // An existing Viewer must stay read-only when the board allows editing again.
    await role.selectOption("viewer");
    await expect(collaborator.getByTestId("tool-pencil")).toBeDisabled();
    await participants.getByRole("button", { name: "View only", exact: true }).click();
    await expect(page.getByTestId("tool-pencil")).toBeDisabled();
    await participants.getByRole("button", { name: "Allow editing", exact: true }).click();
    await expect(page.getByTestId("tool-pencil")).toBeEnabled();
    await expect(collaborator.getByTestId("tool-pencil")).toBeDisabled();
    await expect(role).toHaveValue("viewer");

    // Failed saves restore the authoritative role and leave controls usable.
    await page.route("**/api/v1/boards/*/members/*", async (route) => {
      if (route.request().method() !== "PATCH") return route.continue();
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({
          error: {
            code: "TEMPORARILY_UNAVAILABLE",
            message: "Please retry this permission change.",
          },
        }),
      });
    });
    await role.selectOption("editor");
    await expect(page.getByTestId("toast-region")).toContainText(
      "Please retry this permission change.",
    );
    await expect(role).toHaveValue("viewer");
    await expect(role).toBeEnabled();
    await expect(collaborator.getByTestId("tool-pencil")).toBeDisabled();
    await page.unroute("**/api/v1/boards/*/members/*");
    await role.selectOption("editor");
    await expect(collaborator.getByTestId("tool-pencil")).toBeEnabled();

    await page.getByTestId("settings-button").click();
    const settings = page.getByTestId("settings-drawer");
    await expect(settings.locator("[data-policy='editors_enabled']")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await settings.locator("[data-policy='owner_only']").click();
    await expect(collaborator.getByTestId("tool-pencil")).toBeDisabled();
    await page.getByTestId("participants-button").click();
    await expect(
      participants.getByRole("button", { name: "Owners only", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    await participants.getByRole("button", { name: "Allow editing", exact: true }).click();
    await expect(collaborator.getByTestId("tool-pencil")).toBeEnabled();
    await page.reload();
    await expect(page.locator("#board-canvas")).toHaveAttribute("data-ready", "true");
    await page.getByTestId("participants-button").click();
    await expect(role).toHaveValue("editor");
    await expect(
      participants.getByRole("button", { name: "Allow editing", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator("vite-error-overlay")).toHaveCount(0);
    expect(
      await participants.evaluate((element) => element.scrollWidth <= element.clientWidth),
    ).toBe(true);
    expect(errors).toEqual([]);
    await page.screenshot({ path: `/tmp/participant-permissions-${testInfo.project.name}.png` });
  } finally {
    await context.close();
  }
});
