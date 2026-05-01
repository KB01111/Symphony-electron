<script lang="ts">
  import { cn } from "../../utils";

  export let value = "";
  export let placeholder = "";
  export let className = "";
</script>

<textarea
  bind:value
  {placeholder}
  class={cn(
    "min-h-24 w-full resize-none rounded-md border border-stone-300 bg-stone-50 px-3 py-2 text-sm text-stone-950 outline-none transition placeholder:text-stone-400 focus:border-stone-700",
    className
  )}
></textarea>
