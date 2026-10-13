<script lang="ts">
  import { onMount, onDestroy, createEventDispatcher } from "svelte";
  import { get } from "svelte/store";
  import { getRemote } from "../../webos/remote";
  import { platform } from "../../webos/platform";
  import { library, listFolder, openFolder, backOneLevel, loadMore, cycleSort, mountFolderId, needsInitialList } from "../../store/library";
  import type { SortBy } from "../../store/library";
  import { currentAuth, auth } from "../../store/auth";
  import { nav, requestSettings } from "../../store/nav";
  import { libraryOkAction } from "../../putio/library-ok";
  import { isImageFile } from "../../putio/image";
  import { shelf, shelfSorted } from "../../store/comic";
  import type { ComicProgress } from "../../putio/comic-progress";
  import { fmtBytes } from "../../putio/api";
  import { putioIsFolder, type PutFile } from "../../putio/types";
  import ItemTile from "../components/ItemTile.svelte";

  let s: any = get(library);
  $: files = s.files;
  $: loading = s.loading;
  $: loadingMore = s.loadingMore;
  $: error = s.error;
  $: breadcrumbs = s.breadcrumbs;
  $: folderId = s.folderId;
  $: sortBy = s.sortBy;
  $: sortDir = s.sortDir;
  $: hasMore = s.hasMore;
  $: selected = s.selected;

  let a: any = get(auth);
  $: accountName = a.accountName;
  $: accountEmail = a.accountEmail;
  $: disk = a.disk;
  $: subtitleLanguages = a.subtitleLanguages;

  const remote = getRemote();

  // expose for parent (Player) via custom events
  const dispatch = createEventDispatcher();
  export function openFile(file: PutFile) {
    dispatch("open", { file });
  }

  let gridEl: HTMLElement;

  // the continue-reading shelf (root only): comics with a saved position.
  // Subscribed like the library and auth stores (subscribe-in-onMount, local
  // state) — never a $-binding, never a get() inside a reactive statement.
  let shelfRows: ComicProgress[] = [];
  let shelfEl: HTMLElement;

  function onShelfOpen(p: ComicProgress) {
    // The reader only needs id + name — no live PutFile required. If the
    // file has vanished from put.io, the App's tail read fails and the
    // honest toast keeps us in the library (the same path as a deleted tile).
    dispatch("open-archive", { file: { id: p.file_id, name: p.name } });
  }

  // In the SCRIPT, not the template attribute: Svelte's template parser is
  // plain-JS (svelte-preprocess only transforms the <script>), so a TS
  // generic like .closest<HTMLElement> is an "Unexpected token" in markup.
  function onShelfClick(e: MouseEvent) {
    const rowEl = (e.target as HTMLElement).closest<HTMLElement>(".shelf-row");
    if (!rowEl || !shelfEl) return;
    const i = Number(rowEl.dataset.i || "0");
    if (shelfRows[i]) onShelfOpen(shelfRows[i]);
  }

  const isVideoFile = (f: PutFile) => !putioIsFolder(f) && /video/i.test(f.content_type || "");
  const isPlayable = (f: PutFile) =>
    isVideoFile(f) || /\.(mp4|mkv|avi|mov|m4v|webm|mp3|m4a|flac|ogg|wav|aac)$/i.test(f.name || "");

  function onOpenFile(f: PutFile) {
    if (putioIsFolder(f)) {
      const au = currentAuth();
      if (au) openFolder(au, f);
    } else if (isPlayable(f)) {
      openFile(f);
    } else if (isImageFile(f)) {
      // Decodable raster image → the fit-to-screen viewer (v1: no zoom).
      // Only provably displayable formats reach here (HEIC/SVG stay closed).
      dispatch("open-image", { file: f });
    } else if (/\.cbr|\.cbt|\.rar|\.7z$/i.test(f.name || "")) {
      // Honest refusal: the RAR codec (pako is deflate-only) can't be read
      // here, so a RAR comic is offered nowhere. Say what IS supported.
      platform.toast("CBR (RAR) comics aren't supported yet — CBZ only");
    } else if (/\.zip$/i.test(f.name || "") || /\.cbz$/i.test(f.name || "")) {
      // ZIP/CBZ is open NOW: the App does the tail read and decides — a book
      // (>= 2 decodable images) goes to the comic reader, a folder goes to
      // the archive browser. RAR/7z stay honest.
      dispatch("open-archive", { file: f });
    } else if (/\.(tar|gz|iso)$/i.test(f.name || "")) {
      platform.toast("Archive — coming soon");
    } else {
      platform.toast("This file can't be played on the TV");
    }
  }

  function onBack() {
    const au = currentAuth();
    if (!au) return;
    if (s.breadcrumbs.length > 1) {
      backOneLevel(au);
    } else {
      dispatch("root");
    }
  }

  function onSort() {
    cycleSort();
  }

  function onColor(color: "blue" | "green" | "red" | "yellow") {
    if (color === "red") {
      // back / up a level shortcut
      onBack();
    }
  }

  function onNavigate() {
    // grid tiles handle their own spatial moves via Remote
  }

  // subscribe remote handlers for this screen
  function wireRemote() {
    remote.setHandlers({
      onBack,
      onColor,
      onNavigate,
      onOK: () => {
        // Same contract for both remotes: a spatially focused control wins
        // (header buttons, breadcrumbs, tiles); only with nothing focused do
        // we fall back to the last selected item.
        const f = get(library).selected;
        const action = libraryOkAction(!!remote.activeEl, !!f);
        if (action === "activate-focused") remote.clickActive();
        else if (action === "open-selected" && f) onOpenFile(f);
      },
    });
  }

  onMount(() => {
    wireRemote();
    const unsubLib = library.subscribe((v) => (s = v));
    const unsubAuth = auth.subscribe((v) => (a = v));
    const unsubShelf = shelf.subscribe((rows) => (shelfRows = shelfSorted(rows)));
    let lastBack = 0;
    const unsubNav = nav.subscribe((v) => {
      if (v.backLevel !== lastBack) {
        lastBack = v.backLevel;
        onBack();
      }
    });
    s = get(library);
    a = get(auth);

    // initial list: a first launch fetches the root; a return from the
    // player/Settings shows the cached folder the user was in (no reset to
    // root, no spinner flash)
    const au = currentAuth();
    if (au && needsInitialList(get(library))) listFolder(au, mountFolderId(get(library)));

    // auto-load-more near the bottom
    const onScroll = () => {
      if (!gridEl) return;
      if (gridEl.scrollHeight - gridEl.scrollTop - gridEl.clientHeight < 800) {
        const au2 = currentAuth();
        if (au2) loadMore(au2);
      }
    };
    gridEl?.addEventListener("scroll", onScroll);
    scrollHandler = onScroll;
    gridEl?.addEventListener("scroll", syncTileStates);

    // focus first tile after load
    const t = setTimeout(focusFirstTile, 150);
    return () => {
      clearTimeout(t);
      unsubLib();
      unsubAuth();
      unsubNav();
      unsubShelf();
      remote.clearHandlers(); // BUG 5: no stale handlers may leak into Settings
      shelfEl?.querySelectorAll<HTMLElement>(".shelf-row").forEach((r) => {
        if (r.dataset.__reg) remote.unregister(r);
      });
      gridEl?.removeEventListener("scroll", onScroll);
      gridEl?.removeEventListener("scroll", syncTileStates);
    };
  });

  let scrollHandler: ((e: Event) => void) | null = null;

  function syncTileStates() {
    // re-score visited states as user scrolls (cheap: just nudge remote)
    gridEl?.querySelectorAll<HTMLElement>("[data-state='active']");
  }

  function focusFirstTile() {
    const first = gridEl?.querySelector<HTMLElement>("[data-focus]");
    if (first) remote.focusEl(first);
  }

  function onCrumb(i: number) {
    const au = currentAuth();
    if (!au) return;
    const bc = breadcrumbs[i];
    const target = bc.id;
    // rebuild breadcrumbs up to i
    const newBc = breadcrumbs.slice(0, i + 1);
    library.update((st) => ({ ...st, breadcrumbs: newBc }));
    listFolder(au, target);
  }

  $: sortLabel = sortBy === "name" ? "Name" : sortBy === "size" ? "Size" : "Date added";
  $: diskUsedPct = disk ? Math.round((disk.used / disk.size) * 100) : 0;

  // shelf rows register themselves with the remote (D-pad focus) the way the
  // header buttons do; the delegated click (above) serves mouse + clickActive
  $: if (shelfEl) {
    shelfEl.querySelectorAll<HTMLElement>(".shelf-row").forEach((r) => {
      if (!r.dataset.__reg) {
        r.dataset.__reg = "1";
        remote.register(r);
      }
    });
  }

  let sortBtn: HTMLButtonElement;
  let settingsBtn: HTMLButtonElement;

  function onSettings() {
    requestSettings();
  }

  function onTileOpen(f: PutFile) {
    library.update((st) => ({ ...st, selected: f }));
    onOpenFile(f);
  }

  $: {
    // register header buttons with remote
    if (sortBtn && !sortBtn.dataset.__reg) {
      sortBtn.dataset.__reg = "1";
      remote.register(sortBtn);
    }
    if (settingsBtn && !settingsBtn.dataset.__reg) {
      settingsBtn.dataset.__reg = "1";
      remote.register(settingsBtn);
    }
  }
