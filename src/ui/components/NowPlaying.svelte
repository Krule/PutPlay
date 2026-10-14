<script lang="ts">
  import { music, toggleMusic, stopMusic, nextMusic, prevMusic, setExpanded, setMusicMode } from "../../store/music";
  import { getRemote } from "../../webos/remote";

  // The persistent now-playing strip (app-level — it is NOT a screen).
  // Buttons register with the spatial remote like every other control, so
  // D-pad down from the last grid row reaches them and each screen's
  // "activate the focused control" OK routing clicks them for free.
  //
  // presentation is a PROP (the App decides): the user's mode (strip|micro)
  // from the session store, overridden to micro on the reading screens, where
  // the full-width strip would cover the page (and the D-pad must not leave
  // the pan area — the strip's buttons stay out of those focus scopes).
  const remote = getRemote();
  export let presentation: "strip" | "micro" = "strip";
  /** While a reading screen (comic/image) is up, the corner row recedes to
   *  0.25 opacity so it reads as atmosphere; :focus-within brings it back. */
  export let dimmed = false;
  let stripEl: HTMLElement;
  let microEl: HTMLElement;
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

  // both surfaces register as they mount (the presentation swaps them)
  $: if (stripEl) remote.registerAll(stripEl);
  $: if (microEl) remote.registerAll(microEl);
  // the expanded panel's DOM arrives later (and is recreated on re-expand)
  $: if (panelEl) remote.registerAll(panelEl);
  // edge buttons dim AND leave the focus pool (the remote reads both)
  $: if (prevBtn) remote.setDisabled(prevBtn, atFirst);
  $: if (nextBtn) remote.setDisabled(nextBtn, atLast);
</script>

{#if $music}
  {#if presentation === "strip"}
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
      <button class="np-btn" data-focus aria-label="Make it micro" on:click={() => setMusicMode("micro")}>
        <span class="ico">◱</span>
      </button>
      <button class="np-btn stop" data-focus aria-label="Stop music" on:click={stopMusic}>
        <span class="ico">✕</span>
      </button>
    </div>
  </div>
  {:else}
  <!-- the micro: the icon row in the video dock's corner — the dock's own
       visual language (.dock/.dock-btn), so the two sessions read as one
       system. Transport keeps working from here (audio continues). -->
  <div class="dock np-micro" class:dimmed={dimmed} bind:this={microEl}>
    <button class="dock-btn" bind:this={prevBtn} data-focus aria-label="Previous track" on:click={prevMusic}>«</button>
    <button class="dock-btn play" data-focus aria-label={m?.ms.paused ? "Play" : "Pause"} on:click={toggleMusic}>{m?.ms.paused ? "▶" : "❚❚"}</button>
    <button class="dock-btn" bind:this={nextBtn} data-focus aria-label="Next track" on:click={nextMusic}>»</button>
    <button class="dock-btn" data-focus aria-label="Restore to strip" on:click={() => setMusicMode("strip")}>▭</button>
    <button class="dock-btn close" data-focus aria-label="Stop music" on:click={stopMusic}>✕</button>
  </div>
  {/if}

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
