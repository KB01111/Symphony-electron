<script lang="ts">
  import { cn } from "../../utils";

  export let type: "button" | "submit" = "button";
  export let variant: "primary" | "secondary" | "ghost" | "danger" = "secondary";
  export let disabled = false;
  export let className = "";

  const variants = {
    primary: "bg-stone-950 text-stone-50 hover:bg-stone-800",
    secondary: "border border-stone-300 bg-stone-50 text-stone-900 hover:bg-stone-100",
    ghost: "text-stone-700 hover:bg-stone-100",
    danger: "bg-red-700 text-red-50 hover:bg-red-800"
  };
</script>

<button
  {type}
  {disabled}
  class={cn(
    "inline-flex h-9 items-center justify-center gap-2 rounded-md px-3 text-sm font-medium transition disabled:pointer-events-none disabled:opacity-45",
    variants[variant],
    className
  )}
  on:click
>
  <slot />
</button>

