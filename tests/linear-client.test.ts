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
                  labels: { nodes: [{ name: "UI" }, { name: "Automation" }] },
                  relations: {
                    nodes: [
                      {
                        type: "blocks",
                        relatedIssue: {
                          id: "lin-0",
                          identifier: "ENG-1",
                          state: { name: "Done" },
                          createdAt: "2026-04-30T10:00:00.000Z",
                          updatedAt: "2026-05-01T09:00:00.000Z"
                        }
                      },
                      {
                        type: "blocked",
                        relatedIssue: {
                          id: "lin-2",
                          identifier: "ENG-43",
                          state: { name: "In Progress" },
                          createdAt: "2026-04-30T11:00:00.000Z",
                          updatedAt: "2026-05-01T11:00:00.000Z"
                        }
                      }
                    ]
                  },
                  branchName: "kevin/eng-42",
                  createdAt: "2026-04-30T10:00:00.000Z",
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
      labels: ["ui", "automation"],
      blockers: [
        {
          id: "lin-0",
          identifier: "ENG-1",
          relationType: "blocks",
          state: "Done",
          createdAt: "2026-04-30T10:00:00.000Z",
          updatedAt: "2026-05-01T09:00:00.000Z"
        },
        {
          id: "lin-2",
          identifier: "ENG-43",
          relationType: "blocked",
          state: "In Progress",
          createdAt: "2026-04-30T11:00:00.000Z",
          updatedAt: "2026-05-01T11:00:00.000Z"
        }
      ],
      branchName: "kevin/eng-42",
      createdAt: "2026-04-30T10:00:00.000Z",
      updatedAt: "2026-05-01T10:00:00.000Z"
    }
  ]);
});

test("paginates Linear issue syncs", async () => {
  const cursors: unknown[] = [];
  const client = new LinearClient({
    fetch: async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { variables: { after?: string | null } };
      cursors.push(body.variables.after);
      const secondPage = body.variables.after === "cursor-1";
      return new Response(
        JSON.stringify({
          data: {
            issues: {
              pageInfo: { hasNextPage: !secondPage, endCursor: secondPage ? null : "cursor-1" },
              nodes: [
                {
                  id: secondPage ? "lin-2" : "lin-1",
                  identifier: secondPage ? "ENG-2" : "ENG-1",
                  title: secondPage ? "Second" : "First",
                  description: "",
                  priority: 0,
                  state: { name: "Ready" },
                  labels: { nodes: [] },
                  relations: { nodes: [] },
                  updatedAt: "2026-05-01T10:00:00.000Z"
                }
              ]
            }
          }
        }),
        { status: 200 }
      );
    }
  });

  const issues = await client.listIssues({ apiKey: "lin_test", activeStateNames: ["Ready"] });

  expect(cursors).toEqual([null, "cursor-1"]);
  expect(issues.map((issue) => issue.identifier)).toEqual(["ENG-1", "ENG-2"]);
});

test("adds comments and transitions issues by workflow state name", async () => {
  const operations: string[] = [];
  const client = new LinearClient({
    fetch: async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { query: string };
      operations.push(body.query);
      if (body.query.includes("workflowStates")) {
        return new Response(
          JSON.stringify({
            data: {
              workflowStates: {
                nodes: [{ id: "state-review", name: "Human Review", type: "started" }]
              }
            }
          }),
          { status: 200 }
        );
      }
      return new Response(JSON.stringify({ data: { issueUpdate: { success: true }, commentCreate: { success: true } } }), { status: 200 });
    }
  });

  await client.addComment({ apiKey: "lin_test", activeStateNames: ["Ready"] }, "lin-1", "Ready for review");
  await client.transitionIssue({ apiKey: "lin_test", activeStateNames: ["Ready"] }, "lin-1", "Human Review", "ENG");

  expect(operations.some((operation) => operation.includes("commentCreate"))).toBe(true);
  expect(operations.some((operation) => operation.includes("issueUpdate"))).toBe(true);
});

test("caches workflow states for repeated transitions", async () => {
  let stateFetches = 0;
  const client = new LinearClient({
    fetch: async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { query: string };
      if (body.query.includes("workflowStates")) {
        stateFetches += 1;
        return new Response(
          JSON.stringify({
            data: {
              workflowStates: {
                nodes: [{ id: "state-review", name: "Human Review", type: "started" }]
              }
            }
          }),
          { status: 200 }
        );
      }
      return new Response(JSON.stringify({ data: { issueUpdate: { success: true } } }), { status: 200 });
    }
  });
  const config = { apiKey: "lin_test", teamKey: "ENG", activeStateNames: ["Ready"] };

  await client.transitionIssue(config, "lin-1", "Human Review", "ENG");
  await client.transitionIssue(config, "lin-2", "Human Review", "ENG");

  expect(stateFetches).toBe(1);
});
