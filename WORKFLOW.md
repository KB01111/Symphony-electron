---
tracker:
  kind: linear
  api_key: $LINEAR_API_KEY
  active_states:
    - Ready
    - Todo
    - In Progress
  terminal_states:
    - Done
    - Closed
    - Cancelled
    - Canceled
    - Duplicate
polling:
  interval_ms: 60000
agent:
  max_concurrent_agents: 2
  max_turns: 20
  max_retry_backoff_ms: 300000
codex:
  command: codex app-server
  turn_timeout_ms: 3600000
  read_timeout_ms: 5000
  stall_timeout_ms: 300000
---
# Symphony Linear Issue

Issue: {{ issue.identifier }}
Title: {{ issue.title }}
Status: {{ issue.status }}
URL: {{ issue.url }}
Labels: {{ issue.labels | join: ', ' }}

## Description

{{ issue.description }}

## Operating Rules

- Work only inside the prepared workspace.
- Preserve unrelated user changes.
- Use the repository's existing tests and commands before claiming completion.
- Leave the issue in Human Review. Do not mark it Done or merge without operator review.
- Summarize changed files, verification, and remaining risk in the final response.
