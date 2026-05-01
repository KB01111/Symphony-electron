# Symphony Electron

Windows-first Electron control plane for running Codex app-server sessions against Linear work in isolated workspaces.

## Stack

- Electron + TypeScript through `electron-vite`
- Svelte + Vite renderer
- Tailwind v4 with local shadcn-style Svelte primitives
- Codex app-server over stdio with generated TypeScript protocol bindings
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
