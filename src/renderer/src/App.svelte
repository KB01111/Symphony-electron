<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import { layout, prepare } from "@chenglou/pretext";
  import Activity from "lucide-svelte/icons/activity";
  import Archive from "lucide-svelte/icons/archive";
  import Bot from "lucide-svelte/icons/bot";
  import CheckCircle2 from "lucide-svelte/icons/check-circle-2";
  import CircleAlert from "lucide-svelte/icons/circle-alert";
  import Clock3 from "lucide-svelte/icons/clock-3";
  import ExternalLink from "lucide-svelte/icons/external-link";
  import GitBranch from "lucide-svelte/icons/git-branch";
  import KeyRound from "lucide-svelte/icons/key-round";
  import MessageSquareText from "lucide-svelte/icons/message-square-text";
  import Play from "lucide-svelte/icons/play";
  import RefreshCw from "lucide-svelte/icons/refresh-cw";
  import ShieldCheck from "lucide-svelte/icons/shield-check";
  import Square from "lucide-svelte/icons/square";
  import Terminal from "lucide-svelte/icons/terminal";
  import UserPlus from "lucide-svelte/icons/user-plus";
  import Workflow from "lucide-svelte/icons/workflow";
  import type {
    ApprovalRequest,
    CodexAccountStatus,
    HandoffDraft,
    HealthCheckResult,
    LinearConfig,
    OrchestratorSnapshot,
    Profile,
    ProofEntry,
    Run,
    RunEvent,
    RunTranscriptItem,
    Task,
    WorkflowSnapshot
  } from "../../shared/types";
  import Badge from "./lib/components/ui/Badge.svelte";
  import Button from "./lib/components/ui/Button.svelte";
  import Card from "./lib/components/ui/Card.svelte";
  import Input from "./lib/components/ui/Input.svelte";

  const api = window.symphony;
  const transcriptFont = '12px "Cascadia Mono", "Consolas", monospace';
  const transcriptMetricsCache = new Map<string, string>();
  const runDetailTabs = ["transcript", "events", "approvals", "proof", "workspace", "handoff"] as const;

  let profiles: Profile[] = [];
  let tasks: Task[] = [];
  let runs: Run[] = [];
  let health: HealthCheckResult[] = [];
  let approvals: ApprovalRequest[] = [];
  let accountStatuses: Record<string, CodexAccountStatus> = {};
  let workflow: WorkflowSnapshot | null = null;
  let orchestrator: OrchestratorSnapshot | null = null;
  let proof: ProofEntry[] = [];
  let handoff: HandoffDraft | null = null;
  let runDetailTab: "transcript" | "events" | "approvals" | "proof" | "workspace" | "handoff" = "transcript";
  let selectedProfileId = "";
  let selectedTaskId = "";
  let selectedRunId = "";
  let events: RunEvent[] = [];
  let transcript: RunTranscriptItem[] = [];
  let busy = false;
  let status = "Starting";
  let newProfileName = "Default Codex";
  let linearConfig: LinearConfig = {
    apiKey: "",
    activeStateNames: ["Ready", "Todo", "In Progress"],
    terminalStateNames: ["Done", "Closed", "Cancelled", "Canceled", "Duplicate"],
    humanReviewStateName: "Human Review",
    inProgressStateName: "In Progress",
    pollIntervalSeconds: 60,
    maxConcurrentRuns: 2
  };

  $: selectedTask = tasks.find((task) => task.id === selectedTaskId) ?? tasks[0];
  $: selectedRun = runs.find((run) => run.id === selectedRunId) ?? runs[0];
  $: selectedProfile = profiles.find((profile) => profile.id === selectedProfileId) ?? profiles[0];
  $: runByTask = new Map(runs.map((run) => [run.taskId, run]));
  $: activeRuns = runs.filter((run) => run.state === "preparing" || run.state === "running" || run.state === "stalled");
  $: failedRuns = runs.filter((run) => run.state === "failed");
  $: reviewRuns = runs.filter((run) => run.state === "review");
  $: pendingApprovals = approvals.filter((approval) => approval.status === "pending");

  let cleanupRunEvents: (() => void) | undefined;
  let cleanupTranscriptEvents: (() => void) | undefined;

  onMount(() => {
    cleanupRunEvents = api.events.onRunEvent((event) => {
      if (event.runId === selectedRunId) {
        events = [...events, event];
      }
      void refreshLight();
    });
    cleanupTranscriptEvents = api.events.onTranscriptItem((item) => {
      if (item.runId === selectedRunId) {
        transcript = [...transcript, item];
      }
    });
    void refresh();
  });

  onDestroy(() => {
    cleanupRunEvents?.();
    cleanupTranscriptEvents?.();
  });

  async function refresh(): Promise<void> {
    busy = true;
    try {
      const [nextProfiles, nextTasks, nextRuns, nextHealth, nextWorkflow, nextOrchestrator, nextLinearConfig] = await Promise.all([
        api.profiles.list(),
        api.tasks.list(),
        api.runs.list(),
        api.health.checkAll(),
        api.workflow.snapshot(),
        api.orchestrator.snapshot(),
        api.linear.getConfig()
      ]);
      profiles = nextProfiles;
      tasks = nextTasks;
      runs = nextRuns;
      health = nextHealth;
      workflow = nextWorkflow;
      orchestrator = nextOrchestrator;
      linearConfig = nextLinearConfig;
      if (!selectedProfileId && profiles[0]) selectedProfileId = profiles[0].id;
      if (!selectedTaskId && tasks[0]) selectedTaskId = tasks[0].id;
      if (!selectedRunId && runs[0]) selectedRunId = runs[0].id;
      await refreshAccountStatuses();
      await refreshRunDetails();
      status = "Ready";
    } catch (error) {
      status = (error as Error).message;
    } finally {
      busy = false;
    }
  }

  async function refreshLight(): Promise<void> {
    const [nextTasks, nextRuns, nextOrchestrator] = await Promise.all([api.tasks.list(), api.runs.list(), api.orchestrator.snapshot()]);
    tasks = nextTasks;
    runs = nextRuns;
    orchestrator = nextOrchestrator;
  }

  async function refreshRunDetails(run: Run | undefined = selectedRun): Promise<void> {
    if (!run) {
      events = [];
      transcript = [];
      approvals = await api.runs.listApprovals();
      proof = [];
      handoff = null;
      return;
    }
    selectedRunId = run.id;
    const [nextEvents, nextTranscript, nextApprovals, nextProof] = await Promise.all([
      api.runs.getEvents(run.id),
      api.runs.getTranscript(run.id),
      api.runs.listApprovals(),
      api.proof.list(run.id)
    ]);
    events = nextEvents;
    transcript = nextTranscript;
    approvals = nextApprovals;
    proof = nextProof;
    handoff = null;
  }

  async function refreshAccountStatuses(): Promise<void> {
    const entries = await Promise.all(profiles.map(async (profile) => [profile.id, await api.profiles.accountStatus(profile.id)] as const));
    accountStatuses = Object.fromEntries(entries);
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
      linearConfig = await api.linear.saveConfig(normalizedLinearConfig());
    }, "Saving Linear config");
  }

  async function syncLinear(): Promise<void> {
    await runAction(async () => {
      tasks = await api.linear.syncNow();
      selectedTaskId = tasks[0]?.id ?? "";
    }, "Syncing Linear");
  }

  async function tickAutomation(): Promise<void> {
    await runAction(async () => {
      orchestrator = await api.orchestrator.tick();
    }, "Dispatching eligible work");
  }

  async function toggleAutomation(): Promise<void> {
    await runAction(async () => {
      orchestrator = orchestrator?.state.paused ? { state: await api.orchestrator.resume(), queuedTaskIds: [], activeRuns: [] } : { state: await api.orchestrator.pause(), queuedTaskIds: [], activeRuns: [] };
    }, orchestrator?.state.paused ? "Resuming automation" : "Pausing automation");
  }

  async function buildHandoff(): Promise<void> {
    if (!selectedRun) return;
    await runAction(async () => {
      handoff = await api.handoff.build(selectedRun.id);
      runDetailTab = "handoff";
    }, "Building handoff");
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

  async function retryRun(run: Run): Promise<void> {
    await runAction(async () => {
      const next = await api.runs.retry(run.id);
      selectedRunId = next.id;
    }, "Retrying run");
  }

  async function respondToApproval(approval: ApprovalRequest, approved: boolean): Promise<void> {
    await runAction(async () => {
      await api.runs.respondToApproval(approval.id, approved);
    }, approved ? "Approving request" : "Denying request");
  }

  function normalizedLinearConfig(): LinearConfig {
    return {
      ...linearConfig,
      activeStateNames: splitList(linearConfig.activeStateNames.join(", ")),
      terminalStateNames: splitList((linearConfig.terminalStateNames ?? []).join(", ")),
      pollIntervalSeconds: Number(linearConfig.pollIntervalSeconds) || 60,
      maxConcurrentRuns: Number(linearConfig.maxConcurrentRuns) || 2
    };
  }

  function splitList(value: string): string[] {
    return value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  }

  function badgeTone(value: string): "neutral" | "good" | "warn" | "bad" | "info" {
    const normalized = value.toLowerCase();
    if (normalized === "running" || normalized === "done" || normalized === "ready") return "good";
    if (normalized === "failed" || normalized === "cancelled" || normalized === "canceled") return "bad";
    if (normalized === "review" || normalized.includes("progress") || normalized === "preparing") return "warn";
    if (normalized === "linear" || normalized === "queued") return "info";
    return "neutral";
  }

  function transcriptMetrics(text: string): string {
    if (!text.trim()) return "0 lines";
    const key = `${text.length}:${text.slice(0, 32)}:${text.slice(-32)}`;
    const cached = transcriptMetricsCache.get(key);
    if (cached) return cached;
    try {
      const prepared = prepare(text, transcriptFont, { whiteSpace: "pre-wrap" });
      const measured = layout(prepared, 680, 18);
      const value = `${measured.lineCount} lines, ${Math.round(measured.height)}px`;
      transcriptMetricsCache.set(key, value);
      return value;
    } catch {
      return `${text.split(/\r?\n/).length} lines`;
    }
  }

</script>

<main class="min-h-screen bg-[oklch(0.955_0.012_80)] text-stone-950">
  <div class="grid min-h-screen grid-cols-[304px_minmax(0,1fr)]">
    <aside class="border-r border-stone-300 bg-[oklch(0.93_0.014_78)] px-4 py-5">
      <div class="mb-6 flex items-center gap-3">
        <div class="grid h-10 w-10 place-items-center rounded-lg bg-stone-950 text-stone-50">
          <Bot size={21} />
        </div>
        <div>
          <h1 class="text-lg font-semibold leading-tight">Symphony</h1>
          <p class="text-xs text-stone-600">Linear to Codex operator</p>
        </div>
      </div>

      <div class="space-y-5">
        <section>
          <div class="mb-2 flex items-center justify-between">
            <h2 class="text-xs font-semibold uppercase tracking-wide text-stone-600">Codex profiles</h2>
            <Badge tone={profiles.length ? "good" : "warn"}>{profiles.length}</Badge>
          </div>
          <div class="space-y-2">
            {#each profiles as profile}
              {@const account = accountStatuses[profile.id]}
              <button
                class="w-full rounded-md border px-3 py-2 text-left text-sm transition {selectedProfileId === profile.id
                  ? 'border-stone-900 bg-stone-50'
                  : 'border-stone-300 bg-transparent hover:bg-stone-50'}"
                on:click={() => (selectedProfileId = profile.id)}
              >
                <span class="flex items-center justify-between gap-2">
                  <span class="font-medium">{profile.name}</span>
                  {#if account?.ok}
                    <CheckCircle2 class="text-emerald-700" size={15} />
                  {:else}
                    <CircleAlert class="text-amber-700" size={15} />
                  {/if}
                </span>
                <span class="mt-1 block truncate text-xs text-stone-600">{profile.codexHome}</span>
              </button>
            {:else}
              <div class="rounded-md border border-dashed border-stone-300 p-3 text-sm text-stone-600">
                Create a Codex profile to isolate account, cache, logs and workspaces.
              </div>
            {/each}
          </div>
          <div class="mt-3 flex gap-2">
            <Input bind:value={newProfileName} className="h-8" />
            <Button variant="secondary" className="h-8 px-2" on:click={createProfile} disabled={busy}>
              <UserPlus size={16} />
            </Button>
          </div>
          <Button variant="ghost" className="mt-2 w-full justify-start" on:click={startLogin} disabled={!selectedProfile || busy}>
            <KeyRound size={16} />
            Codex OAuth
          </Button>
        </section>

        <section>
          <div class="mb-2 flex items-center justify-between">
            <h2 class="text-xs font-semibold uppercase tracking-wide text-stone-600">Setup health</h2>
            <Button variant="ghost" className="h-7 px-2" on:click={refresh} disabled={busy}>
              <RefreshCw size={14} />
            </Button>
          </div>
          <div class="space-y-2">
            {#each health as check}
              <div class="rounded-md border border-stone-300 bg-stone-50 px-3 py-2">
                <div class="flex items-center justify-between gap-2">
                  <span class="text-sm font-medium">{check.label}</span>
                  {#if check.ok}
                    <CheckCircle2 class="text-emerald-700" size={16} />
                  {:else}
                    <CircleAlert class="text-amber-700" size={16} />
                  {/if}
                </div>
                <p class="mt-1 line-clamp-2 text-xs text-stone-600">{check.detail}</p>
              </div>
            {/each}
          </div>
        </section>
      </div>
    </aside>

    <section class="grid min-h-0 grid-rows-[auto_minmax(0,1fr)]">
      <header class="border-b border-stone-300 bg-stone-50 px-5 py-3">
        <div class="flex items-center justify-between gap-4">
          <div class="flex items-center gap-4">
            <div>
              <p class="text-xs font-semibold uppercase tracking-wide text-stone-600">Mostly autonomous execution</p>
              <h2 class="mt-1 text-xl font-semibold tracking-tight">Autonomous Command Center</h2>
            </div>
            <div class="hidden items-center gap-2 lg:flex">
              <Badge tone={orchestrator?.state.paused ? "neutral" : "good"}>{orchestrator?.state.paused ? "Paused" : "Polling"}</Badge>
              <Badge tone={pendingApprovals.length ? "warn" : "neutral"}>{pendingApprovals.length} approvals</Badge>
              <Badge tone={failedRuns.length ? "bad" : "neutral"}>{failedRuns.length} failed</Badge>
            </div>
          </div>
          <div class="flex items-center gap-2">
            <Badge tone={busy ? "warn" : "good"}>{status}</Badge>
            <Button variant={orchestrator?.state.paused ? "primary" : "secondary"} on:click={toggleAutomation} disabled={busy}>
              {#if orchestrator?.state.paused}<Play size={16} />{:else}<Square size={16} />{/if}
              {orchestrator?.state.paused ? "Resume automation" : "Pause automation"}
            </Button>
            <Button variant="secondary" on:click={tickAutomation} disabled={busy}>
              <Activity size={16} />
              Tick now
            </Button>
            <Button variant="ghost" on:click={refresh} disabled={busy}>
              <RefreshCw size={16} />
            </Button>
          </div>
        </div>
      </header>

      <div class="grid min-h-0 grid-cols-[380px_minmax(0,1fr)_330px] gap-4 p-4">
        <div class="min-h-0 space-y-4 overflow-auto">
          <Card className="p-4">
            <div class="mb-3 flex items-center justify-between">
              <div>
                <h3 class="font-semibold">Linear intake</h3>
                <p class="text-sm text-stone-600">Polling, filters and review-gate state.</p>
              </div>
              <ExternalLink size={18} class="text-stone-600" />
            </div>
            <div class="space-y-2">
              <Input type="password" bind:value={linearConfig.apiKey} placeholder="Linear API key" />
              <div class="grid grid-cols-2 gap-2">
                <Input bind:value={linearConfig.teamKey} placeholder="Team key" />
                <Input bind:value={linearConfig.projectName} placeholder="Project name" />
              </div>
              <Input bind:value={linearConfig.repositoryUrl} placeholder="Repository URL for worktrees" />
              <Input
                value={linearConfig.activeStateNames.join(", ")}
                placeholder="Ready, Todo, In Progress"
                on:input={(event) => (linearConfig.activeStateNames = splitList((event.currentTarget as HTMLInputElement).value))}
              />
              <div class="grid grid-cols-2 gap-2">
                <Input bind:value={linearConfig.inProgressStateName} placeholder="In Progress state" />
                <Input bind:value={linearConfig.humanReviewStateName} placeholder="Human Review state" />
              </div>
              <div class="grid grid-cols-2 gap-2">
                <Input bind:value={linearConfig.pollIntervalSeconds} type="number" placeholder="Poll seconds" />
                <Input bind:value={linearConfig.maxConcurrentRuns} type="number" placeholder="Max runs" />
              </div>
              <div class="flex gap-2">
                <Button variant="secondary" on:click={saveLinear} disabled={busy}>Save</Button>
                <Button variant="primary" on:click={syncLinear} disabled={busy || !linearConfig.apiKey}>Sync now</Button>
              </div>
            </div>
          </Card>

          <Card className="min-h-[420px] p-4">
            <div class="mb-3 flex items-center justify-between">
              <h3 class="font-semibold">Issue queue</h3>
              <Badge tone="info">{tasks.length}</Badge>
            </div>
            <div class="space-y-2">
              {#each tasks as task}
                {@const run = runByTask.get(task.id)}
                <button
                  class="w-full rounded-md border p-3 text-left transition {selectedTaskId === task.id
                    ? 'border-stone-900 bg-stone-100'
                    : 'border-stone-300 bg-stone-50 hover:bg-stone-100'}"
                  on:click={() => (selectedTaskId = task.id)}
                >
                  <div class="flex items-start justify-between gap-2">
                    <div class="min-w-0">
                      <p class="font-medium">{task.identifier}</p>
                      <p class="mt-0.5 line-clamp-2 text-sm text-stone-700">{task.title}</p>
                    </div>
                    <Badge tone={badgeTone(run?.state ?? task.status)}>{run?.state ?? task.status}</Badge>
                  </div>
                  <div class="mt-2 flex flex-wrap gap-1">
                    {#each task.labels ?? [] as label}
                      <span class="rounded bg-stone-200 px-1.5 py-0.5 text-[11px] text-stone-700">{label}</span>
                    {/each}
                    {#if task.blockers?.length}
                      <span class="rounded bg-amber-100 px-1.5 py-0.5 text-[11px] text-amber-800">{task.blockers.length} blockers</span>
                    {/if}
                  </div>
                </button>
              {:else}
                <div class="rounded-md border border-dashed border-stone-300 p-4 text-sm text-stone-600">
                  Configure Linear and sync to populate issue work.
                </div>
              {/each}
            </div>
          </Card>
        </div>

        <div class="grid min-h-0 grid-rows-[auto_minmax(0,1fr)] gap-4">
          <Card className="p-4">
            {#if selectedTask}
              <div class="flex items-start justify-between gap-4">
                <div class="min-w-0">
                  <div class="mb-2 flex flex-wrap items-center gap-2">
                    <Badge tone="neutral">{selectedTask.identifier}</Badge>
                    <Badge tone="info">{selectedTask.source}</Badge>
                    <Badge tone={badgeTone(selectedTask.status)}>{selectedTask.status}</Badge>
                    {#if selectedTask.branchName}
                      <Badge tone="neutral">{selectedTask.branchName}</Badge>
                    {/if}
                  </div>
                  <h3 class="text-xl font-semibold">{selectedTask.title}</h3>
                  <p class="mt-2 max-w-3xl text-sm leading-6 text-stone-700">{selectedTask.description || "No Linear description."}</p>
                </div>
                <div class="flex shrink-0 gap-2">
                  {#if selectedTask.url}
                    <Button variant="ghost" on:click={() => window.open(selectedTask.url)}>
                      <ExternalLink size={16} />
                    </Button>
                  {/if}
                  <Button variant="primary" on:click={() => startRun(selectedTask)} disabled={!selectedProfile || busy}>
                    <Play size={16} />
                    Run
                  </Button>
                  <Button variant="secondary" on:click={() => api.tasks.archive(selectedTask.id).then(refresh)} disabled={busy}>
                    <Archive size={16} />
                  </Button>
                </div>
              </div>
            {:else}
              <p class="text-sm text-stone-600">Select a task to start an isolated Codex workspace.</p>
            {/if}
          </Card>

          <div class="grid min-h-0 grid-cols-[292px_minmax(0,1fr)] gap-4">
            <Card className="min-h-0 overflow-hidden">
              <div class="border-b border-stone-300 px-4 py-3">
                <h3 class="font-semibold">Runs</h3>
              </div>
              <div class="h-full overflow-auto p-3">
                {#each runs as run}
                  <button
                    class="mb-2 w-full rounded-md border px-3 py-2 text-left text-sm transition {selectedRunId === run.id
                      ? 'border-stone-900 bg-stone-100'
                      : 'border-stone-300 bg-stone-50 hover:bg-stone-100'}"
                    on:click={() => refreshRunDetails(run)}
                  >
                    <div class="flex items-center justify-between gap-2">
                      <span class="truncate font-medium">{run.id}</span>
                      <Badge tone={badgeTone(run.state)}>{run.state}</Badge>
                    </div>
                    <p class="mt-1 truncate text-xs text-stone-600">{run.workspacePath ?? run.taskId}</p>
                  </button>
                {:else}
                  <div class="rounded-md border border-dashed border-stone-300 p-4 text-sm text-stone-600">
                    Runs appear after polling dispatches work or an operator starts a task.
                  </div>
                {/each}
              </div>
            </Card>

            <Card className="grid min-h-0 grid-rows-[auto_minmax(0,1fr)] overflow-hidden">
              <div class="flex items-center justify-between border-b border-stone-300 px-4 py-3">
                <div class="flex items-center gap-2">
                  <MessageSquareText size={18} />
                  <h3 class="font-semibold">Run detail</h3>
                </div>
                <div class="flex gap-2">
                  {#if selectedRun}
                    <Button variant="ghost" className="h-8 px-2" on:click={() => refreshRunDetails(selectedRun)}><RefreshCw size={15} /></Button>
                    <Button variant="secondary" className="h-8 px-2" on:click={() => retryRun(selectedRun)} disabled={busy || selectedRun.state === "running"}>
                      <RefreshCw size={15} />
                    </Button>
                    <Button variant="danger" className="h-8 px-2" on:click={() => cancelRun(selectedRun)} disabled={busy || selectedRun.state !== "running"}>
                      <Square size={15} />
                    </Button>
                  {/if}
                </div>
              </div>
              <div class="border-b border-stone-300 bg-stone-50 px-3 py-2">
                <div class="flex flex-wrap gap-1">
                  {#each runDetailTabs as tab}
                    <button
                      class="rounded-md px-2 py-1 text-xs font-medium capitalize {runDetailTab === tab ? 'bg-stone-950 text-stone-50' : 'text-stone-600 hover:bg-stone-200'}"
                      on:click={() => (runDetailTab = tab)}
                    >
                      {tab}
                    </button>
                  {/each}
                </div>
              </div>
              <div class="min-h-0 overflow-auto p-4 text-xs">
                {#if runDetailTab === "transcript"}
                  <div class="-m-4 min-h-full bg-[oklch(0.18_0.012_80)] p-4 text-stone-100">
                    {#each transcript as item}
                      <article class="mb-3 rounded-md border border-stone-700 bg-stone-900/70 p-3">
                        <div class="mb-2 flex items-center justify-between gap-3 text-stone-400">
                          <span class="truncate">{item.title}</span>
                          <span class="shrink-0">{transcriptMetrics(item.text)}</span>
                        </div>
                        <pre class="whitespace-pre-wrap font-mono leading-[18px] text-stone-100">{item.text}</pre>
                      </article>
                    {:else}
                      <div class="flex h-full min-h-80 items-center justify-center text-stone-500">
                        <div class="text-center">
                          <ShieldCheck class="mx-auto mb-3" size={26} />
                          <p>No run transcript selected.</p>
                        </div>
                      </div>
                    {/each}
                  </div>
                {:else if runDetailTab === "events"}
                  {#each events.slice().reverse() as event}
                    <div class="mb-2 rounded-md border border-stone-300 bg-stone-50 p-3">
                      <div class="flex items-center justify-between gap-2 text-stone-600">
                        <span>{event.type}</span>
                        <span>{event.timestamp}</span>
                      </div>
                      {#if event.message}
                        <pre class="mt-1 whitespace-pre-wrap text-stone-800">{event.message}</pre>
                      {/if}
                    </div>
                  {:else}
                    <p class="rounded-md border border-dashed border-stone-300 p-3 text-sm text-stone-600">No events selected.</p>
                  {/each}
                {:else if runDetailTab === "approvals"}
                  {#each approvals as approval}
                    <div class="mb-2 rounded-md border border-stone-300 bg-stone-50 p-3">
                      <div class="flex items-start justify-between gap-2">
                        <div>
                          <p class="text-sm font-medium">{approval.title}</p>
                          <p class="mt-1 text-xs text-stone-600">{approval.detail}</p>
                        </div>
                        <Badge tone={approval.status === "pending" ? "warn" : approval.status === "approved" ? "good" : "bad"}>{approval.status}</Badge>
                      </div>
                    </div>
                  {:else}
                    <p class="rounded-md border border-dashed border-stone-300 p-3 text-sm text-stone-600">No approvals for this run.</p>
                  {/each}
                {:else if runDetailTab === "proof"}
                  {#each proof as entry}
                    <div class="mb-2 rounded-md border border-stone-300 bg-stone-50 p-3">
                      <div class="flex items-center justify-between gap-2">
                        <span class="text-sm font-medium">{entry.label}</span>
                        <Badge tone={entry.status === "passed" ? "good" : entry.status === "failed" ? "bad" : entry.status === "warning" ? "warn" : "neutral"}>{entry.status}</Badge>
                      </div>
                      <p class="mt-1 text-xs text-stone-600">{entry.detail}</p>
                    </div>
                  {:else}
                    <p class="rounded-md border border-dashed border-stone-300 p-3 text-sm text-stone-600">Proof appears as the run reports tests, CI, review and summaries.</p>
                  {/each}
                {:else if runDetailTab === "workspace"}
                  <div class="rounded-md border border-stone-300 bg-stone-50 p-3 text-sm">
                    <p class="font-medium">Workspace</p>
                    <p class="mt-1 break-all text-stone-600">{selectedRun?.workspacePath ?? "No workspace path recorded."}</p>
                    <p class="mt-3 font-medium">Run id</p>
                    <p class="mt-1 break-all text-stone-600">{selectedRun?.id ?? "No run selected."}</p>
                  </div>
                {:else if runDetailTab === "handoff"}
                  <div class="mb-3 flex justify-end">
                    <Button variant="secondary" className="h-8" on:click={buildHandoff} disabled={!selectedRun || busy}>Build handoff</Button>
                  </div>
                  {#if handoff}
                    <pre class="whitespace-pre-wrap rounded-md bg-stone-950 p-3 text-xs text-stone-100">{handoff.body}</pre>
                  {:else}
                    <p class="rounded-md border border-dashed border-stone-300 p-3 text-sm text-stone-600">Build a handoff when the run is ready for Human Review.</p>
                  {/if}
                {/if}
              </div>
            </Card>
          </div>
        </div>

        <div class="min-h-0 space-y-4 overflow-auto">
          <Card className="p-4">
            <div class="mb-3 flex items-center gap-2">
              <Workflow size={18} />
              <h3 class="font-semibold">Automation</h3>
            </div>
            <div class="grid grid-cols-2 gap-2 text-sm">
              <div class="rounded-md bg-stone-100 p-2">
                <p class="text-xs text-stone-600">Active</p>
                <p class="mt-1 font-semibold">{activeRuns.length}</p>
              </div>
              <div class="rounded-md bg-stone-100 p-2">
                <p class="text-xs text-stone-600">Queued</p>
                <p class="mt-1 font-semibold">{orchestrator?.queuedTaskIds.length ?? 0}</p>
              </div>
              <div class="rounded-md bg-stone-100 p-2">
                <p class="text-xs text-stone-600">Review</p>
                <p class="mt-1 font-semibold">{reviewRuns.length}</p>
              </div>
              <div class="rounded-md bg-stone-100 p-2">
                <p class="text-xs text-stone-600">Retries</p>
                <p class="mt-1 font-semibold">{orchestrator?.state.retryQueue.length ?? 0}</p>
              </div>
            </div>
            {#if orchestrator?.state.lastTickAt}
              <p class="mt-3 flex items-center gap-2 text-xs text-stone-600"><Clock3 size={14} /> Last tick {orchestrator.state.lastTickAt}</p>
            {/if}
            {#if orchestrator?.state.lastError}
              <p class="mt-3 text-sm text-red-700">{orchestrator.state.lastError}</p>
            {/if}
          </Card>

          <Card className="p-4">
            <div class="mb-3 flex items-center gap-2">
              <ShieldCheck size={18} />
              <h3 class="font-semibold">Approval queue</h3>
            </div>
            <div class="space-y-2">
              {#each approvals as approval}
                <div class="rounded-md border border-stone-300 bg-stone-50 p-3">
                  <div class="flex items-start justify-between gap-2">
                    <div>
                      <p class="text-sm font-medium">{approval.title}</p>
                      <p class="mt-1 line-clamp-3 text-xs text-stone-600">{approval.detail}</p>
                    </div>
                    <Badge tone={approval.status === "pending" ? "warn" : approval.status === "approved" ? "good" : "bad"}>{approval.status}</Badge>
                  </div>
                  {#if approval.status === "pending"}
                    <div class="mt-3 flex gap-2">
                      <Button variant="primary" className="h-8" on:click={() => respondToApproval(approval, true)}>Approve</Button>
                      <Button variant="danger" className="h-8" on:click={() => respondToApproval(approval, false)}>Deny</Button>
                    </div>
                  {/if}
                </div>
              {:else}
                <div class="rounded-md border border-dashed border-stone-300 p-3 text-sm text-stone-600">
                  Approval requests appear here while a Codex run is blocked.
                </div>
              {/each}
            </div>
          </Card>

          <Card className="p-4">
            <div class="mb-3 flex items-center justify-between">
              <div class="flex items-center gap-2">
                <CheckCircle2 size={18} />
                <h3 class="font-semibold">Proof of work</h3>
              </div>
              {#if selectedRun}
                <Button variant="ghost" className="h-8 px-2" on:click={buildHandoff} disabled={busy}>Handoff</Button>
              {/if}
            </div>
            <div class="space-y-2">
              {#each proof as entry}
                <div class="rounded-md border border-stone-300 bg-stone-50 p-3">
                  <div class="flex items-center justify-between gap-2">
                    <p class="truncate text-sm font-medium">{entry.label}</p>
                    <Badge tone={entry.status === "passed" ? "good" : entry.status === "failed" ? "bad" : entry.status === "warning" ? "warn" : "neutral"}>{entry.status}</Badge>
                  </div>
                  <p class="mt-1 line-clamp-3 text-xs text-stone-600">{entry.detail}</p>
                </div>
              {:else}
                <div class="rounded-md border border-dashed border-stone-300 p-3 text-sm text-stone-600">
                  Proof appears as Codex reports tests, CI, review, token usage and completion summaries.
                </div>
              {/each}
            </div>
          </Card>

          <Card className="p-4">
            <div class="mb-3 flex items-center gap-2">
              <GitBranch size={18} />
              <h3 class="font-semibold">Workflow</h3>
            </div>
            {#if workflow}
              <div class="space-y-2 text-sm">
                <div class="flex items-center justify-between">
                  <span class="text-stone-600">Validation</span>
                  <Badge tone={workflow.validation.ok ? "good" : "bad"}>{workflow.validation.ok ? "valid" : "invalid"}</Badge>
                </div>
                <div class="flex items-center justify-between">
                  <span class="text-stone-600">Poll</span>
                  <span>{workflow.pollIntervalSeconds}s</span>
                </div>
                <div class="flex items-center justify-between">
                  <span class="text-stone-600">Concurrency</span>
                  <span>{workflow.maxConcurrentRuns}</span>
                </div>
                {#if !workflow.validation.ok}
                  <div class="rounded-md bg-red-50 p-2 text-xs text-red-800">
                    {workflow.validation.errors.join("; ")}
                  </div>
                {/if}
              </div>
            {/if}
          </Card>

          <Card className="p-4">
            <div class="mb-3 flex items-center gap-2">
              <Terminal size={18} />
              <h3 class="font-semibold">Event tail</h3>
            </div>
            <div class="max-h-64 overflow-auto font-mono text-xs">
              {#each events.slice(-20).reverse() as event}
                <div class="mb-2 rounded bg-stone-100 p-2">
                  <div class="flex items-center justify-between gap-2 text-stone-600">
                    <span>{event.type}</span>
                    <span>{event.timestamp}</span>
                  </div>
                  {#if event.message}
                    <pre class="mt-1 whitespace-pre-wrap text-stone-800">{event.message}</pre>
                  {/if}
                </div>
              {:else}
                <p class="text-sm text-stone-600">No events selected.</p>
              {/each}
            </div>
          </Card>
        </div>
      </div>
    </section>
  </div>
</main>
