# Symphony Electron

Windows-first Electron control plane for running Codex app-server sessions against Linear work in isolated workspaces.

## V1 scope

- Polls Linear for eligible issues and dispatches them into isolated Codex profile workspaces.
- Keeps one Codex account per profile through separate `CODEX_HOME`, workspace, repo cache and log roots.
- Routes completed runs to Human Review with Linear comments/state transition instead of auto-merging or closing work.
- Shows an operator cockpit for queue state, profiles, scheduler, approvals, workflow validation, run events and AI transcripts.
- Uses `WORKFLOW.md` as the repo-owned prompt and orchestration configuration source.

## Stack

- Electron + TypeScript through `electron-vite`
- Svelte + Vite renderer
- Tailwind v4 with local shadcn-style Svelte primitives
- Codex app-server over stdio with generated TypeScript protocol bindings
- Linear GraphQL polling and review-gate mutations
- Liquid + YAML for `WORKFLOW.md`
- Pretext for transcript text measurement
- JSONL run logs and JSON state snapshots

## Commands

```powershell
$env:npm_config_cache=(Join-Path (Get-Location) '.npm-cache')
npm install
npm test
npm run typecheck
npm run typecheck:tsgo
npm run build
npm run dev
npm run test:ui
```

## Manual acceptance path

1. Create at least one Codex profile in the left rail and complete `Codex OAuth`.
2. Save Linear settings, including API key, active states and Human Review state.
3. Press `Sync now` or start the scheduler.
4. Confirm eligible Linear issues enter the queue and at most the configured concurrency starts.
5. Open a run, inspect transcript/events/approvals, and verify the workspace path is under that profile.
6. Let a successful run exit and confirm Linear receives a comment plus a move to Human Review, not Done.
