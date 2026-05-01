import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { JsonlEventLog } from "../src/main/services/event-log.js";

const tempDirs: string[] = [];

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "symphony-log-"));
  tempDirs.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

test("appends run events as JSONL and replays them in order", async () => {
  const root = await tempRoot();
  const log = new JsonlEventLog(root);

  await log.append("run-1", { type: "run.started", message: "first" });
  await log.append("run-1", { type: "run.output", message: "second", stream: "stdout" });

  const replayed = await log.replay("run-1");
  expect(replayed.map((event) => event.type)).toEqual(["run.started", "run.output"]);
  expect(replayed[0]?.runId).toBe("run-1");
  expect(replayed[0]?.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);

  const raw = await readFile(path.join(root, "runs", "run-1.jsonl"), "utf8");
  expect(raw.trim().split("\n")).toHaveLength(2);
});

