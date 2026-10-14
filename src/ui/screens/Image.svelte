<script lang="ts">
  import { onMount, createEventDispatcher } from "svelte";
  import { getRemote, type Dir } from "../../webos/remote";
  import { stepIndex, type ViewerTarget } from "../../putio/image";
  import { cycleZoom, zoomScale, panBounds, nudge, type ZoomLevel } from "../../putio/zoom";
  import { fmtBytes } from "../../putio/api";

  export let targets: ViewerTarget[];
  export let initial: number;

  /**
   * Image viewer — fit-to-screen + Left/Right browse + Back, and (v1.1)
   * the same zoom the comic reader proved: OK = fit → 2× → 4× (relative
   * to the image's OWN fit, so 675-px and 2138-px feel identical), arrows
   * PAN when zoomed (look-direction, clamped), browse at fit. The math is
   * the shared putio/zoom.ts — the same ladder, the same clamp.
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
  let dims: { w: number; h: number } | null = null; // the decoded size (from the <img>)

  let viewW = 1920;
  let viewH = 1080;
  let imgEl: HTMLImageElement | null = null;

  /* ---------------- zoom + pan (the reader's ladder, shared math) -------- */
  let zoom: ZoomLevel = "fit";
  let panX = 0;
  let panY = 0;

  $: scale = dims ? zoomScale(zoom, dims.w, dims.h, viewW, viewH) : 1;
  $: wPx = dims ? Math.round(dims.w * scale) : 0;
  $: hPx = dims ? Math.round(dims.h * scale) : 0;
  // CENTER-anchored, like the reader: at fit the image sits centered; above
  // fit the pan is symmetric, clamped by panBounds.
  $: leftPx = (viewW - wPx) / 2 + panX;
  $: topPx = (viewH - hPx) / 2 + panY;

  let errorEl: HTMLElement | null = null;
  // the screen root — the focus scope keeps D-pad moves inside the viewer
  let viewerEl: HTMLElement | null = null;

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
    dims = null; // a new image is a new size (the zoom reset lives in step();
    // a retry of the SAME image keeps the user's zoom)
    active
      .load()
      .then((url) => {
        if (mine !== attempt) {
          // superseded by a newer load: a blob we made is ours to revoke
          if (url.indexOf("blob:") === 0) URL.revokeObjectURL(url);
          return;
        }
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
    // a new image starts at fit, centered — the zoom is a per-image choice
    zoom = "fit";
    panX = 0;
    panY = 0;
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

  function onOK() {
    wake();
    // the now-playing strip owns its focused controls — a strip button under
    // the image must click, not zoom
    const ae = remote.activeEl;
    if (ae && ae.closest("#np")) {
      remote.clickActive();
      return;
    }
    if (state !== "ready" || !dims) return; // nothing on screen to zoom
    zoom = cycleZoom(zoom);
    panX = 0;
    panY = 0; // every step of the ladder starts from the image's center
  }

  function nudgePan(dir: Dir) {
    if (!dims) return;
    const stepPx = Math.max(48, Math.round(((dir === "up" || dir === "down") ? viewH : viewW) * 0.08));
    const b = panBounds(dims.w, dims.h, viewW, viewH, scale);
    // the pure nudge: the arrow names where you LOOK (Up reveals the top —
    // the drag mapping was inverted on the C1)
    if (dir === "right" || dir === "left") panX = nudge(panX, b.maxX, dir, stepPx);
    else panY = nudge(panY, b.maxY, dir, stepPx);
  }

  function onNavigate(dir: Dir) {
    wake();
    if (zoom !== "fit") {
      nudgePan(dir);
      return; // zoomed: the arrows are the pan
    }
    if (dir === "left") step(-1);
    else if (dir === "right") step(1);
    // at fit, up/down is an honest no-op (there is nothing above/below)
  }

  onMount(() => {
    remote.setHandlers({
      onBack,
      onOK,
      onNavigate,
    });
    // the arrows PAN (zoomed) or step images (fit) here — scope the spatial
    // remote to the APP SHELL (viewer + persistent corner row), not the
    // viewer alone: the music row must stay usable while viewing — it dims
    // to 0.25 so it reads as atmosphere, not chrome. The library's grid
    // isn't mounted on this screen, so the D-pad can't wander there.
    remote.setFocusScope(document.querySelector(".app-shell"));
    loadImage();
    wake();
    return () => {
      remote.clearHandlers(); // BUG 5 contract: no stale handlers leak
      remote.setFocusScope(null); // lift the trap for the screen below
      if (hideTimer) clearTimeout(hideTimer);
      freeUrl();
    };
  });

  // the error state owns its focus target: focus the retry button when it
  // mounts (bind:this flips errorEl, which drives this reactive statement —
  // the same idiom the player's panel focus uses)
  $: if (errorEl) remote.focusEl(errorEl);
</script>

<div class="viewer" class:ready={state === "ready"} bind:this={viewerEl} bind:clientWidth={viewW} bind:clientHeight={viewH}>
  {#if state !== "error" && src}
    <img
      class="shot"
      class:placed={!!dims}
      {src}
      alt={active.name}
      draggable="false"
      bind:this={imgEl}
      style={dims ? "width: " + wPx + "px; height: " + hPx + "px; left: " + leftPx + "px; top: " + topPx + "px;" : ""}
      on:load={() => {
        if (imgEl && imgEl.naturalWidth) {
          dims = { w: imgEl.naturalWidth, h: imgEl.naturalHeight };
        }
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
        {#if zoom !== "fit"}<span class="sep">·</span>{zoom}{/if}
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

  /* dims known: explicit size + center-anchored position (the zoom model)
     — the contain fallback above only serves the pre-load frame */
  .shot.placed {
    top: auto;
    right: auto;
    bottom: auto;
    left: auto;
    margin: 0;
    max-width: none;
    max-height: none;
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
