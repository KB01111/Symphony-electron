export type JsonRpcId = string | number;

export interface JsonRpcRequest {
  id: JsonRpcId;
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  id: JsonRpcId;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

export interface JsonRpcNotification {
  method: string;
  params?: unknown;
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcResponse | JsonRpcNotification;

export interface JsonRpcTransport {
  write(line: string): void;
  close(): void;
}

type PendingRequest = {
  resolve(value: unknown): void;
  reject(error: Error): void;
};

export class JsonRpcLineBuffer {
  private buffered = "";

  push(chunk: string): JsonRpcMessage[] {
    this.buffered += chunk;
    const lines = this.buffered.split(/\r?\n/);
    this.buffered = lines.pop() ?? "";
    return lines.filter(Boolean).map((line) => JSON.parse(line) as JsonRpcMessage);
  }
}

export class CodexJsonRpcClient {
  private nextId = 1;
  private readonly pending = new Map<JsonRpcId, PendingRequest>();
  private readonly notifications = new Set<(message: JsonRpcNotification) => void>();
  private readonly buffer = new JsonRpcLineBuffer();

  constructor(private readonly transport: JsonRpcTransport) {}

  request<T = unknown>(method: string, params?: unknown): Promise<T> {
    const id = this.nextId++;
    const message: JsonRpcRequest = { id, method, params };
    const promise = new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject
      });
    });
    this.transport.write(`${JSON.stringify(message)}\n`);
    return promise;
  }

  notify(method: string, params?: unknown): void {
    this.transport.write(`${JSON.stringify({ method, params })}\n`);
  }

  acceptChunk(chunk: string): void {
    for (const message of this.buffer.push(chunk)) {
      this.acceptMessage(message);
    }
  }

  acceptLine(line: string): void {
    this.acceptMessage(JSON.parse(line) as JsonRpcMessage);
  }

  onNotification(callback: (message: JsonRpcNotification) => void): () => void {
    this.notifications.add(callback);
    return () => this.notifications.delete(callback);
  }

  close(): void {
    this.transport.close();
    for (const [id, pending] of this.pending) {
      pending.reject(new Error(`Codex app-server transport closed before response ${String(id)}`));
    }
    this.pending.clear();
  }

  private acceptMessage(message: JsonRpcMessage): void {
    if ("id" in message && ("result" in message || "error" in message)) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(new Error(message.error.message));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if ("method" in message && !("id" in message)) {
      for (const callback of this.notifications) {
        callback(message);
      }
    }
  }
}

