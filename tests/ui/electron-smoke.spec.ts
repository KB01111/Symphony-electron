import { test, expect } from "@playwright/test";
import { _electron as electron } from "playwright";

test("packaged renderer shows the Symphony command center", async () => {
  const app = await electron.launch({ args: ["."] });
  const page = await app.firstWindow();

  await expect(page.getByRole("heading", { name: "Symphony" })).toBeVisible();
  await expect(page.getByText("Autonomous Command Center")).toBeVisible();
  await expect(page.getByRole("button", { name: /pause automation|resume automation/i })).toBeVisible();
  await expect(page.getByText("Setup health")).toBeVisible();
  await expect(page.getByText("Approval queue")).toBeVisible();
  await expect(page.getByText("Proof of work")).toBeVisible();
  await expect(page.getByText("Queue reasons")).toBeVisible();
  await expect(page.getByText("Policy gates")).toBeVisible();

  await app.close();
});