</script>

<div class="library">
  <!-- header -->
  <header class="head">
    <div class="crumbs">
      {#each breadcrumbs as cr, i (cr.id ?? "root")}
        <button class="crumb" class:last={i === breadcrumbs.length - 1} data-focus on:click={() => onCrumb(i)}>
          {cr.name}
        </button>
        {#if i < breadcrumbs.length - 1}<span class="crumb-sep">/</span>{/if}
      {/each}
    </div>
    <div class="head-actions">
      <button class="btn ghost sm" bind:this={sortBtn} data-focus on:click={onSort}>
        <span class="sort-ico">{sortDir === "asc" ? "↑" : "↓"}</span> {sortLabel}
      </button>
      <button class="btn ghost sm" bind:this={settingsBtn} data-focus on:click={onSettings}>
        <span class="acct" class:has={!!accountName}>
          {accountName || "Account"}
        </span>
      </button>
    </div>
  </header>

  <!-- continue-reading shelf (library root only) -->
  {#if folderId === null && !loading && !error && shelfRows.length > 0}
    <div class="shelf" bind:this={shelfEl} on:click={onShelfClick}>
      <p class="shelf-title">Continue reading</p>
      {#each shelfRows as row, i (row.file_id)}
        <div class="shelf-row" data-focus data-i={i} role="button">
          <span class="glyph">📖</span>
          <span class="shelf-name">{row.name}</span>
          <span class="shelf-pos">{row.page + 1} of {row.total}</span>
        </div>
      {/each}
    </div>
  {/if}

  <!-- disk bar -->
  {#if disk}
    <div class="diskbar" title={fmtBytes(disk.avail) + " free of " + fmtBytes(disk.size)}>
      <div class="diskbar-fill" class:warn={diskUsedPct > 85} style="width: {Math.min(100, diskUsedPct)}%"></div>
    </div>
  {/if}

  <!-- body -->
  {#if loading}
    <div class="state-col">
      <div class="spinner"></div>
      <p class="muted">Loading {breadcrumbs[breadcrumbs.length - 1]?.name}…</p>
    </div>
  {:else if error}
    <div class="state-col">
      <p class="error-text">{error}</p>
      <button class="btn primary" on:click={() => { const au = currentAuth(); if (au) listFolder(au, folderId); }}>Try again</button>
    </div>
  {:else if files.length === 0}
    <div class="state-col">
      <p class="big-empty">This folder is empty</p>
      <p class="muted">Files and folders you add on put.io will show up here.</p>
    </div>
  {:else}
    <div class="grid-wrap">
      <div class="grid" bind:this={gridEl}>
        {#each files as f, i (f.id)}
          <ItemTile
            file={f}
            index={i}
            on:open={(e) => {
              const f = e.detail.file;
              library.update((st) => ({ ...st, selected: f }));
              onOpenFile(f);
            }} />
        {/each}
      </div>
      {#if hasMore}
        <div class="loadmore">
          {#if loadingMore}<div class="spinner small"></div>{:else}<span class="muted">scroll for more…</span>{/if}
        </div>
      {/if}
    </div>
  {/if}
</div>

<style>
  .library {
    width: 1920px;
    height: 1080px;
    display: flex;
    flex-direction: column;
    padding: 36px 56px 0;
    position: relative;
  }
  .head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding-bottom: 20px;
  }
  .head > :not(:first-child) {
    margin-left: 24px;
  }
  .crumbs {
    display: flex;
    align-items: center;
    overflow: hidden;
    flex: 1;
    min-width: 0;
  }
  .crumbs > :not(:first-child) {
    margin-left: 10px;
  }
  .crumb {
    font-size: var(--fs-h2);
    font-weight: 600;
    color: var(--text-2);
    padding: 8px 14px;
    border-radius: var(--r-sm);
    white-space: nowrap;
    border: 2px solid transparent;
  }
  .crumb:last-of-type,
  .crumb.last {
    color: var(--text);
    font-weight: 700;
  }
  .crumb-sep {
    color: var(--text-3);
    font-size: var(--fs-h2);
  }
  .head-actions {
    display: flex;
    flex-shrink: 0;
  }
  .head-actions > :not(:first-child) {
    margin-left: 16px;
  }
  .btn.sm {
    padding: 12px 24px;
    font-size: var(--fs-body);
    display: flex;
    align-items: center;
  }
  .btn.sm > :not(:first-child) {
    margin-left: 10px;
  }
  .sort-ico {
    color: var(--accent-2);
    font-weight: 700;
  }
  .acct {
    max-width: 260px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--text-2);
  }
  .acct.has {
    color: var(--text);
  }
  .diskbar {
    height: 6px;
    border-radius: 3px;
    background: var(--surface);
    margin: 4px 0 28px;
    overflow: hidden;
  }
  .diskbar-fill {
    height: 100%;
    border-radius: 3px;
    background: var(--accent);
    transition: width var(--t-slow) var(--ease);
  }
  .diskbar-fill.warn {
    background: var(--warn);
  }
  .state-col {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
  }
  .state-col > :not(:first-child) {
    margin-top: 24px;
  }
  .muted {
    color: var(--text-2);
  }
  .error-text {
    color: var(--danger);
    font-size: var(--fs-h3);
  }
  .big-empty {
    font-size: var(--fs-h2);
    color: var(--text);
    font-weight: 700;
  }
  /* -------- continue-reading shelf (library root only) -------- */
  .shelf {
    padding-bottom: 16px;
  }
  .shelf-title {
    margin: 0 0 8px;
    font-size: var(--fs-small);
    font-weight: 600;
    color: var(--text-3);
  }
  .shelf-row {
    display: flex;
    align-items: center;
    height: 72px;
    padding: 0 16px;
    background: var(--bg-raised);
    border-radius: var(--r-md);
    border: 3px solid transparent;
    transition: transform var(--t-fast) var(--ease), border-color var(--t-fast) var(--ease),
      box-shadow var(--t-fast) var(--ease), background var(--t-fast) var(--ease);
  }
  .shelf-row + .shelf-row {
    margin-top: 8px;
  }
  .shelf-row .glyph {
    font-size: 32px;
    margin-right: 16px;
  }
  .shelf-name {
    flex: 1;
    font-size: var(--fs-body);
    color: var(--text);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .shelf-pos {
    font-size: var(--fs-small);
    color: var(--text-3);
    font-variant-numeric: tabular-nums;
    margin-left: 16px;
  }
  .shelf-row[data-state="active"] {
    border-color: var(--accent);
    box-shadow: var(--elev-md);
    background: var(--surface-2);
  }
  .shelf-row[data-state="visited"] {
    border-color: var(--accent-visited);
  }

  .grid-wrap {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }
  .grid {
    flex: 1;
    overflow-y: auto;
    /* clip x: a scaled (transformed) focus target must never grow scrollable
       x-overflow — that summoned a bottom scrollbar whenever the rightmost
       tile was active. Vertical scrolling is untouched. */
    overflow-x: hidden;
    display: grid;
    grid-template-columns: repeat(7, 236px);
    justify-content: center;
    /* 20px gap (not 24): 7×236px tracks must fit the grid content box so the
       scaled (1.06×) rightmost tile keeps ≥7px of room to the clip edge */
    gap: 20px;
    align-content: start;
    padding: 8px 12px 80px;
    scrollbar-width: thin;
    scrollbar-color: var(--surface-3) transparent;
  }
  .grid::-webkit-scrollbar {
    width: 10px;
  }
  .grid::-webkit-scrollbar-thumb {
    background: var(--surface-3);
    border-radius: 5px;
  }
  .loadmore {
    height: 64px;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .spinner.small {
    width: 30px;
    height: 30px;
    border-width: 3px;
  }
</style>
