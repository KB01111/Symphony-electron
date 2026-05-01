import type { RunEvent, RunTranscriptItem } from "./types.js";

export function eventToTranscriptItem(event: RunEvent): RunTranscriptItem {
  const payload = event.payload as Record<string, unknown> | undefined;
  const delta = typeof payload?.delta === "string" ? payload.delta : undefined;
  const role: RunTranscriptItem["role"] = event.type.includes("agentMessage")
    ? "agent"
    : event.type.includes("reasoning")
      ? "reasoning"
      : event.type.includes("command") || event.type.includes("tool") || event.type.includes("stdout") || event.type.includes("stderr")
        ? "tool"
        : "system";

  return {
    id: event.id,
    runId: event.runId,
    timestamp: event.timestamp,
    role,
    title: event.type.replace(/^codex\./, ""),
    text: event.message ?? delta ?? stringifyPayload(event.payload)
  };
}

function stringifyPayload(payload: unknown): string {
  if (payload === undefined || payload === null) return "";
  if (typeof payload === "string") return payload;
  return JSON.stringify(payload, null, 2);
}
