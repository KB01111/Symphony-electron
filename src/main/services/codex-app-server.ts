import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { InitializeParams } from "../../generated/codex-app-server/InitializeParams.js";
import type { ThreadStartParams } from "../../generated/codex-app-server/v2/ThreadStartParams.js";
import type { ThreadStartResponse } from "../../generated/codex-app-server/v2/ThreadStartResponse.js";
import type { TurnStartParams } from "../../generated/codex-app-server/v2/TurnStartParams.js";
import type { TurnStartResponse } from "../../generated/codex-app-server/v2/TurnStartResponse.js";
import type { DynamicToolSpec } from "../../generated/codex-app-server/v2/DynamicToolSpec.js";
import type { AskForApproval } from "../../generated/codex-app-server/v2/AskForApproval.js";
import type { SandboxMode } from "../../generated/codex-app-server/v2/SandboxMode.js";
import type { SandboxPolicy } from "../../generated/codex-app-server/v2/SandboxPolicy.js";
import { CodexJsonRpcClient, type JsonRpcRequest } from "./codex-jsonrpc.js";

export interface CodexAppServerOptions {
  codexHome: string;
  cwd: string;
  onStdout?(chunk: string): void;
  onStderr?(chunk: string): void;
  onNotification?(method: string, params: unknown): void;
  onServerRequest?(request: JsonRpcRequest): Promise<unknown> | unknown;
  onProtocolError?(error: Error, chunk: string): void;
  onExit?(exitCode: number | null, signal: NodeJS.Signals | null): void;
  dynamicTools?: DynamicToolSpec[];
  command?: string;
  approvalPolicy?: unknown;
  sandbox?: unknown;
  turnSandboxPolicy?: unknown;
  baseInstructions?: string;
  readTimeoutMs?: number;
}

export type CodexAppServerProcessFactory = (options: CodexAppServerOptions) => CodexAppServerProcessLike;

export interface CodexAppServerProcessLike {
  readonly pid: number | undefined;
  startTurn(prompt: string, cwd: string): Promise<StartedTurn>;
  continueTurn(threadId: string, prompt: string, cwd: string): Promise<StartedTurn>;
  close(): void;
}

export interface StartedTurn {
  threadId: string;
  turnId: string;
}

interface ThreadParamOptions {
  cwd: string;
  prompt: string;
  approvalPolicy?: unknown;
  sandbox?: unknown;
  turnSandboxPolicy?: unknown;
  baseInstructions?: string;
  dynamicTools?: DynamicToolSpec[];
}

export class CodexAppServerProcess implements CodexAppServerProcessLike {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly client: CodexJsonRpcClient;
  private readonly dynamicTools: DynamicToolSpec[];
  private readonly approvalPolicy: unknown;
  private readonly sandbox: unknown;
  private readonly turnSandboxPolicy: unknown;
  private readonly baseInstructions: string | undefined;
  private readonly readTimeoutMs: number;
  private initialized = false;

  constructor(options: CodexAppServerOptions) {
    this.dynamicTools = options.dynamicTools ?? defaultDynamicTools();
    this.approvalPolicy = options.approvalPolicy;
    this.sandbox = options.sandbox;
    this.turnSandboxPolicy = options.turnSandboxPolicy;
    this.baseInstructions = options.baseInstructions;
    this.readTimeoutMs = options.readTimeoutMs ?? 5_000;
    const command = appServerCommand(options.command);
    this.child = spawn(command.file, command.args, {
      cwd: options.cwd,
      env: { ...process.env, CODEX_HOME: options.codexHome },
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"]
    });
    this.client = new CodexJsonRpcClient({
      write: (line) => this.child.stdin.write(line),
      close: () => this.child.kill()
    });
    this.client.onNotification((notification) => options.onNotification?.(notification.method, notification.params));
    this.client.onRequest(async (request) => {
      if (!options.onServerRequest) {
        throw new Error(`No Symphony handler for app-server request ${request.method}`);
      }
      return options.onServerRequest(request);
    });
    this.child.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      options.onStdout?.(text);
      try {
        this.client.acceptChunk(text);
      } catch (error) {
        options.onProtocolError?.(error as Error, text);
        this.close();
      }
    });
    this.child.stderr.on("data", (chunk: Buffer) => options.onStderr?.(chunk.toString("utf8")));
    this.child.on("exit", (exitCode, signal) => options.onExit?.(exitCode, signal));
  }

  get pid(): number | undefined {
    return this.child.pid;
  }

  async startTurn(prompt: string, cwd: string): Promise<StartedTurn> {
    await this.initialize();
    const threadParams = buildThreadStartParams({
      cwd,
      prompt,
      approvalPolicy: this.approvalPolicy,
      sandbox: this.sandbox,
      turnSandboxPolicy: this.turnSandboxPolicy,
      dynamicTools: this.dynamicTools,
      ...(this.baseInstructions ? { baseInstructions: this.baseInstructions } : {})
    });
    const thread = await requestWithTimeout(this.client.request<ThreadStartResponse>("thread/start", threadParams), this.readTimeoutMs);
    return this.continueTurn(thread.thread.id, prompt, cwd);
  }

  async continueTurn(threadId: string, prompt: string, cwd: string): Promise<StartedTurn> {
    await this.initialize();
    const turnParams: TurnStartParams = {
      threadId,
      cwd,
      approvalPolicy: normalizeApprovalPolicy(this.approvalPolicy),
      sandboxPolicy: normalizeTurnSandboxPolicy(this.turnSandboxPolicy),
      input: [{ type: "text", text: prompt, text_elements: [] }]
    };
    const turn = await requestWithTimeout(this.client.request<TurnStartResponse>("turn/start", turnParams), this.readTimeoutMs);
    return { threadId, turnId: turn.turn.id };
  }

  close(): void {
    this.client.close();
  }

  private async initialize(): Promise<void> {
    if (this.initialized) return;
    const initializeParams: InitializeParams = {
      clientInfo: {
        name: "symphony-electron",
        title: "Symphony Electron",
        version: "0.1.0"
      },
      capabilities: {
        experimentalApi: true,
        optOutNotificationMethods: []
      }
    };
    await requestWithTimeout(this.client.request("initialize", initializeParams), this.readTimeoutMs);
    this.client.notify("initialized");
    this.initialized = true;
  }
}

