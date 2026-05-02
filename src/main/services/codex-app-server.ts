import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { InitializeParams } from "../../generated/codex-app-server/InitializeParams.js";
import type { JsonRpcId } from "./codex-jsonrpc.js";
import type { ThreadStartParams } from "../../generated/codex-app-server/v2/ThreadStartParams.js";
import type { ThreadStartResponse } from "../../generated/codex-app-server/v2/ThreadStartResponse.js";
import type { TurnStartParams } from "../../generated/codex-app-server/v2/TurnStartParams.js";
import { CodexJsonRpcClient } from "./codex-jsonrpc.js";

export interface CodexAppServerOptions {
  codexHome: string;
  cwd: string;
  onStdout?(chunk: string): void;
  onStderr?(chunk: string): void;
  onNotification?(method: string, params: unknown): void;
  onRequest?(method: string, params: unknown, id: JsonRpcId): void;
  onProtocolError?(error: Error, chunk: string): void;
  onExit?(exitCode: number | null, signal: NodeJS.Signals | null): void;
}

export class CodexAppServerProcess {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly client: CodexJsonRpcClient;

  constructor(options: CodexAppServerOptions) {
    this.child = spawn("codex", ["app-server", "--listen", "stdio://"], {
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
    this.client.onRequest((request) => options.onRequest?.(request.method, request.params, request.id));
    this.child.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      options.onStdout?.(text);
      try {
        this.client.acceptChunk(text);
      } catch (error) {
        options.onProtocolError?.(error as Error, text);
      }
    });
    this.child.stderr.on("data", (chunk: Buffer) => options.onStderr?.(chunk.toString("utf8")));
    this.child.on("exit", (exitCode, signal) => options.onExit?.(exitCode, signal));
  }

  get pid(): number | undefined {
    return this.child.pid;
  }

  async startTurn(prompt: string, cwd: string): Promise<void> {
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
    await this.client.request("initialize", initializeParams);
    this.client.notify("initialized");

    const threadParams: ThreadStartParams = {
      cwd,
      approvalPolicy: "on-request",
      approvalsReviewer: "auto_review",
      sandbox: "workspace-write",
      baseInstructions: "You are running inside Symphony Electron. Work only in the provided workspace and emit concise status updates.",
      experimentalRawEvents: false,
      persistExtendedHistory: true
    };
    const thread = await this.client.request<ThreadStartResponse>("thread/start", threadParams);
    const turnParams: TurnStartParams = {
      threadId: thread.thread.id,
      cwd,
      input: [{ type: "text", text: prompt, text_elements: [] }]
    };
    await this.client.request("turn/start", turnParams);
  }

  close(): void {
    this.client.close();
  }

  respondToRequest(id: JsonRpcId, result: unknown): void {
    this.client.respond(id, result);
  }

  rejectRequest(id: JsonRpcId, code: number, message: string, data?: unknown): void {
    this.client.respondError(id, code, message, data);
  }
}

