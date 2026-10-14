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
    cycleZoom,
    zoomScale,
    panBounds,
    nudge,
    buildSheets,
    sheetForPage,
    sheetPageLabel,
    type Direction,
    type ZoomLevel,
    type TurnDir,
    type Sheet,
  } from "../../putio/comic";
  import { probeImage } from "../img-probe";
  import { createPageDeduper } from "../../putio/page-cache";
  import { comic, setComic, upsertProgress, pageCache, pageKey } from "../../store/comic";

  /**
   * Comic reader — the book screen (plan: .agents/plan.md, §8 = v1.1 TV
   * feedback: spread mode + the in-reader direction legend).
   *
   * The book is read in SHEETS, not pages: the cover (first page) alone,
   * then consecutive uniform pages side by side (a spread), and any WIDE
   * page — a pre-scanned spread, or one of the occasional odd-shaped
   * pages — alone. The sheet model is pure (buildSheets) and decided by
   * page SIZE against the book's median — real data: Preacher #01 →
   * 1 + 20 pairs; Mushoku v01 → exactly the 4 scanned spreads solo.
   *
   *   ←/→  turn the sheet (direction-aware — in a manga, LEFT goes forward)
   *        or PAN when zoomed (the arrow names where you LOOK: Up reveals
   *        the top — clamped to the sheet, never the wall)
   *   OK   zoom: fit → 2× → 4× → fit (relative to the sheet's OWN fit, so a
   *        675-px scan and a 2138-px scan feel identical)
   *   Up   flip the reading direction (persisted for THIS comic; the legend
   *        bottom-right tells you it exists); while zoomed, Up/Down pan
   *   Back exit — the position was already saved (no confirm, D10)
   *
   * The NEXT sheet is prefetched while the current one displays (≤2 pages =
   * ≤4 range reads in flight) — a turn is a cache hit, not a fetch. Nothing
   * is downloaded that is not read: a 351 MB volume costs the pages you
   * turn.
   */
  const dispatch = createEventDispatcher();
  const remote = getRemote();

  /** Session state, LOCAL — initialized from the comic store once (the App
   *  made the decision and put the session there before this screen mounted),
   *  and written BACK to the store on every change so it survives screen
   *  swaps. (Codebase idiom — a plain variable seeded from a store $-binding
   *  is NOT reactive: Svelte compiles dependent statements into one-shot
   *  init code. The caption froze at "1 of 13" while the store advanced.) */
  const initial = get(comic);
  let file = initial.file;
  let model = initial.model;
  let dir: Direction = initial.direction;
  // PLAIN const, not $: — the model is fixed for this screen's lifetime (a
  // new session mounts a fresh screen), and a $: declaration here is worse
  // than useless: Svelte's dependency resolution deferred its assignment
  // past the `let sheetIdx` below, which crashed the mount (undefined.length
  // on the C1-shaped e2e, 2026-10-13).
  const total = initial.model ? initial.model.pages.length : 0;
  const sheets = initial.model
    ? buildSheets(total, initial.model.pages.map((p) => p.size))
    : [];
  // A saved PAGE maps onto its sheet (either member of a pair finds the
  // same sheet — you re-read the pair's context). sheetIdx is reassigned
  // on every turn, so the derived values below must read it DIRECTLY in
  // their $: expressions — Svelte's dependencies are static per expression
  // and do NOT see through a function call (a `current()` reference would
  // freeze the caption, exactly like the get-store-inside-$: family).
  let sheetIdx = sheetForPage(sheets, initial.index);

  /** The page actually read to on a sheet — its last page (both LTR and
   *  RTL end on the larger index). */
  const readPage = (sheet: Sheet): number => sheet.pages[sheet.pages.length - 1];

  $: currentSheet = sheets[sheetIdx] || { pages: [0] };
  $: pageLabel = sheetPageLabel(currentSheet, total);
  $: sheetBytes = currentSheet.pages.reduce((a, p) => a + (model && model.pages[p] ? model.pages[p].size : 0), 0);
  $: pct = total ? ((readPage(currentSheet) + 1) / total) * 100 : 0;

  /* ---------------- sheet lifecycle (honest states) ---------------- */
  let viewW = 1920;
  let viewH = 1080;
  let sheetState: "loading" | "ready" | "error" = "loading";
  /** One slot per page in the current sheet: null until its bytes decode.
   *  The blob URLs here are OWNED BY THE LRU CACHE (page-cache via the
   *  store) — the screen revokes nothing; eviction and sign-out do. */
  let slots: ({ url: string; w: number; h: number } | null)[] = [];
  let attempt = 0; // supersede counter (fast turns)
  let failedPage = "";
  let failedBytes = 0;

  let errorEl: HTMLButtonElement | null = null;
  // the screen root — the focus scope keeps D-pad moves inside the reader
  let readerEl: HTMLElement | null = null;

  /* ---------------- zoom + pan (relative ladder, center-anchored) ------ */
  let zoom: ZoomLevel = "fit";
  let panX = 0;
  let panY = 0;

  $: sheetW = slots.reduce((a, s) => a + (s ? s.w : 0), 0);
  $: sheetH = slots.reduce((a, s) => Math.max(a, s ? s.h : 0), 0);
  $: scale = sheetState === "ready" && sheetW > 0 ? zoomScale(zoom, sheetW, sheetH, viewW, viewH) : 1;
  $: wPx = Math.round(sheetW * scale);
  $: hPx = Math.round(sheetH * scale);
  // CENTER-anchored: the sheet sits in the middle of the view at pan (0,0);
  // panning moves ±half the overflow (panBounds). The old edge-anchored
  // (viewW - wPx) + panX pushed a contained sheet to the right bezel.
  $: leftPx = (viewW - wPx) / 2 + panX;
  $: topPx = (viewH - hPx) / 2 + panY;

  /** One page: a cache hit (no network at all) or the range-read +
   *  inflate + probe path. New bytes go INTO the cache — from that moment
   *  the cache owns the blob (eviction/sign-out revoke it, never the
   *  screen), and a turn back through this page is a hit. The deduper
   *  means the prefetch and a turn (or a direction flip mid-flight) can
   *  both ask for the same page and pay for it ONCE — two parallel range
   *  reads of one 2 MB page would fight for the TV's bandwidth. */
  const pageDedup = createPageDeduper<{ url: string; w: number; h: number }>();

  function pageData(au: Auth, f: PutFile, entry: ZipEntry, key: string) {
    const hit = pageCache.get(key);
    if (hit) return Promise.resolve({ url: hit.url, w: hit.w, h: hit.h });
    return pageDedup.request(key, () =>
      extractEntry(au, f, entry).then(
        ({ data, mime }) => probeImage(URL.createObjectURL(new Blob([data], { type: mime }))),
      ),
    ).then((r) => {
      pageCache.put(key, { url: r.url, w: r.w, h: r.h });
      return r;
    });
  }

  interface PageResult {
    ok: boolean;
    page: number;
    url: string;
    w: number;
    h: number;
  }

  function loadSheet(s: number) {
    sheetIdx = s;
    sheetState = "loading";
    zoom = "fit";
    panX = 0;
    panY = 0;
    failedPage = "";
    failedBytes = 0;
    attempt += 1;
    const mine = attempt;
    slots = [];

    const au = currentAuth();
    const sheet = sheets[s];
    if (!au || !file || !model || !sheet || sheet.pages.length === 0) {
      sheetState = "error"; // an empty session is an error, not a blank
      return;
    }

    // THE NEXT SHEET'S BYTES START MOVING NOW — in parallel with this
    // sheet's own load, not after it. On 2 MB pages the old after-the-fact
    // prefetch never finished within the reader's turn time (the C1's
    // "slow between pages"); with full overlap, a turn finds the next
    // sheet ready. (Deduped: calling this twice is a join, not a re-fetch.)
    prefetch();

    // the prefetch hit (the next sheet we were just shown) is consumed here
    const hit = prefetched && prefetched.sheet === s ? prefetched : null;
    if (hit) prefetched = null;

    const datas: Promise<PageResult>[] = sheet.pages.map((p, i) => {
      const key = pageKey(file.id, p);
      const d = hit && hit.promises[i]
        ? hit.promises[i]
        : pageData(au, file, model.pages[p].entry, key);
      return d.then(
        (r) => ({ ok: true, page: p, url: r.url, w: r.w, h: r.h }),
        (err) => {
          console.error("comic page failed to load", err);
          return { ok: false, page: p, url: "", w: 0, h: 0 };
        }
      );
    });

    Promise.all(datas).then((results) => {
      // superseded results are KEPT: their bytes were read, they sit in
      // the LRU, and the next turn through them is a cache hit
      const fail = results.find((r) => !r.ok);
      if (mine !== attempt) return;
      if (fail) {
        const pg = model.pages[fail.page];
        failedPage = pg ? pg.base : "";
        failedBytes = pg ? pg.size : 0;
        sheetState = "error"; // D8: the corrupt page says so
        return;
      }
      slots = results.map((r) => ({ url: r.url, w: r.w, h: r.h }));
      sheetState = "ready";
      syncStore();
      saveProgress();
      wake();
      prefetch();
    });
  }

  function onImgError() {
    // the probe (probeImage) catches decode failures first; this is the
    // <img>'s own honest safety net
    if (sheetState === "ready") sheetState = "error";
  }

  function retry() {
    wake();
    loadSheet(sheetIdx);
  }

  /** Write the session (file, model, PAGE, direction) back to the store so
   *  it survives screen swaps. The stored page is the sheet's LAST page —
   *  the position you've actually read to. */
  function syncStore() {
    if (!file || !model) return;
    setComic(file, model, readPage(currentSheet), dir);
  }

  /* ---------------- turning (sheet by sheet, no wrap) ------------------ */
  function step(d: TurnDir) {
    if (!model || sheets.length === 0) return;
    // Reading always advances toward LARGER page numbers; the direction
    // decides which ARROW is forward (ltr: right, rtl: left).
    const forward = d === (dir === "ltr" ? "right" : "left");
    const backward = d === (dir === "ltr" ? "left" : "right");
    if (!forward && !backward) return;
    const next = forward ? sheetIdx + 1 : sheetIdx - 1;
    if (next < 0 || next >= sheets.length) return; // the honest stop at either end
    lastMove = forward ? "forward" : "backward"; // the prefetch follows you
    // Persist the turn NOW, not when the sheet finishes loading: a Back
    // during a slow 6 MB page load must not lose the turn (the page-mode
    // code saved in step(); the sheet rewrite regressed it — caught by
    // audit 2026-10-13). loadSheet's ready-path save writes the same value
    // again, harmlessly.
    if (file && model) {
      upsertProgress(file, file.name, readPage(sheets[next]), model.pages.length, dir);
    }
    syncStore();
    loadSheet(next);
  }

  /* ---------------- the prefetch (one sheet ahead of where you're HEADING) -
   * The C1's ask: when you're going back, prefetch backwards too. The
   * last move decides; a fresh open defaults to forward. (Already-read
   * sheets don't need prefetching at all — they're in the LRU cache.) */
  interface SheetPrefetch {
    sheet: number;
    promises: (Promise<{ url: string; w: number; h: number }> | null)[];
  }
  let prefetched: SheetPrefetch | null = null;
  let lastMove: "forward" | "backward" = "forward";

  function prefetch() {
    prefetched = null; // a fresh decision on every call
    const au = currentAuth();
    if (!model || !file || !au) return;
    const nextSheet = lastMove === "forward" ? sheetIdx + 1 : sheetIdx - 1;
    if (nextSheet < 0 || nextSheet >= sheets.length) return; // the honest stop at either end
    const next = sheets[nextSheet].pages;
    const promises = next.map((p) => {
      const d = pageData(au, file, model.pages[p].entry, pageKey(file.id, p));
      // keep the unmount case quiet: a prefetch no turn ever consumes must
      // not surface as an unhandled rejection
      d.catch(() => undefined);
      return d;
    });
    prefetched = { sheet: nextSheet, promises };
  }

  /* ---------------- progress (position + direction, per comic) --------- */
  function saveProgress() {
    if (!file || !model) return;
    upsertProgress(file, file.name, readPage(currentSheet), model.pages.length, dir);
  }

  function flipDirection() {
    if (!file || !model) return;
    const nextDir: Direction = dir === "ltr" ? "rtl" : "ltr";
    dir = nextDir;
    syncStore();
    flash = nextDir === "rtl" ? "right to left" : "left to right";
    if (flashTimer) clearTimeout(flashTimer);
    flashTimer = setTimeout(() => (flash = ""), 1600);
    // the flip is THIS comic's, remembered for it (per-comic; there is no
    // global default anymore — the legend below is the discoverability)
    saveProgress();
    wake();
    prefetch(); // "next" is sheet-ordered, but redo it cheaply and honestly
  }

  /* ---------------- zoom + pan keys ------------------------------------ */
  function onOK() {
    wake();
    // the now-playing strip owns its focused controls — a strip button under
    // the page must click, not turn the page
    const ae = remote.activeEl;
    if (ae && ae.closest("#np")) {
      remote.clickActive();
      return;
    }
    if (sheetState !== "ready" || sheetW <= 0) return; // nothing on screen to zoom
    zoom = cycleZoom(zoom);
    panX = 0;
    panY = 0; // every step of the ladder starts from the sheet's center
  }

  function nudgePan(d: Dir) {
    if (sheetState !== "ready" || sheetW <= 0) return;
    const stepPx = Math.max(48, Math.round(((d === "up" || d === "down") ? viewH : viewW) * 0.08));
    const b = panBounds(sheetW, sheetH, viewW, viewH, scale);
    // TV convention (the pure nudge): the arrow names where you LOOK —
    // Up reveals the top, Left the left. (Drag-style was inverted on the C1.)
    if (d === "right" || d === "left") panX = nudge(panX, b.maxX, d, stepPx);
    else panY = nudge(panY, b.maxY, d, stepPx);
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
    // at fit, down is an honest no-op (there is nothing below the sheet)
  }

  onMount(() => {
    remote.setHandlers({ onBack, onOK, onNavigate });
    // the arrows PAN the page here — scope the spatial remote to this
    // screen so the app-level now-playing strip (outside this root) can
    // never catch a D-pad move. The library keeps the strip reachable.
    remote.setFocusScope(readerEl);
    wake();
    if (file && model && sheets.length > 0) loadSheet(sheetIdx);
    else dispatch("back"); // defensive: the App should never route here empty
    return () => {
      remote.clearHandlers(); // no stale handlers leak into the library
      remote.setFocusScope(null); // lift the trap for the screen below
      if (hideTimer) clearTimeout(hideTimer);
      if (flashTimer) clearTimeout(flashTimer);
      // no blob cleanup: the LRU cache owns every page (it survives screen
      // swaps on purpose — the next open is a hit); sign-out clears it.
      // A prefetch still in flight simply lands in the cache, quieted by
      // the .catch above.
    };
  });

  $: if (errorEl) remote.focusEl(errorEl);