/**
 * Build thread-start parameters by normalizing policies and supplying sensible defaults.
 *
 * @param options - Configuration for the thread start: `cwd` (workspace path); optional `approvalPolicy`, `sandbox`, `baseInstructions`, and `dynamicTools`.
 * @returns A ThreadStartParams object with `approvalPolicy` and `sandbox` normalized, `baseInstructions` and `dynamicTools` defaulted when absent, `approvalsReviewer` set to `"auto_review"`, `serviceName` set to `"symphony-electron"`, `experimentalRawEvents` set to `false`, and `persistExtendedHistory` set to `true`.
 */
export function buildThreadStartParams(options: ThreadParamOptions): ThreadStartParams {
  return {
    cwd: options.cwd,
    approvalPolicy: normalizeApprovalPolicy(options.approvalPolicy),
    approvalsReviewer: "auto_review",
    sandbox: normalizeSandbox(options.sandbox),
    baseInstructions:
      options.baseInstructions ?? "You are running inside Symphony Electron. Work only in the provided workspace and emit concise status updates.",
    serviceName: "symphony-electron",
    dynamicTools: options.dynamicTools ?? defaultDynamicTools(),
    experimentalRawEvents: false,
    persistExtendedHistory: true
  };
}

/**
 * Provide the default dynamic tool specifications used when no custom tools are supplied.
 *
 * @returns An array containing the default `DynamicToolSpec` for a Linear GraphQL tool that requires a `query` string and accepts an optional `variables` object
 */
function defaultDynamicTools(): DynamicToolSpec[] {
  return [
    {
      namespace: "linear",
      name: "linear_graphql",
      description: "Run a scoped Linear GraphQL operation for the current issue workflow.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string" },
          variables: { type: "object" }
        },
        required: ["query"],
        additionalProperties: false
      }
    }
  ];
}

/**
 * Normalize an approval policy specification into an AskForApproval value.
 *
 * @param value - The approval policy input; either one of the strings `"untrusted"`, `"on-failure"`, `"on-request"`, `"never"`, or an object containing a `granular` key describing a granular policy.
 * @returns The normalized `AskForApproval` value: the original allowed string, the provided granular object, or `"on-request"` when the input is not a recognized form.
 */
function normalizeApprovalPolicy(value: unknown): AskForApproval {
  if (value === "untrusted" || value === "on-failure" || value === "on-request" || value === "never") {
    return value;
  }
  if (isRecord(value) && "granular" in value) {
    return value as AskForApproval;
  }
  return "on-request";
}

/**
 * Normalize a sandbox mode value into a valid sandbox mode.
 *
 * @param value - Candidate sandbox mode; accepted values are "read-only", "workspace-write", and "danger-full-access". Any other input will be treated as `"workspace-write"`.
 * @returns The normalized sandbox mode: `"read-only"`, `"workspace-write"`, or `"danger-full-access"`, with a default of `"workspace-write"`.
 */
function normalizeSandbox(value: unknown): SandboxMode {
  if (value === "read-only" || value === "workspace-write" || value === "danger-full-access") {
    return value;
  }
  return "workspace-write";
}

function normalizeTurnSandboxPolicy(value: unknown): SandboxPolicy | null {
  if (isRecord(value) && typeof value.type === "string") {
    return value as SandboxPolicy;
  }
  return null;
}

/**
 * Determine the executable file and argument list for launching the app-server.
 *
 * @param command - Command string to parse (defaults to "codex app-server")
 * @returns An object with `file` set to the executable name and `args` containing the arguments; ensures `--listen stdio://` is present
 */
function appServerCommand(command = "codex app-server"): { file: string; args: string[] } {
  const tokens = splitCommand(command);
  const [file = "codex", ...args] = tokens.length ? tokens : ["codex", "app-server"];
  const normalizedArgs = args.length ? [...args] : ["app-server"];
  if (!normalizedArgs.includes("--listen")) {
    normalizedArgs.push("--listen", "stdio://");
  }
  return { file, args: normalizedArgs };
}

/**
 * Splits a shell-like command string into tokens, preserving quoted segments.
 *
 * @param command - The command string to tokenize; supports double-quoted ("..."), single-quoted ('...'), and unquoted tokens.
 * @returns An array of non-empty tokens with surrounding quotes removed.
 */
function splitCommand(command: string): string[] {
  const tokens: string[] = [];
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g;
  for (const match of command.matchAll(pattern)) {
    tokens.push(match[1] ?? match[2] ?? match[3] ?? "");
  }
  return tokens.filter(Boolean);
}

/**
 * Complete the provided operation within the specified time limit or fail with a timeout error.
 *
 * @param promise - The operation to wait for.
 * @param timeoutMs - Time limit in milliseconds; if less than or equal to 0, no timeout is applied.
 * @returns The resolved value of `promise` if it completes before the timeout; rejects with an `Error` describing the timeout otherwise.
 */
function requestWithTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  if (timeoutMs <= 0) return promise;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => reject(new Error(`Codex app-server request timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timeout) clearTimeout(timeout);
  });
}

/**
 * Determines whether a value is a non-null object suitable for use as a record.
 *
 * @returns `true` if `value` is an object and not `null`, `false` otherwise.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
