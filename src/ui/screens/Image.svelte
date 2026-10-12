<script lang="ts">
  import { onMount, createEventDispatcher } from "svelte";
  import { getRemote, type Dir } from "../../webos/remote";
  import { stepIndex, type ViewerTarget } from "../../putio/image";
  import { fmtBytes } from "../../putio/api";

  export let targets: ViewerTarget[];
  export let initial: number;

  /**
   * Image viewer v1 — fit-to-screen + Left/Right browse + Back. No zoom
   * (deliberate: a TV remote has no pinch; zoom needs a real interaction
   * design and is a v2 question).
   *
   * The viewer is TARGET-based: it shows a list of ViewerTargets and never
   * builds URLs itself. Library images resolve to signed stream URLs;
   * archive images resolve to blob URLs — one screen, two worlds.
   *
   * Back always dispatches back to the App (no sub-levels of the viewer's
   * own); the App decides where "back" lands.
   */
  const dispatch = createEventDispatcher();
  const remote = getRemote();

  let at = initial >= 0 && initial < targets.length ? initial : 0;
  let state: "loading" | "ready" | "error" = "loading";
  let src = "";
  let objectUrl = ""; // blob: URLs we own must be revoked (the TV's memory)
  let captionVisible = true;
  let hideTimer: number | null = null;
  let attempt = 0;

  let errorEl: HTMLElement | null = null;

  $: active = targets[at];

  function freeUrl() {
    if (objectUrl) {
      URL.revokeObjectURL(objectUrl);
      objectUrl = "";
    }
  }

  /* ---------------- loading (honest: the target's own load) ---------------- */
  function loadImage() {
    state = "loading";
    attempt += 1;
    const mine = attempt;
    freeUrl();
    src = "";
    active
      .load()
      .then((url) => {
        if (mine !== attempt) return; // superseded by a newer load
        if (url.indexOf("blob:") === 0) objectUrl = url;
        src = url;
      })
      .catch((err) => {
        console.error("image target failed to load", err);
        if (mine !== attempt) return;
        state = "error";
      });
  }

  function retry() {
    wake();
    loadImage();
  }

  /* ---------------- browsing (the target list, no wrap) ------------------- */
  function step(dir: -1 | 1) {
    const to = stepIndex(at, targets.length, dir);
    if (to == null) return; // end of the list (no wrap) — nothing to do
    at = to;
    wake();
    loadImage();
  }

  /* ---------------- caption (auto-hides like the player controls) --------- */
  function wake() {
    captionVisible = true;
    if (hideTimer) clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      captionVisible = false;
    }, 4000);
  }

  /* ---------------- remote keys ------------------------------------------- */
  function onBack() {
    dispatch("back");
  }

  function onNavigate(dir: Dir) {
    wake();
    if (dir === "left") step(-1);
    else if (dir === "right") step(1);
  }

  onMount(() => {
    remote.setHandlers({
      onBack,
      onOK: wake,
      onNavigate,
    });
    loadImage();
    wake();
    return () => {
      remote.clearHandlers(); // BUG 5 contract: no stale handlers leak
      if (hideTimer) clearTimeout(hideTimer);
      freeUrl();
    };
  });

  // the error state owns its focus target: focus the retry button when it
  // mounts (bind:this flips errorEl, which drives this reactive statement —
  // the same idiom the player's panel focus uses)
  $: if (errorEl) remote.focusEl(errorEl);
</script>

<div class="viewer" class:ready={state === "ready"}>
  {#if state !== "error" && src}
    <img
      class="shot"
      {src}
      alt={active.name}
      draggable="false"
      on:load={() => {
        state = "ready";
      }}
      on:error={() => {
        state = "error";
      }}
    />
  {/if}

  {#if state === "loading"}
    <div class="center">
      <div class="spinner" role="status" aria-label="Loading"></div>
      <p class="muted">Loading {active.name}…</p>
    </div>
  {:else if state === "error"}
    <div class="center">
      <p class="big">Couldn’t display this image</p>
      <p class="muted">
        {active.name} — {fmtBytes(active.size)}
      </p>
      <p class="muted small">
        The file didn’t load, or the format isn’t decodable by this TV.
      </p>
      <button
        class="btn primary"
        data-focus
        bind:this={errorEl}
        on:click={retry}
      >Try again</button>
    </div>
  {/if}

  {#if state === "ready"}
    <div class="caption" class:dim={!captionVisible}>
      <span class="name">{active.name}</span>
      <span class="meta">
        {at + 1} of {targets.length}
        <span class="sep">·</span>
        {fmtBytes(active.size)}
      </span>
    </div>
  {/if}
</div>

<style>
  .viewer {
    position: absolute;
    top: 0;
    right: 0;
    bottom: 0;
    left: 0;
    background: var(--bg);
    overflow: hidden;
  }

  .shot {
    position: absolute;
    top: 0;
    right: 0;
    bottom: 0;
    left: 0;
    margin: auto;
    max-width: 100%;
    max-height: 100%;
    object-fit: contain;
  }

  .center {
    position: absolute;
    top: 0;
    right: 0;
    bottom: 0;
    left: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    text-align: center;
    padding: 0 10vw;
  }

  .center .spinner {
    margin-bottom: 20px;
  }

  .big {
    font-size: var(--fs-h2);
    font-weight: 600;
    color: var(--text);
    margin: 0 0 8px;
  }

  .muted {
    color: var(--text-2);
    margin: 0 0 4px;
  }

  .muted.small {
    font-size: var(--fs-small);
    color: var(--text-3);
    margin-bottom: 24px;
  }

  .caption {
    position: absolute;
    left: 0;
    right: 0;
    bottom: 0;
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    padding: 16px 28px 22px;
    background: linear-gradient(transparent, rgba(0, 0, 0, 0.78) 40%);
    transition: opacity 0.35s ease;
    pointer-events: none;
  }

  .caption.dim {
    opacity: 0;
  }

  .caption .name {
    font-size: var(--fs-body);
    font-weight: 600;
    color: var(--text);
  }

  .caption .meta {
    font-size: var(--fs-small);
    color: var(--text-2);
    font-variant-numeric: tabular-nums;
  }

  .caption .sep {
    margin: 0 8px;
    color: var(--text-3);
  }
</style>
