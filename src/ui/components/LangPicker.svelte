<script lang="ts">
  // A focus-trapped option list for TV (the Settings language pickers and
  // anything else that needs "pick one of N"). The screen owning it stays in
  // charge of Back (it closes the picker and restores focus to the field) —
  // this component only traps the D-pad, preselects the current row, and
  // emits pick/close.
  import { onMount, onDestroy } from "svelte";
  import { createEventDispatcher } from "svelte";
  import { getRemote } from "../../webos/remote";
  import { pickerDefaultIndex, rowFocusState } from "../../putio/picker-default";

  const remote = getRemote();
  const dispatch = createEventDispatcher<{ pick: string; close: void }>();

  export let title: string;
  /** First row is conventionally the blank ("none") option. */
  export let options: { value: string; label: string }[];
  /** The value currently in effect — its row is preselected + focused. */
  export let selected: string;

  let panelEl: HTMLDivElement;

  function pick(v: string): void {
    dispatch("pick", v);
  }

  onMount(() => {
    // committed DOM: register the rows, trap focus to the panel, and put the
    // D-pad on the currently-selected row (OK re-confirms, arrows explore)
    const rows = remote.registerAll(panelEl);
    const idx = pickerDefaultIndex(rows.map((r) => rowFocusState(r)));
    if (idx >= 0 && rows[idx]) remote.focusEl(rows[idx]);
    remote.setFocusScope(panelEl);
    return () => remote.setFocusScope(null);
  });

  onDestroy(() => remote.setFocusScope(null));
</script>

<div class="lp-scrim" on:click={() => dispatch("close")}>
  <div class="lp-panel" bind:this={panelEl} on:click={(e) => e.stopPropagation()}>
    <p class="lp-title">{title}</p>
    {#each options as o (o.value + o.label)}
      <button
        class="lp-row"
        class:sel={selected === o.value}
        data-focus
        on:click={() => pick(o.value)}
      >
        <span class="lp-label">{o.label}</span>
        {#if o.value}<span class="lp-code">{o.value}</span>{/if}
      </button>
    {/each}
  </div>
</div>

<style>
  .lp-scrim {
    position: absolute;
    top: 0;
    right: 0;
    bottom: 0;
    left: 0;
    background: rgba(0, 0, 0, 0.55);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 40;
  }
  .lp-panel {
    width: 640px;
    max-height: 860px;
    overflow-y: auto;
    padding: 28px 32px;
    background: var(--bg-raised);
    border: 1px solid var(--line-strong);
    border-radius: var(--r-lg);
    box-shadow: var(--elev-lg);
  }
  .lp-title {
    font-size: var(--fs-h2);
    font-weight: 700;
    margin-bottom: 18px;
  }
  .lp-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    width: 100%;
    padding: 14px 20px;
    margin-bottom: 8px;
    border-radius: var(--r-md);
    background: var(--surface);
    border: 2px solid transparent;
    font-size: var(--fs-body);
    text-align: left;
  }
  .lp-row[data-state="active"] {
    border-color: var(--accent);
    background: var(--surface-2);
  }
  .lp-row.sel {
    border-color: var(--accent);
    background: var(--accent-dim-solid);
  }
  .lp-label {
    font-weight: 600;
  }
  .lp-code {
    color: var(--text-3);
    font-size: var(--fs-small);
    font-variant-numeric: tabular-nums;
  }
</style>
