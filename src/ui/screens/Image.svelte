<script lang="ts">
  import { onMount, createEventDispatcher } from "svelte";
  import { get } from "svelte/store";
  import { getRemote, type Dir } from "../../webos/remote";
  import { library } from "../../store/library";
  import { currentAuth } from "../../store/auth";
  import { streamURL, fmtBytes } from "../../putio/api";
  import { nextImageId, isImageFile } from "../../putio/image";
  import type { PutFile } from "../../putio/types";

  export let file: PutFile;

  /**
   * Image viewer v1 — fit-to-screen + Left/Right browse + Back. No zoom
   * (deliberate: a TV remote has no pinch; zoom needs a real interaction
   * design and is a v2 question).
   *
   * The viewer has no sub-levels of its own: Back always dispatches back to
   * the App (which returns to the library, folder intact — the library store
   * persists under the viewer).
   */
  const dispatch = createEventDispatcher();
  const remote = getRemote();

  let viewing: PutFile = file;
  let state: "loading" | "ready" | "error" = "loading";
  let src = "";
  let captionVisible = true;
  let hideTimer: number | null = null;
  let nonce = 0; // retry counter — a fresh URL per attempt, never a silent blank

  let libFiles: PutFile[] = []; // subscribed: the caption's "n of m" must track the store
  let errorEl: HTMLElement | null = null;

  /* ---------------- loading (honest: the signed URL, the same as video) ---- */
  function loadImage() {
    const au = currentAuth();
    if (!au) return;
    state = "loading";
    src = nonce ? `${streamURL(au, viewing.id)}&r=${nonce}` : streamURL(au, viewing.id);
  }

  function retry() {
    wake();
    nonce += 1;
    loadImage();
  }

  /* ---------------- browsing (the folder's images, listing order) ---------- */
  function step(dir: -1 | 1) {
    const to = nextImageId(libFiles, viewing.id, dir);
    if (to == null) return; // end of the folder (no wrap) — nothing to do
    const next = libFiles.find((f) => f.id === to);
    if (!next) return;
    viewing = next;
    nonce = 0;
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

  $: imageIds = libFiles.filter(isImageFile).map((f) => f.id);
  $: position = imageIds.indexOf(viewing.id);

  /* ---------------- remote keys ------------------------------------------- */
  function onBack() {
    dispatch("back");
  }

  function onNavigate(dir: Dir) {
    wake();
    if (dir === "left") step(-1);
    else if (dir === "right") step(1);
  }

  function wire() {
    remote.setHandlers({
      onBack,
      onOK: wake,
      onNavigate,
    });
    libFiles = get(library).files;
    loadImage();
    wake();
  }

  onMount(() => {
    wire();
    const unsub = library.subscribe((v) => (libFiles = v.files));
    return () => {
      unsub();
      remote.clearHandlers(); // BUG 5 contract: no stale handlers leak
      if (hideTimer) clearTimeout(hideTimer);
    };
  });

  // the error state owns its focus target: focus the retry button when it
  // mounts (bind:this flips errorEl, which drives this reactive statement —
  // the same idiom the player's panel focus uses)
  $: if (errorEl) remote.focusEl(errorEl);
</script>

<div class="viewer" class:ready={state === "ready"}>
  {#if state !== "error"}
    <img
      class="shot"
      {src}
      alt={viewing.name}
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
      <p class="muted">Loading {viewing.name}…</p>
    </div>
  {:else if state === "error"}
    <div class="center">
      <p class="big">Couldn’t display this image</p>
      <p class="muted">
        {viewing.name} — {fmtBytes(viewing.size)}
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
      <span class="name">{viewing.name}</span>
      <span class="meta">
        {position + 1} of {imageIds.length}
        <span class="sep">·</span>
        {fmtBytes(viewing.size)}
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
