import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import type { CreateProfileInput, HealthCheckResult, Profile } from "../../shared/types.js";
import { FileStateStore } from "./file-state.js";
import { isoNow } from "./time.js";

const execFileAsync = promisify(execFile);

export interface CodexCommandResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
}

export type RunCodex = (args: string[], env: Record<string, string | undefined>) => Promise<CodexCommandResult>;

export class ProfileService {
  private readonly store: FileStateStore<Profile[]>;
  private readonly runCodex: RunCodex;
  readonly appDataRoot: string;

  constructor(options: { appDataRoot: string; runCodex?: RunCodex }) {
    this.appDataRoot = options.appDataRoot;
    this.store = new FileStateStore<Profile[]>(path.join(options.appDataRoot, "state", "profiles.json"), []);
    this.runCodex = options.runCodex ?? defaultRunCodex;
  }

  async list(): Promise<Profile[]> {
    return this.store.read();
  }

  async create(input: CreateProfileInput): Promise<Profile> {
    const now = isoNow();
    const id = `${slugify(input.name)}-${randomUUID().slice(0, 8)}`;
    const root = path.join(this.appDataRoot, "profiles", id);
    const profile: Profile = {
      id,
      name: input.name.trim(),
      codexHome: path.join(root, "codex-home"),
      workspaceRoot: path.join(root, "workspaces"),
      repoCacheRoot: path.join(root, "repos"),
      logsRoot: path.join(root, "logs"),
      createdAt: now,
      updatedAt: now
    };
    await Promise.all([
      mkdir(profile.codexHome, { recursive: true }),
      mkdir(profile.workspaceRoot, { recursive: true }),
      mkdir(profile.repoCacheRoot, { recursive: true }),
      mkdir(profile.logsRoot, { recursive: true })
    ]);
    await writeFile(
      path.join(profile.codexHome, "config.toml"),
      [
        'cli_auth_credentials_store = "file"',
        'sandbox_mode = "workspace-write"',
        'approval_policy = "on-request"',
        "",
        "[sandbox_workspace_write]",
        `writable_roots = [${JSON.stringify(profile.workspaceRoot)}]`,
        ""
      ].join("\n"),
      "utf8"
    );
    const profiles = await this.store.read();
    profiles.push(profile);
    await this.store.write(profiles);
    return profile;
  }

  async get(profileId: string): Promise<Profile> {
    const profile = (await this.list()).find((candidate) => candidate.id === profileId);
    if (!profile) {
      throw new Error(`Unknown profile: ${profileId}`);
    }
    return profile;
  }

  async checkGlobalCodex(): Promise<HealthCheckResult> {
    const result = await this.runCodex(["login", "status"], {});
    return commandResultToHealth("Global Codex", result);
  }

  async checkHealth(profileId: string): Promise<HealthCheckResult> {
    const profile = await this.get(profileId);
    const result = await this.runCodex(["login", "status"], { CODEX_HOME: profile.codexHome });
    return commandResultToHealth(`Codex: ${profile.name}`, result);
  }

  async startLogin(profileId: string): Promise<{ pid?: number; message: string }> {
    const profile = await this.get(profileId);
    const child = spawn("codex", ["login"], {
      env: { ...process.env, CODEX_HOME: profile.codexHome },
      cwd: profile.workspaceRoot,
      detached: true,
      stdio: "ignore",
      windowsHide: false
    });
    child.unref();
    return {
      ...(child.pid ? { pid: child.pid } : {}),
      message: `Started Codex OAuth for ${profile.name}.`
    };
  }
}

function commandResultToHealth(label: string, result: CodexCommandResult): HealthCheckResult {
  const output = `${result.stdout}\n${result.stderr}`.trim();
  return {
    ok: result.ok,
    label,
    detail: output || (result.ok ? "Codex command completed." : `Codex exited with ${result.exitCode}.`),
    checkedAt: isoNow()
  };
}

async function defaultRunCodex(args: string[], env: Record<string, string | undefined>): Promise<CodexCommandResult> {
  try {
    const result = await execFileAsync("codex", args, {
      env: { ...process.env, ...env },
      windowsHide: true
    });
    return { ok: true, stdout: result.stdout, stderr: result.stderr, exitCode: 0 };
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string; code?: number };
    return {
      ok: false,
      stdout: failure.stdout ?? "",
      stderr: failure.stderr ?? failure.message,
      exitCode: typeof failure.code === "number" ? failure.code : 1
    };
  }
}

function slugify(value: string): string {
  return (
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "profile"
  );
}