</script>

<div class="reader" bind:this={readerEl} bind:clientWidth={viewW} bind:clientHeight={viewH}>
  {#if sheetState === "ready" && slots.length > 0}
    <div
      class="sheet"
      class:rtl={dir === "rtl"}
      style="width: {wPx}px; height: {hPx}px; left: {leftPx}px; top: {topPx}px;"
    >
      {#each slots as slot, i (i)}
        {#if slot}
          <img
            class="page"
            src={slot.url}
            alt={model && model.pages[currentSheet.pages[i]] ? model.pages[currentSheet.pages[i]].base : ""}
            draggable="false"
            style="width: {Math.round(slot.w * scale)}px; height: {Math.round(slot.h * scale)}px;"
            on:error={onImgError}
          />
        {/if}
      {/each}
    </div>
  {/if}

  {#if sheetState === "loading"}
    <div class="center">
      <div class="spinner" role="status" aria-label="Loading"></div>
      <p class="muted">Loading {pageLabel} of {total}…</p>
    </div>
  {:else if sheetState === "error"}
    <div class="center">
      <p class="big">Couldn’t display {pageLabel}</p>
      <p class="muted">
        {failedPage} {failedBytes ? "— " + fmtBytes(failedBytes) : ""}
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

  <!-- the direction legend: persistent (NOT inside the auto-hiding caption) —
       the user removed the Settings choice, so this is the discoverability -->
  <div class="legend" aria-hidden="true">
    <span class="key">↑</span>
    flip · {dir === "rtl" ? "right to left" : "left to right"}
  </div>

  {#if sheetState === "ready"}
    <div class="caption" class:dim={!captionVisible}>
      <span class="name">{file ? file.name : ""}</span>
      <span class="meta">
        {pageLabel} of {total}
        {#if zoom !== "fit"}<span class="sep">·</span>{zoom}{/if}
        <span class="sep">·</span>
        {fmtBytes(sheetBytes)}
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

  .sheet {
    position: absolute;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  /* a manga pair: the earlier page reads from the RIGHT */
  .sheet.rtl {
    flex-direction: row-reverse;
  }

  .page {
    display: block;
    flex: none;
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

  .legend {
    position: absolute;
    top: 20px;
    right: 28px;
    display: flex;
    align-items: center;
    font-size: var(--fs-small);
    color: var(--text-3);
    pointer-events: none;
  }

  .legend .key {
    display: inline-block;
    padding: 2px 8px;
    margin-right: 8px;
    border-radius: var(--r-sm);
    background: var(--surface-2);
    color: var(--text-2);
    font-size: var(--fs-small);
    line-height: 1.2;
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
