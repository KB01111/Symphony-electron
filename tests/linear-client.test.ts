import { expect, test } from "vitest";
import { LinearClient } from "../src/main/services/linear-client.js";

test("normalizes Linear issues into local tasks", async () => {
  const client = new LinearClient({
    fetch: async () =>
      new Response(
        JSON.stringify({
          data: {
            issues: {
              nodes: [
                {
                  id: "lin-1",
                  identifier: "ENG-42",
                  title: "Wire Codex app-server",
                  description: "Use stdio",
                  url: "https://linear.app/acme/issue/ENG-42",
                  priority: 2,
                  state: { name: "Ready" },
                  assignee: { name: "Kevin" },
                  team: { key: "ENG" },
                  project: { name: "Symphony" },
                  updatedAt: "2026-05-01T10:00:00.000Z"
                }
              ]
            }
          }
        }),
        { status: 200 }
      )
  });

  const issues = await client.listIssues({
    apiKey: "lin_test",
    teamKey: "ENG",
    activeStateNames: ["Ready"]
  });

  expect(issues).toEqual([
    {
      id: "linear:lin-1",
      externalId: "lin-1",
      source: "linear",
      identifier: "ENG-42",
      title: "Wire Codex app-server",
      description: "Use stdio",
      url: "https://linear.app/acme/issue/ENG-42",
      status: "Ready",
      priority: 2,
      assignee: "Kevin",
      teamKey: "ENG",
      projectName: "Symphony",
      updatedAt: "2026-05-01T10:00:00.000Z"
    }
  ]);
});

