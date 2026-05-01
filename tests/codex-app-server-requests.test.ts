import { expect, test } from "vitest";
import { CodexJsonRpcClient, type JsonRpcRequest } from "../src/main/services/codex-jsonrpc.js";

test("routes app-server requests and writes responses", async () => {
  const written: string[] = [];
  const client = new CodexJsonRpcClient({
    write: (line) => written.push(line.trim()),
    close: () => undefined
  });

  client.onRequest(async (request: JsonRpcRequest) => {
    expect(request.method).toBe("item/tool/call");
    return { output: "ok" };
  });

  client.acceptLine(JSON.stringify({ id: 7, method: "item/tool/call", params: { tool: "linear_graphql" } }));
  await new Promise((resolve) => setTimeout(resolve, 0));

  expect(JSON.parse(written[0]!)).toEqual({ id: 7, result: { output: "ok" } });
});

test("rejects app-server requests when no handler is registered", async () => {
  const written: string[] = [];
  const client = new CodexJsonRpcClient({
    write: (line) => written.push(line.trim()),
    close: () => undefined
  });

  client.acceptLine(JSON.stringify({ id: "approval-1", method: "item/commandExecution/requestApproval", params: {} }));
  await new Promise((resolve) => setTimeout(resolve, 0));

  const response = JSON.parse(written[0]!) as { id: string; error: { message: string } };
  expect(response.id).toBe("approval-1");
  expect(response.error.message).toContain("No handler");
});
