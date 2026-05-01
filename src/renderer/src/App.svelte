<script lang="ts">
  import {
    Activity,
    Archive,
    Bot,
    CheckCircle2,
    CircleAlert,
    ExternalLink,
    Play,
    RefreshCw,
    ShieldCheck,
    Square,
    Terminal,
    UserPlus
  } from "lucide-svelte";
  import type { HealthCheckResult, LinearConfig, Profile, Run, RunEvent, Task } from "../../shared/types";
  import Badge from "./lib/components/ui/Badge.svelte";
  import Button from "./lib/components/ui/Button.svelte";
  import Card from "./lib/components/ui/Card.svelte";
  import Input from "./lib/components/ui/Input.svelte";

  let profiles: Profile[] = [];
  let tasks: Task[] = [];
  let runs: Run[] = [];
  let health: HealthCheckResult[] = [];
  let selectedProfileId = "";
  let selectedTaskId = "";
  let selectedRunId = "";
  let events: RunEvent[] = [];
  let busy = false;
  let status = "Starting";
  let newProfileName = "Default Codex";
  let linearTeamKey = "";
  let linearConfig: LinearConfig = {
    apiKey: "",
    activeStateNames: ["Ready", "Todo", "In Progress"],
    pollIntervalSeconds: 60
  };

  const api = window.symphony;

  $: selectedTask = tasks.find((task) => task.id === selectedTaskId) ?? tasks[0];
  $: selectedRun = runs.find((run) => run.id === selectedRunId) ?? runs[0];
  $: selectedProfile = profiles.find((profile) => profile.id === selectedProfileId) ?? profiles[0];
  $: runByTask = new Map(runs.map((run) => [run.taskId, run]));

  async function refresh(): Promise<void> {
    profiles = await api.profiles.list();
    tasks = await api.tasks.list();
    health = await api.health.checkAll();
    if (!selectedProfileId && profiles[0]) selectedProfileId = profiles[0].id;
    if (!selectedTaskId && tasks[0]) selectedTaskId = tasks[0].id;
    if (selectedRun?.id) events = await api.runs.getEvents(selectedRun.id);
    status = "Ready";
  }

  async function runAction(action: () => Promise<void>, label: string): Promise<void> {
    busy = true;
    status = label;
    try {
      await action();
      await refresh();
    } catch (error) {
      status = (error as Error).message;
    } finally {
      busy = false;
    }
  }

  async function createProfile(): Promise<void> {
    await runAction(async () => {
      const profile = await api.profiles.create({ name: newProfileName });
      selectedProfileId = profile.id;
    }, "Creating profile");
  }

  async function startLogin(): Promise<void> {
    if (!selectedProfile) return;
    await runAction(async () => {
      await api.profiles.startLogin(selectedProfile.id);
    }, "Starting Codex OAuth");
  }

  async function saveLinear(): Promise<void> {
    await runAction(async () => {
      await api.linear.saveConfig({
        ...linearConfig,
        teamKey: linearTeamKey,
        activeStateNames: linearConfig.activeStateNames
      });
    }, "Saving Linear config");
  }

  async function syncLinear(): Promise<void> {
    await runAction(async () => {
      tasks = await api.linear.syncNow();
      selectedTaskId = tasks[0]?.id ?? "";
    }, "Syncing Linear");
  }

  async function startRun(task: Task): Promise<void> {
    if (!selectedProfile) return;
    await runAction(async () => {
      const run = await api.runs.start(task.id, selectedProfile.id);
      selectedRunId = run.id;
    }, `Starting ${task.identifier}`);
  }

  async function cancelRun(run: Run): Promise<void> {
    await runAction(async () => {
      await api.runs.cancel(run.id);
    }, "Cancelling run");
  }

  async function refreshEvents(run?: Run): Promise<void> {
    if (!run) return;
    events = await api.runs.getEvents(run.id);
    selectedRunId = run.id;
  }

  void refresh();
</script>

