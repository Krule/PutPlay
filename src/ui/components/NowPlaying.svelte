<script lang="ts">
  import { onMount } from "svelte";
  import { music, toggleMusic, stopMusic, nextMusic, prevMusic, setExpanded } from "../../store/music";
  import { getRemote } from "../../webos/remote";

  // The persistent now-playing strip (app-level — it is NOT a screen).
  // Buttons register with the spatial remote like every other control, so
  // D-pad down from the last grid row reaches them and each screen's
  // "activate the focused control" OK routing clicks them for free.
  const remote = getRemote();
  let stripEl: HTMLElement;
  let panelEl: HTMLElement;
  let prevBtn: HTMLButtonElement;
  let nextBtn: HTMLButtonElement;

  $: m = $music;
  $: name = (m?.file.name || "").replace(/\.[^.]+$/, "");
  $: cur = m?.ms.currentTime ?? 0;
  $: dur = m?.ms.duration ?? 0;
  $: pct = dur > 0 ? Math.min(100, (cur / dur) * 100) : 0;
  $: pos = m ? `${m.index + 1} of ${m.queue.length}` : "";
  $: atFirst = m ? m.index === 0 : false;
  $: atLast = m ? m.index >= m.queue.length - 1 : false;

  function fmt(s: number): string {
    const t = Math.max(0, Math.floor(s));
    return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`;
  }

  onMount(() => {
    remote.registerAll(stripEl);
  });
  // the expanded panel's DOM arrives later (and is recreated on re-expand)
  $: if (panelEl) remote.registerAll(panelEl);
  // edge buttons dim AND leave the focus pool (the remote reads both)
  $: if (prevBtn) remote.setDisabled(prevBtn, atFirst);
  $: if (nextBtn) remote.setDisabled(nextBtn, atLast);
</script>

{#if $music}
  <div class="np" id="np" bind:this={stripEl}>
    <div class="np-art" aria-hidden="true">
      {#if $music.cover}
        <img src={$music.cover} alt="" />
      {:else}
        <span class="np-glyph">♪</span>
      {/if}
    </div>
    <div class="np-title" data-focus role="button" aria-label="Expand now playing" on:click={() => setExpanded(!$music.expanded)}>
      <div class="np-name">{name}</div>
      <div class="np-meta"><span>{pos}</span><span>{fmt(cur)} / {fmt(dur)}</span></div>
      <div class="np-prog"><div class="np-prog-fill" style="width: {pct}%"></div></div>
    </div>
    <div class="np-btns">
      <button class="np-btn" bind:this={prevBtn} data-focus aria-label="Previous track" on:click={prevMusic}>
        <span class="ico">«</span>
      </button>
      <button class="np-btn play" data-focus aria-label={m?.ms.paused ? "Play" : "Pause"} on:click={toggleMusic}>
        <span class="ico">{m?.ms.paused ? "▶" : "❚❚"}</span>
      </button>
      <button class="np-btn" bind:this={nextBtn} data-focus aria-label="Next track" on:click={nextMusic}>
        <span class="ico">»</span>
      </button>
      <button class="np-btn stop" data-focus aria-label="Stop music" on:click={stopMusic}>
        <span class="ico">✕</span>
      </button>
    </div>
  </div>

  {#if $music.expanded}
    <div class="np-panel" bind:this={panelEl}>
      <div class="np-panel-art" aria-hidden="true">
        {#if $music.cover}
          <img src={$music.cover} alt="" />
        {:else}
          <span class="np-glyph big">♪</span>
        {/if}
      </div>
      <div class="np-panel-body">
        <div class="np-name big">{name}</div>
        <div class="np-meta"><span>{pos}</span><span>{fmt(cur)} / {fmt(dur)}</span></div>
        <div class="np-prog big"><div class="np-prog-fill" style="width: {pct}%"></div></div>
      </div>
    </div>
  {/if}
{/if}
