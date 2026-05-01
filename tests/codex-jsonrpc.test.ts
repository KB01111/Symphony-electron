import { expect, test, vi } from "vitest";
import { CodexJsonRpcClient, JsonRpcLineBuffer } from "../src/main/services/codex-jsonrpc.js";

test("line buffer parses newline-delimited JSON-RPC messages", () => {
  const buffer = new JsonRpcLineBuffer();

  const messages = buffer.push('{"id":1,"result":{"ok":true}}\n{"method":"turn/started","params":{"id":"t1"}}\n');

  expect(messages).toEqual([
    { id: 1, result: { ok: true } },
    { method: "turn/started", params: { id: "t1" } }
  ]);
});

test("client resolves matching responses and emits notifications", async () => {
  let written = "";
  const transport = {
    write: vi.fn((line: string) => {
      written += line;
    }),
    close: vi.fn()
  };
  const client = new CodexJsonRpcClient(transport);
  const notifications: unknown[] = [];
  client.onNotification((message) => notifications.push(message));

  const pending = client.request("initialize", { client: "test" });
  expect(JSON.parse(written)).toMatchObject({ id: 1, method: "initialize" });

  client.acceptLine('{"method":"turn/started","params":{"turnId":"turn-1"}}');
  client.acceptLine('{"id":1,"result":{"server":"ready"}}');

  await expect(pending).resolves.toEqual({ server: "ready" });
  expect(notifications).toEqual([{ method: "turn/started", params: { turnId: "turn-1" } }]);
});

