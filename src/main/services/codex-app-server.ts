import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { InitializeParams } from "../../generated/codex-app-server/InitializeParams.js";
import type { ThreadStartParams } from "../../generated/codex-app-server/v2/ThreadStartParams.js";
import type { ThreadStartResponse } from "../../generated/codex-app-server/v2/ThreadStartResponse.js";
import type { TurnStartParams } from "../../generated/codex-app-server/v2/TurnStartParams.js";
import type { TurnStartResponse } from "../../generated/codex-app-server/v2/TurnStartResponse.js";
import type { DynamicToolSpec } from "../../generated/codex-app-server/v2/DynamicToolSpec.js";
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
}

export interface StartedTurn {
  threadId: string;
  turnId: string;
}

export class CodexAppServerProcess {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly client: CodexJsonRpcClient;
  private readonly dynamicTools: DynamicToolSpec[];

  constructor(options: CodexAppServerOptions) {
    this.dynamicTools = options.dynamicTools ?? defaultDynamicTools();
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
      }
    });
    this.child.stderr.on("data", (chunk: Buffer) => options.onStderr?.(chunk.toString("utf8")));
    this.child.on("exit", (exitCode, signal) => options.onExit?.(exitCode, signal));
  }

  get pid(): number | undefined {
    return this.child.pid;
  }

  async startTurn(prompt: string, cwd: string): Promise<StartedTurn> {
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
      serviceName: "symphony-electron",
      dynamicTools: this.dynamicTools,
      experimentalRawEvents: false,
      persistExtendedHistory: true
    };
    const thread = await this.client.request<ThreadStartResponse>("thread/start", threadParams);
    const turnParams: TurnStartParams = {
      threadId: thread.thread.id,
      cwd,
      input: [{ type: "text", text: prompt, text_elements: [] }]
    };
    const turn = await this.client.request<TurnStartResponse>("turn/start", turnParams);
    return { threadId: thread.thread.id, turnId: turn.turn.id };
  }

  close(): void {
    this.client.close();
  }
}

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
