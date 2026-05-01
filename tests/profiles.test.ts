import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { ProfileService } from "../src/main/services/profiles.js";

const tempDirs: string[] = [];

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "symphony-profile-"));
  tempDirs.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

test("creates isolated CODEX_HOME, workspace, repo cache, and file-backed auth config per profile", async () => {
  const root = await tempRoot();
  const service = new ProfileService({ appDataRoot: root });

  const profile = await service.create({ name: "Work Account" });

  expect(profile.codexHome).toBe(path.join(root, "profiles", profile.id, "codex-home"));
  expect(profile.workspaceRoot).toBe(path.join(root, "profiles", profile.id, "workspaces"));
  expect(profile.repoCacheRoot).toBe(path.join(root, "profiles", profile.id, "repos"));
  expect(profile.logsRoot).toBe(path.join(root, "profiles", profile.id, "logs"));

  const config = await readFile(path.join(profile.codexHome, "config.toml"), "utf8");
  expect(config).toContain('cli_auth_credentials_store = "file"');
  expect(config).toContain('sandbox_mode = "workspace-write"');
});

test("reports global Codex permission failures without blocking isolated profiles", async () => {
  const root = await tempRoot();
  const service = new ProfileService({
    appDataRoot: root,
    runCodex: async (args, env) => {
      if (!env.CODEX_HOME) {
        return { ok: false, stdout: "", stderr: "Error loading configuration: Åtkomst nekad. (os error 5)", exitCode: 1 };
      }
      return { ok: true, stdout: "Logged in with ChatGPT", stderr: "", exitCode: 0 };
    }
  });
  const profile = await service.create({ name: "Isolated" });

  await expect(service.checkGlobalCodex()).resolves.toMatchObject({
    ok: false,
    detail: expect.stringContaining("Åtkomst nekad")
  });
  await expect(service.checkHealth(profile.id)).resolves.toMatchObject({
    ok: true,
    detail: "Logged in with ChatGPT"
  });
});