<main class="min-h-screen text-stone-950">
  <div class="grid min-h-screen grid-cols-[280px_minmax(0,1fr)]">
    <aside class="border-r border-stone-200 bg-stone-100/70 px-4 py-5">
      <div class="mb-7 flex items-center gap-3">
        <div class="grid h-10 w-10 place-items-center rounded-lg bg-stone-950 text-stone-50">
          <Bot size={21} />
        </div>
        <div>
          <h1 class="text-lg font-semibold leading-tight">Symphony</h1>
          <p class="text-xs text-stone-500">Codex control plane</p>
        </div>
      </div>

      <div class="space-y-5">
        <section>
          <div class="mb-2 flex items-center justify-between">
            <h2 class="text-xs font-semibold uppercase tracking-wide text-stone-500">Profiles</h2>
            <Badge tone={profiles.length ? "good" : "warn"}>{profiles.length}</Badge>
          </div>
          <div class="space-y-2">
            {#each profiles as profile}
              <button
                class="w-full rounded-md border px-3 py-2 text-left text-sm transition {selectedProfileId === profile.id
                  ? 'border-stone-900 bg-stone-50'
                  : 'border-stone-200 bg-transparent hover:bg-stone-50'}"
                on:click={() => (selectedProfileId = profile.id)}
              >
                <span class="block font-medium">{profile.name}</span>
                <span class="block truncate text-xs text-stone-500">{profile.codexHome}</span>
              </button>
            {/each}
          </div>
          <div class="mt-3 flex gap-2">
            <Input bind:value={newProfileName} className="h-8" />
            <Button variant="secondary" className="h-8 px-2" on:click={createProfile} disabled={busy}>
              <UserPlus size={16} />
            </Button>
          </div>
          <Button variant="ghost" className="mt-2 w-full justify-start" on:click={startLogin} disabled={!selectedProfile || busy}>
            <ExternalLink size={16} />
            Codex OAuth
          </Button>
        </section>

        <section>
          <div class="mb-2 flex items-center justify-between">
            <h2 class="text-xs font-semibold uppercase tracking-wide text-stone-500">Health</h2>
            <Button variant="ghost" className="h-7 px-2" on:click={refresh} disabled={busy}>
              <RefreshCw size={14} />
            </Button>
          </div>
          <div class="space-y-2">
            {#each health as check}
              <div class="rounded-md border border-stone-200 bg-stone-50 px-3 py-2">
                <div class="flex items-center justify-between gap-2">
                  <span class="text-sm font-medium">{check.label}</span>
                  {#if check.ok}
                    <CheckCircle2 class="text-emerald-700" size={16} />
                  {:else}
                    <CircleAlert class="text-amber-700" size={16} />
                  {/if}
                </div>
                <p class="mt-1 line-clamp-2 text-xs text-stone-500">{check.detail}</p>
              </div>
            {/each}
          </div>
        </section>
      </div>
    </aside>

    <section class="grid grid-rows-[auto_minmax(0,1fr)]">
      <header class="border-b border-stone-200 bg-stone-50/80 px-6 py-4">
        <div class="flex items-center justify-between gap-4">
          <div>
            <p class="text-xs font-semibold uppercase tracking-wide text-stone-500">Windows-first orchestration</p>
            <h2 class="mt-1 text-2xl font-semibold tracking-tight">Linear work into isolated Codex runs</h2>
          </div>
          <div class="flex items-center gap-2">
            <Badge tone={busy ? "warn" : "good"}>{status}</Badge>
            <Button on:click={refresh} disabled={busy}>
              <RefreshCw size={16} />
              Refresh
            </Button>
          </div>
        </div>
      </header>

      <div class="grid min-h-0 grid-cols-[380px_minmax(0,1fr)] gap-5 p-5">
        <div class="min-h-0 space-y-5 overflow-auto">
          <Card className="p-4">
            <div class="mb-3 flex items-center justify-between">
              <div>
                <h3 class="font-semibold">Linear intake</h3>
                <p class="text-sm text-stone-500">Read-only issue sync for v1.</p>
              </div>
              <Activity size={19} class="text-stone-500" />
            </div>
            <div class="space-y-2">
              <Input type="password" bind:value={linearConfig.apiKey} placeholder="Linear API key" />
              <Input bind:value={linearTeamKey} placeholder="Team key, optional" />
              <Input
                value={linearConfig.activeStateNames.join(", ")}
                placeholder="Ready, Todo, In Progress"
                on:input={(event) =>
                  (linearConfig.activeStateNames = (event.currentTarget as HTMLInputElement).value.split(",").map((item) => item.trim()))}
              />
              <div class="flex gap-2">
                <Button variant="secondary" on:click={saveLinear} disabled={busy}>Save</Button>
                <Button variant="primary" on:click={syncLinear} disabled={busy || !linearConfig.apiKey}>Sync</Button>
              </div>
            </div>
          </Card>

          <Card className="min-h-[360px] p-4">
            <div class="mb-3 flex items-center justify-between">
              <h3 class="font-semibold">Task queue</h3>
              <Badge tone="info">{tasks.length}</Badge>
            </div>
            <div class="space-y-2">
              {#each tasks as task}
                <button
                  class="w-full rounded-md border p-3 text-left transition {selectedTaskId === task.id
                    ? 'border-stone-900 bg-stone-100'
                    : 'border-stone-200 bg-stone-50 hover:bg-stone-100'}"
                  on:click={() => (selectedTaskId = task.id)}
                >
                  <div class="flex items-start justify-between gap-2">
                    <div>
                      <p class="font-medium">{task.identifier}</p>
                      <p class="mt-0.5 line-clamp-2 text-sm text-stone-600">{task.title}</p>
                    </div>
                    <Badge tone={task.status === "In Progress" ? "warn" : "neutral"}>{task.status}</Badge>
                  </div>
                </button>
              {:else}
                <div class="rounded-md border border-dashed border-stone-300 p-4 text-sm text-stone-500">
                  Configure Linear and sync to populate work.
                </div>
              {/each}
            </div>
          </Card>
        </div>

        <div class="grid min-h-0 grid-rows-[auto_minmax(0,1fr)] gap-5">
          <Card className="p-4">
            {#if selectedTask}
              <div class="flex items-start justify-between gap-4">
                <div>
                  <div class="mb-2 flex items-center gap-2">
                    <Badge tone="neutral">{selectedTask.identifier}</Badge>
                    <Badge tone="info">{selectedTask.source}</Badge>
                    {#if runByTask.get(selectedTask.id)}
                      <Badge tone="warn">{runByTask.get(selectedTask.id)?.state}</Badge>
                    {/if}
                  </div>
                  <h3 class="text-xl font-semibold">{selectedTask.title}</h3>
                  <p class="mt-2 max-w-3xl text-sm leading-6 text-stone-600">{selectedTask.description || "No Linear description."}</p>
                </div>
                <div class="flex gap-2">
                  <Button variant="primary" on:click={() => startRun(selectedTask)} disabled={!selectedProfile || busy}>
                    <Play size={16} />
                    Start
                  </Button>
                  <Button variant="secondary" on:click={() => api.tasks.archive(selectedTask.id).then(refresh)} disabled={busy}>
                    <Archive size={16} />
                  </Button>
                </div>
              </div>
            {:else}
              <p class="text-sm text-stone-500">Select a task to start an isolated Codex workspace.</p>
            {/if}
          </Card>

          <div class="grid min-h-0 grid-cols-[300px_minmax(0,1fr)] gap-5">
            <Card className="min-h-0 overflow-hidden">
              <div class="border-b border-stone-200 px-4 py-3">
                <h3 class="font-semibold">Sandboxes</h3>
              </div>
              <div class="h-full overflow-auto p-3">
                {#each runs as run}
                  <button
                    class="mb-2 w-full rounded-md border px-3 py-2 text-left text-sm transition {selectedRunId === run.id
                      ? 'border-stone-900 bg-stone-100'
                      : 'border-stone-200 bg-stone-50 hover:bg-stone-100'}"
                    on:click={() => refreshEvents(run)}
                  >
                    <div class="flex items-center justify-between gap-2">
                      <span class="truncate font-medium">{run.id}</span>
                      <Badge tone={run.state === "failed" ? "bad" : run.state === "running" ? "good" : "neutral"}>{run.state}</Badge>
                    </div>
                    <p class="mt-1 truncate text-xs text-stone-500">{run.workspacePath ?? run.taskId}</p>
                  </button>
                {:else}
                  <div class="rounded-md border border-dashed border-stone-300 p-4 text-sm text-stone-500">
                    Runs appear after a task starts.
                  </div>
                {/each}
              </div>
            </Card>

            <Card className="grid min-h-0 grid-rows-[auto_minmax(0,1fr)] overflow-hidden">
              <div class="flex items-center justify-between border-b border-stone-200 px-4 py-3">
                <div class="flex items-center gap-2">
                  <Terminal size={18} />
                  <h3 class="font-semibold">Live event stream</h3>
                </div>
                <div class="flex gap-2">
                  {#if selectedRun}
                    <Button variant="ghost" className="h-8 px-2" on:click={() => refreshEvents(selectedRun)}><RefreshCw size={15} /></Button>
                    <Button variant="danger" className="h-8 px-2" on:click={() => cancelRun(selectedRun)} disabled={busy || selectedRun.state !== "running"}>
                      <Square size={15} />
                    </Button>
                  {/if}
                </div>
              </div>
              <div class="min-h-0 overflow-auto bg-stone-950 p-4 font-mono text-xs text-stone-100">
                {#each events as event}
                  <div class="mb-3">
                    <span class="text-stone-400">{event.timestamp}</span>
                    <span class="ml-2 text-emerald-300">{event.type}</span>
                    {#if event.message}
                      <pre class="mt-1 whitespace-pre-wrap text-stone-100">{event.message}</pre>
                    {/if}
                  </div>
                {:else}
                  <div class="flex h-full min-h-80 items-center justify-center text-stone-500">
                    <div class="text-center">
                      <ShieldCheck class="mx-auto mb-3" size={26} />
                      <p>No events selected.</p>
                    </div>
                  </div>
                {/each}
              </div>
            </Card>
          </div>
        </div>
      </div>
    </section>
  </div>
</main>
