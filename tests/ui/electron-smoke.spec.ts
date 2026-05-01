import { test, expect } from "@playwright/test";
import { _electron as electron } from "playwright";

test("packaged renderer shows the Symphony control plane", async () => {
  const app = await electron.launch({ args: ["."] });
  const page = await app.firstWindow();

  await expect(page.getByRole("heading", { name: "Symphony" })).toBeVisible();
  await expect(page.getByText("Linear work into isolated Codex runs")).toBeVisible();

  await app.close();
});

