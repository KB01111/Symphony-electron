<script lang="ts">
  import { cn } from "../../utils";

  export let className = "";
</script>

<section class={cn("rounded-lg border border-stone-200 bg-stone-50 shadow-sm", className)}>
  <slot />
</section>

