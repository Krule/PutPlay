<script lang="ts">
  import { onMount, createEventDispatcher } from "svelte";
  import { get } from "svelte/store";
  import { getRemote, type Dir } from "../../webos/remote";
  import { currentAuth } from "../../store/auth";
  import { fmtBytes, type Auth } from "../../putio/api";
  import type { PutFile } from "../../putio/types";
  import type { ZipEntry } from "../../putio/zip";
  import { extractEntry } from "../../putio/zip-extract";
  import {
    stepPage,
    cycleZoom,
    zoomScale,
    panBounds,
    type Direction,
    type ZoomLevel,
    type TurnDir,
  } from "../../putio/comic";
  import { comic, setComic, upsertProgress } from "../../store/comic";

  /**
   * Comic reader — the book screen (plan: .agents/plan.md).
   *
   * The App made the decision (tail read + isComicZip) and put the session
   * in the comic store: file, model, page index, direction. This screen
   * renders the book:
   *   ←/→  turn the page (direction-aware — in a manga, LEFT goes forward)
   *        or PAN when zoomed (clamped to the image, never the wall)
   *   OK   zoom: fit → 2× → 4× → fit (relative to the page's OWN fit, so a
   *        675-px scan and a 2138-px scan feel identical)
   *   Up   flip the reading direction (persisted for THIS comic); while
   *        zoomed, Up/Down pan instead
   *   Back exit — the position was already saved (no confirm, D10)
   *
   * The NEXT page is prefetched while the current one displays (two range
   * reads max, direction-aware) — a page turn is a cache hit, not a fetch.
   * Nothing is downloaded that is not read: a 351 MB volume costs the pages
   * you turn.
   */
  const dispatch = createEventDispatcher();
  const remote = getRemote();

  /** Session state, LOCAL — initialized from the comic store once (the App
   *  made the decision and put the session there before this screen mounted),
   *  and written BACK to the store on every change so it survives screen
   *  swaps. (Codebase idiom — the library and archive screens do exactly
   *  this. Initializing a plain variable from a store $-binding is NOT
   *  reactive: the store updates the $-binding, not the plain variable, and
   *  Svelte compiles statements that depend on a never-reassigned variable
   *  into one-shot init code — the caption froze at "1 of 13" while the
   *  shelf kept advancing.) */
  let file = get(comic).file;
  let model = get(comic).model;
  let index = get(comic).index;
  let dir = get(comic).direction;
  $: total = model ? model.pages.length : 0;
  $: page = model && index >= 0 && index < total ? model.pages[index] : null;
  $: pageNo = index + 1;
  $: pct = total ? ((index + 1) / total) * 100 : 0;
  $: altText = page ? page.base : "";

  /* ---------------- page lifecycle (honest states) ---------------- */
  let viewW = 1920;
  let viewH = 1080;
  let pageState: "loading" | "ready" | "error" = "loading";
  let src = "";
  let objectUrl = ""; // blob: URLs we own must be revoked (the TV's memory)
  let attempt = 0; // supersede counter (fast page turns)
  let dims: { w: number; h: number } | null = null;

  let imgEl: HTMLImageElement | null = null;
  let errorEl: HTMLButtonElement | null = null;

  /* ---------------- zoom + pan (relative ladder, clamped) ------------- */
  let zoom: ZoomLevel = "fit";
  let panX = 0;
  let panY = 0;

  $: scale = dims ? zoomScale(zoom, dims.w, dims.h, viewW, viewH) : 1;
  $: wPx = dims ? Math.round(dims.w * scale) : 0;
  $: hPx = dims ? Math.round(dims.h * scale) : 0;
  // Edge-anchored pan: left = (viewW - wPx) + panX, panX ∈ [0, maxX]
  // (maxX = wPx - viewW). Centered = maxX / 2. At fit (or an upscaled small
  // page) maxX is 0 and the page simply sits centered.
  $: leftPx = (viewW - wPx) + panX;
  $: topPx = (viewH - hPx) + panY;

  function freeUrl() {
    if (objectUrl) {
      URL.revokeObjectURL(objectUrl);
      objectUrl = "";
    }
  }

  /** A blob URL plus the dimensions its bytes actually decode to — probed
   *  off-screen, so the displayed <img> renders at the right size on frame
   *  one (no 0-px flash, no layout jump). */
  function withDims(url: string): Promise<{ url: string; w: number; h: number }> {
    return new Promise((resolve, reject) => {
      const probe = new Image();
      probe.onload = () =>
        resolve({ url, w: probe.naturalWidth, h: probe.naturalHeight });
      probe.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error("not a decodable image"));
      };
      probe.src = url;
    });
  }

  /** One page, extracted from the archive (two Range reads) and probed. */
  function pageData(au: Auth, f: PutFile, entry: ZipEntry) {
    return extractEntry(au, f, entry).then(({ data, mime }) =>
      withDims(URL.createObjectURL(new Blob([data], { type: mime })))
    );
  }

  function loadPage(i: number) {
    pageState = "loading";
    zoom = "fit";
    panX = 0;
    panY = 0;
    dims = null;
    attempt += 1;
    const mine = attempt;
    freeUrl();
    src = "";

    const au = currentAuth();
    const pg = model && model.pages[i] ? model.pages[i] : null;
    if (!au || !file || !pg) {
      pageState = "error"; // an empty session is an error, not a blank
      return;
    }

    const hit = prefetched && prefetched.index === i ? prefetched : null;
    if (hit) prefetched = null;
    const data: Promise<{ url: string; w: number; h: number }> = hit
      ? hit.promise
      : pageData(au, file, pg.entry);
    data
      .then(({ url, w, h }) => {
        if (mine !== attempt) {
          URL.revokeObjectURL(url); // superseded — the blob is dead weight
          return;
        }
        dims = { w, h };
        objectUrl = url;
        src = url;
      })
      .catch((err) => {
        console.error("comic page failed to load", err);
        if (mine !== attempt) return;
        pageState = "error"; // D8: the corrupt page says so
      });
  }

  function onImgLoad() {
    if (pageState !== "loading") return;
    if (!dims && imgEl && imgEl.naturalWidth) {
      dims = { w: imgEl.naturalWidth, h: imgEl.naturalHeight }; // probe-less fallback
    }
    centerPan(); // a new page (and a zoom step) starts centered
    pageState = "ready";
    wake();
    saveProgress();
    prefetch();
  }

  function onImgError() {
    pageState = "error";
  }

  function retry() {
    wake();
    loadPage(index);
  }

  /* ---------------- turning (direction-aware, no wrap) ---------------- */
  function step(d: TurnDir) {
    if (!model || !file) return;
    const next = stepPage(index, model.pages.length, d, dir);
    if (next == null) return; // the honest stop at either end
    index = next;
    setComic(file, model, index, dir); // keep the store in sync (cross-screen state)
    saveProgress();
    wake();
    loadPage(next);
  }

  /* ---------------- the prefetch (the next page, direction-aware) ------ */
  interface Prefetch {
    index: number;
    promise: Promise<{ url: string; w: number; h: number }>;
  }
  let prefetched: Prefetch | null = null;

  function prefetch() {
    const au = currentAuth();
    if (!model || !file || !au) {
      prefetched = null;
      return;
    }
    const fwd: TurnDir = dir === "ltr" ? "right" : "left";
    const next = stepPage(index, model.pages.length, fwd, dir);
    if (next == null) {
      prefetched = null;
      return; // last page — nothing to prefetch, and that is fine
    }
    const pf: Prefetch = { index: next, promise: pageData(au, file, model.pages[next].entry) };
    // keep the unmount case quiet: a prefetch no page turn ever consumes
    // must not surface as an unhandled rejection
    pf.promise.catch(() => undefined);
    prefetched = pf;
  }

  /* ---------------- progress (position + direction, per comic) --------- */
  function saveProgress() {
    if (!file || !model) return;
    upsertProgress(file, file.name, index, model.pages.length, dir);
  }

  function flipDirection() {
    if (!file || !model) return;
    const nextDir: Direction = dir === "ltr" ? "rtl" : "ltr";
    dir = nextDir;
    setComic(file, model, index, nextDir);
    flash = nextDir === "rtl" ? "right to left" : "left to right";
    if (flashTimer) clearTimeout(flashTimer);
    flashTimer = setTimeout(() => (flash = ""), 1600);
    // the flip is THIS comic's, remembered for it (the global default in
    // Settings only applies to comics never flipped)
    upsertProgress(file, file.name, index, model.pages.length, nextDir);
    wake();
    prefetch(); // "next" changed — the prefetch must follow the new direction
  }

  /* ---------------- zoom + pan keys ------------------------------------ */
  function centerPan() {
    if (!dims) return;
    const s = zoomScale(zoom, dims.w, dims.h, viewW, viewH);
    const b = panBounds(dims.w, dims.h, viewW, viewH, s);
    panX = b.maxX / 2;
    panY = b.maxY / 2;
  }

  function onOK() {
    wake();
    if (pageState !== "ready" || !dims) return; // nothing on screen to zoom
    zoom = cycleZoom(zoom);
    centerPan(); // every step of the ladder starts from the page's center
  }

  function nudgePan(d: Dir) {
    if (!dims) return;
    const stepPx = Math.max(48, Math.round(((d === "up" || d === "down") ? viewH : viewW) * 0.08));
    const b = panBounds(dims.w, dims.h, viewW, viewH, scale);
    if (d === "right") panX = Math.min(b.maxX, panX + stepPx);
    else if (d === "left") panX = Math.max(0, panX - stepPx);
    else if (d === "down") panY = Math.min(b.maxY, panY + stepPx);
    else panY = Math.max(0, panY - stepPx);
  }

  /* ---------------- caption + flash (auto-hide like the player) -------- */
  let captionVisible = true;
  let hideTimer: number | null = null;
  let flash = "";
  let flashTimer: number | null = null;

  function wake() {
    captionVisible = true;
    if (hideTimer) clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      captionVisible = false;
    }, 4000);
  }

  /* ---------------- remote keys ---------------------------------------- */
  function onBack() {
    // D10: exit, no confirm — the position and direction are already saved
    dispatch("back");
  }

  function onNavigate(d: Dir) {
    wake();
    if (d === "up" && zoom === "fit") {
      flipDirection();
      return;
    }
    if (zoom !== "fit") {
      nudgePan(d);
      return; // zoomed: the arrows are the pan
    }
    if (d === "left" || d === "right") step(d);
    // at fit, down is an honest no-op (there is nothing below the page)
  }

  onMount(() => {
    remote.setHandlers({ onBack, onOK, onNavigate });
    wake();
    if (file && model) loadPage(index);
    else dispatch("back"); // defensive: the App should never route here empty
    return () => {
      remote.clearHandlers(); // no stale handlers leak into the library
      if (hideTimer) clearTimeout(hideTimer);
      if (flashTimer) clearTimeout(flashTimer);
      freeUrl();
      if (prefetched) {
        prefetched.promise.then((r) => URL.revokeObjectURL(r.url), () => undefined);
      }
    };
  });

  $: if (errorEl) remote.focusEl(errorEl);
