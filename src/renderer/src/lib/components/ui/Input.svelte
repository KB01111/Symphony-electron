<script lang="ts">
  import { cn } from "../../utils";

  export let value = "";
  export let placeholder = "";
  export let type = "text";
  export let className = "";
</script>

<input
  bind:value
  {placeholder}
  {type}
  class={cn(
    "h-9 w-full rounded-md border border-stone-300 bg-stone-50 px-3 text-sm text-stone-950 outline-none transition placeholder:text-stone-400 focus:border-stone-700",
    className
  )}
/>

