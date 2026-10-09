<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { getRemote } from "../../webos/remote";
  import { platform } from "../../webos/platform";

  export let title: string;
  export let items: { id: string; label: string; icon?: string; danger?: boolean }[];
  export let onPick: (item: any) => void;

  const remote = getRemote();
  let panelEl: HTMLElement;
  let activeId: string | null = null;

  function applyStates() {
    panelEl?.querySelectorAll<HTMLElement>("[data-focus]").forEach((el) => {
      const id = el.dataset.id || "";
      if (id === activeId) el.dataset.state = "active";
      else if (el.dataset.state === "active") el.dataset.state = "visited";
      else el.removeAttribute("data-state");
    });
  }

  function move(dir: "up" | "down") {
    const valid = items.map((i) => i.id);
    const idx = valid.indexOf(activeId || "");
    let next = idx;
    if (idx === -1) next = 0;
    else next = dir === "up" ? Math.max(0, idx - 1) : Math.min(valid.length - 1, idx + 1);
    if (next !== idx) {
      activeId = valid[next];
      applyStates();
    }
  }

  function pick() {
    const it = items.find((i) => i.id === activeId);
    if (it) onPick(it);
  }

  function onKey(e: KeyboardEvent) {
    const code = (e as any).keyCode as number;
    if (code === 38 || e.key === "ArrowUp") {
      e.preventDefault();
      e.stopPropagation();
      move("up");
    } else if (code === 40 || e.key === "ArrowDown") {
      e.preventDefault();
      e.stopPropagation();
      move("down");
    } else if (code === 13 || e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      pick();
    }
  }

  onMount(() => {
    if (panelEl) {
      activeId = items.length ? items[0].id : null;
      applyStates();
      panelEl.querySelectorAll<HTMLElement>("[data-focus]").forEach((el) => remote.register(el));
    }
    window.addEventListener("keydown", onKey, true);
    document.body.classList.add("menu-open");
  });
  onDestroy(() => {
    window.removeEventListener("keydown", onKey, true);
    document.body.classList.remove("menu-open");
    panelEl?.querySelectorAll<HTMLElement>("[data-focus]").forEach((el) => remote.unregister(el));
  });
</script>

<div class="scrim" on:click={() => onPick({ id: "__cancel" })}>
  <div class="panel menu" bind:this={panelEl} on:click={(e) => e.stopPropagation()}>
    <div class="menu-title" class:trunc>{title}</div>
    {#each items as it (it.id)}
      <button
        class="menu-item"
        class:danger={it.danger}
        data-focus
        data-id={it.id}
        on:click={() => onPick(it)}
      >
        {#if it.icon}<span class="mi-icon">{it.icon}</span>{/if}
        <span class="mi-label">{it.label}</span>
      </button>
    {/each}
  </div>
</div>

<style>
  :global(body.menu-open) {
    overflow: hidden;
  }
  .scrim {
    position: absolute;
    top: 0;
    right: 0;
    bottom: 0;
    left: 0;
    background: rgba(8, 10, 14, 0.6);
    z-index: 120;
    display: flex;
    align-items: center;
    justify-content: center;
    animation: fade-in var(--t-med) var(--ease) both;
  }
  .menu {
    width: 460px;
    padding: 14px;
  }
  .menu-title {
    font-size: var(--fs-h3);
    font-weight: 700;
    padding: 14px 18px 12px;
    border-bottom: 1px solid var(--line);
    margin-bottom: 10px;
  }
  .menu-title.trunc {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .menu-item {
    display: flex;
    align-items: center;
    gap: 16px;
    width: 100%;
    padding: 15px 18px;
    border-radius: var(--r-md);
    font-size: var(--fs-body);
    text-align: left;
    color: var(--text);
    border: 2px solid transparent;
  }
  .menu-item[data-state="active"] {
    background: var(--surface-2);
    border-color: var(--accent);
    transform: none;
  }
  .menu-item.danger {
    color: var(--danger);
  }
  .mi-icon {
    width: 30px;
    text-align: center;
    font-size: 22px;
  }
</style>
