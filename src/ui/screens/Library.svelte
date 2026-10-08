<script lang="ts">
  import { onMount, onDestroy, createEventDispatcher } from "svelte";
  import { get } from "svelte/store";
  import { getRemote } from "../../webos/remote";
  import { platform } from "../../webos/platform";
  import { library, listFolder, openFolder, backOneLevel, loadMore, cycleSort } from "../../store/library";
  import type { SortBy } from "../../store/library";
  import { currentAuth, auth } from "../../store/auth";
  import { nav, requestSettings } from "../../store/nav";
  import { fmtBytes, getFile } from "../../putio/api";
  import { putioIsFolder, type PutFile } from "../../putio/types";
  import ItemTile from "../components/ItemTile.svelte";
  import Menu from "../components/Menu.svelte";

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

  const isVideoFile = (f: PutFile) => !putioIsFolder(f) && /video/i.test(f.content_type || "");
  const isPlayable = (f: PutFile) =>
    isVideoFile(f) || /\.(mp4|mkv|avi|mov|m4v|webm|mp3|m4a|flac|ogg|wav|aac)$/i.test(f.name || "");

  function onOpenFile(f: PutFile) {
    if (putioIsFolder(f)) {
      const au = currentAuth();
      if (au) openFolder(au, f);
    } else if (isPlayable(f)) {
      openFile(f);
    } else if (/\.(zip|rar|7z|tar|gz|iso)$/i.test(f.name || "")) {
      platform.toast("Archive — coming soon");
    } else {
      platform.toast("This file can't be played on the TV");
    }
  }

  let menuFor: PutFile | null = null;
  let menuVisible = false;
  let menuItems: any[] = [];

  async function onMenu(f: PutFile) {
    menuFor = f;
    const base = [
      { id: "info", label: "Details", icon: "ℹ" },
      { id: "link", label: "Copy download link", icon: "🔗" },
    ];
    if (putioIsFolder(f)) base.push({ id: "open", label: "Open folder", icon: "📂" });
    else base.push({ id: "convert", label: f.is_mp4_available ? "MP4 ready" : "Queue MP4 conversion", icon: "⚙" });
    menuItems = base;
    menuVisible = true;
  }

  async function onMenuPick(it: any) {
    const f = menuFor;
    if (!f) return;
    if (it.id === "__cancel") {
      menuVisible = false;
      return;
    }
    const au = currentAuth();
    if (!au) return;
    menuVisible = false;
    if (it.id === "info") {
      let extra = "";
      try {
        const d = await getFile(au, f.id, { mediaInfo: true });
        const streams = d.media_info?.streams || [];
        const v = streams.find((x) => x.codec_type === "video");
        const auds = streams.filter((x) => x.codec_type === "audio");
        const subs = streams.filter((x) => x.codec_type === "subtitle");
        if (v) extra += `${v.codec_name?.toUpperCase()}${v.profile ? " " + v.profile : ""} · `;
        extra += `${fmtBytes(f.size)}`;
        if (d.duration) extra += ` · ${fmtTime(d.duration)}`;
        if (auds.length) extra += `\n${auds.length} audio track${auds.length > 1 ? "s" : ""}`;
        if (subs.length) extra += `\n${subs.length} embedded subtitle${subs.length > 1 ? "s" : ""}`;
      } catch {}
      platform.toast(`${f.name}\n${extra}`, 6000);
    } else if (it.id === "link") {
      const au2 = currentAuth()!;
      const url = `https://app.put.io/dl/${f.id}/?token=${au2.downloadToken}`;
      await platform.copyToClipboard(url);
      platform.toast("Download link copied");
    } else if (it.id === "open") {
      openFolder(au, f);
    } else if (it.id === "convert") {
      try {
        await fetch(`https://api.put.io/v2/files/${f.id}/mp4/stream`, {
          method: "GET",
          headers: { Authorization: `Bearer ${au.oauthToken}` },
          redirect: "manual",
        });
        platform.toast("MP4 conversion requested — check back in a few minutes");
      } catch {
        platform.toast("Could not request conversion");
      }
    }
  }

  function fmtTime(sec: number): string {
    sec = Math.floor(sec);
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s2 = sec % 60;
    return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${String(s2).padStart(2, "0")}` : `${m}:${String(s2).padStart(2, "0")}`;
  }

  function onBack() {
    if (menuVisible) {
      menuVisible = false;
      return;
    }
    const au = currentAuth();
    if (!au) return;
    if (s.breadcrumbs.length > 1) {
      backOneLevel(au);
    } else {
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
        const f = get(library).selected;
        if (f) onOpenFile(f);
      },
    });
  }

  onMount(() => {
    wireRemote();
    const unsubLib = library.subscribe((v) => (s = v));
    const unsubAuth = auth.subscribe((v) => (a = v));
    let lastBack = 0;
    const unsubNav = nav.subscribe((v) => {
      if (v.backLevel !== lastBack) {
        lastBack = v.backLevel;
        onBack();
      }
    });
    s = get(library);
    a = get(auth);

    // initial list
    const au = currentAuth();
    if (au) listFolder(au, null);

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

  let sortBtn: HTMLButtonElement;
  let settingsBtn: HTMLButtonElement;

  function onSettings() {
    requestSettings();
  }

  function onTileOpen(f: PutFile) {
    library.update((st) => ({ ...st, selected: f }));
    onOpenFile(f);
  }
  function onTileMenu(f: PutFile) {
    library.update((st) => ({ ...st, selected: f }));
    onMenu(f);
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
          <ItemTile file={f} index={i} onOpen={onTileOpen} onMenu={onTileMenu} />
        {/each}
      </div>
      {#if hasMore}
        <div class="loadmore">
          {#if loadingMore}<div class="spinner small"></div>{:else}<span class="muted">scroll for more…</span>{/if}
        </div>
      {/if}
    </div>
  {/if}

  <!-- color legend -->
  <div class="color-legend">
    <div class="cl"><span class="dot c1"></span>Play</div>
    <div class="cl"><span class="dot c2"></span>Details</div>
    <div class="cl"><span class="dot c3"></span>Sort</div>
    <div class="cl"><span class="dot c4"></span>Back</div>
  </div>

  {#if menuVisible}
    <Menu title={menuFor?.name || ""} items={menuItems} onPick={onMenuPick} />
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
    gap: 24px;
    padding-bottom: 20px;
  }
  .crumbs {
    display: flex;
    align-items: center;
    gap: 10px;
    overflow: hidden;
    flex: 1;
    min-width: 0;
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
    gap: 16px;
    flex-shrink: 0;
  }
  .btn.sm {
    padding: 12px 24px;
    font-size: var(--fs-body);
    display: flex;
    align-items: center;
    gap: 10px;
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
    gap: 24px;
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
  .grid-wrap {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }
  .grid {
    flex: 1;
    overflow-y: auto;
    display: grid;
    grid-template-columns: repeat(7, 236px);
    justify-content: center;
    gap: 20px 24px;
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
