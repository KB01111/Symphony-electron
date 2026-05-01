<script lang="ts">
  import { cn } from "../../utils";

  export let tone: "neutral" | "good" | "warn" | "bad" | "info" = "neutral";

  const tones = {
    neutral: "border-stone-300 bg-stone-100 text-stone-700",
    good: "border-emerald-300 bg-emerald-50 text-emerald-800",
    warn: "border-amber-300 bg-amber-50 text-amber-800",
    bad: "border-red-300 bg-red-50 text-red-800",
    info: "border-sky-300 bg-sky-50 text-sky-800"
  };
</script>

<span class={cn("inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-medium", tones[tone])}>
  <slot />
</span>