</script>

<div class="reader" bind:clientWidth={viewW} bind:clientHeight={viewH}>
  {#if pageState !== "error" && src}
    <img
      class="page"
      {src}
      alt={altText}
      draggable="false"
      bind:this={imgEl}
      style="width: {wPx}px; height: {hPx}px; left: {leftPx}px; top: {topPx}px;"
      on:load={onImgLoad}
      on:error={onImgError}
    />
  {/if}

  {#if pageState === "loading"}
    <div class="center">
      <div class="spinner" role="status" aria-label="Loading"></div>
      <p class="muted">Loading page {pageNo} of {total}…</p>
    </div>
  {:else if pageState === "error"}
    <div class="center">
      <p class="big">Couldn’t display page {pageNo}</p>
      <p class="muted">
        {page ? page.base : ""} {page ? "— " + fmtBytes(page.size) : ""}
      </p>
      <p class="muted small">
        The page didn’t load, or it isn’t a decodable image. Press
        {dir === "ltr" ? "→" : "←"} to continue.
      </p>
      <button class="btn primary" data-focus bind:this={errorEl} on:click={retry}>
        Try again
      </button>
    </div>
  {/if}

  {#if flash}
    <div class="flash">{flash}</div>
  {/if}

  {#if pageState === "ready"}
    <div class="caption" class:dim={!captionVisible}>
      <span class="name">{file ? file.name : ""}</span>
      <span class="meta">
        {pageNo} of {total}
        {#if zoom !== "fit"}<span class="sep">·</span>{zoom}{/if}
        <span class="sep">·</span>
        {page ? fmtBytes(page.size) : ""}
      </span>
    </div>
    <div class="progress" aria-hidden="true">
      <div class="fill" class:rtl={dir === "rtl"} style="width: {pct}%"></div>
    </div>
  {/if}
</div>

<style>
  .reader {
    position: absolute;
    top: 0;
    right: 0;
    bottom: 0;
    left: 0;
    background: var(--bg);
    overflow: hidden;
  }

  .page {
    position: absolute;
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
    max-width: 80vw;
    overflow-wrap: anywhere;
  }

  .muted.small {
    font-size: var(--fs-small);
    color: var(--text-3);
    margin-bottom: 24px;
  }

  .flash {
    position: absolute;
    top: 16%;
    left: 0;
    right: 0;
    text-align: center;
    font-size: var(--fs-h1);
    font-weight: 700;
    color: var(--accent);
    pointer-events: none;
  }

  .caption {
    position: absolute;
    left: 0;
    right: 0;
    bottom: 3px;
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    padding: 16px 28px 20px;
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
    max-width: 62vw;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
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

  .progress {
    position: absolute;
    left: 0;
    right: 0;
    bottom: 0;
    height: 3px;
    background: rgba(255, 255, 255, 0.14);
    pointer-events: none;
  }

  .progress .fill {
    height: 100%;
    background: var(--accent);
    transition: width 0.2s ease-out;
  }

  .progress .fill.rtl {
    margin-left: auto;
  }
</style>
