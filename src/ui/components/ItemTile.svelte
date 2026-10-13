<script lang="ts">
  import { onMount, onDestroy, createEventDispatcher } from "svelte";
  import { getRemote } from "../../webos/remote";
  import { fmtBytes } from "../../putio/api";
  import { putioIsFolder, type PutFile } from "../../putio/types";
  import { openArchive, extractEntry } from "../../putio/zip-extract";
  import { buildComicModel } from "../../putio/comic";
  import { pageCache, pageKey } from "../../store/comic";
  import { getThumb, putThumb } from "../../store/thumb-store";
  import { currentAuth } from "../../store/auth";
  import { probeImage } from "../img-probe";

  export let file: PutFile;
  export let index = 0;
  // optional direct handlers (keyboard / programmatic). The tile ALSO dispatches
  // a Svelte "open" event with detail.file — parents can use on:open.
  export let onOpen: ((f: PutFile) => void) | null = null;

  const dispatch = createEventDispatcher();

  const remote = getRemote();
  let el: HTMLElement;
  let active = false;
  let visited = false;
  let imgFailed = false;

  /* The comic cover: THREE rungs, cheapest first.
     1. the PERSISTENT thumb (localStorage, 1-month TTL) — a previous
        session already paid; zero network, zero blobs;
     2. the in-memory page cache — the reader (or an earlier tile) fetched
        this session; down-scale it now;
     3. the network — two-stage open, cover of the READING order, range
        read + inflate + probe; down-scale and persist for next time.
     Failure at any rung → the glyph (an empty thumb would be a lie).
     The LRU owns the full-res blob's life; the persistent store owns the
     data URL. Quota refusal = displayed, not persisted — never thrown. */
  const THUMB_MAX_PX = 480; // the tile is 236 CSS px; 2x covers the 4K glass
  let coverState: "none" | "loading" | "ready" | "failed" = "none";
  let coverUrl = "";

  function loadCover() {
    const au = currentAuth();
    if (!au) return; // the library requires auth; an honest no-op regardless
    const persisted = getThumb(file.id);
    if (persisted) {
      coverUrl = persisted.dataUrl;
      coverState = "ready";
      return;
    }
    const key = pageKey(file.id, 0);
    const hit = pageCache.get(key);
    if (hit) {
      showDownscaled(hit.url);
      return;
    }
    coverState = "loading";
    openArchive(au, file)
      .then((m) => buildComicModel(m.entries))
      .then((book) => {
        const cover = book.pages[0];
        if (!cover) {
          coverState = "failed"; // a "comic" with no decodable pages
          return;
        }
        return extractEntry(au, file, cover.entry).then(({ data, mime }) =>
          probeImage(URL.createObjectURL(new Blob([data], { type: mime }))),
        ).then((p) => {
          pageCache.put(key, { url: p.url, w: p.w, h: p.h });
          showDownscaled(p.url);
        });
      })
      .catch(() => {
        coverState = "failed"; // offline, corrupt, not a zip: the glyph stays
      });
  }

  /** Down-scale the cover blob to a tile-sized JPEG data URL, show it, and
   *  persist it for the next launch. The canvas or the TV's storage can
   *  refuse — then we show the full-res blob and skip persisting, quietly. */
  function showDownscaled(blobUrl: string) {
    const img = new Image();
    img.onload = () => {
      const w0 = img.naturalWidth;
      if (!w0) {
        coverUrl = blobUrl;
        coverState = "ready";
        return;
      }
      const scale = Math.min(1, THUMB_MAX_PX / w0);
      const w = Math.max(1, Math.round(w0 * scale));
      const h = Math.max(1, Math.round(img.naturalHeight * scale));
      let dataUrl = "";
      try {
        const c = document.createElement("canvas");
        c.width = w;
        c.height = h;
        const ctx = c.getContext("2d");
        if (ctx) {
          ctx.drawImage(img, 0, 0, w, h);
          dataUrl = c.toDataURL("image/jpeg", 0.82);
        }
      } catch {
        dataUrl = ""; // canvas refusal: full-res display, no persist
      }
      coverUrl = dataUrl || blobUrl;
      coverState = "ready";
      if (dataUrl) putThumb(file.id, { dataUrl, w, h, savedAt: Date.now() });
    };
    img.onerror = () => {
      coverUrl = blobUrl;
      coverState = "ready";
    };
    img.src = blobUrl;
  }

  const isFolder = putioIsFolder(file);
  const isVideo = !isFolder && file.content_type ? file.content_type.startsWith("video/") : false;
  const isComic = !isFolder && /\.cbz$/i.test(file.name || "");
  const isArchive =
    !isFolder && !isComic && file.content_type
      ? file.content_type.startsWith("application/") && !isVideo
      : false;

  $: if (el) {
    if (active) el.dataset.state = "active";
    else if (visited) el.dataset.state = "visited";
    else el.removeAttribute("data-state");
  }

  function emitOpen() {
    if (onOpen) onOpen(file);
    dispatch("open", { file });
  }

  onMount(() => {
    if (el) {
      remote.register(el);
      el.addEventListener("click", () => emitOpen());
    }
    if (isComic) loadCover();
  });
  onDestroy(() => el && remote.unregister(el));
</script>

<div class="tile" bind:this={el} data-focus data-state="">
  <div class="thumb" class:folder={isFolder} class:video={isVideo} class:archive={isArchive} class:comic={isComic}>
    {#if file.screenshot && !imgFailed}
      <img src={file.screenshot} alt="" loading="lazy" onerror={() => (imgFailed = true)} />
    {:else if isFolder}
      <span class="glyph">📁</span>
    {:else if isComic}
      {#if coverState === "ready" && coverUrl}
        <img src={coverUrl} alt="" onerror={() => (coverState = "failed")} />
      {:else}
        <span class="glyph">📖</span>
      {/if}
    {:else if isArchive}
      <span class="glyph">🗜️</span>
    {:else if isVideo}
      <span class="glyph">🎬</span>
    {:else}
      <span class="glyph">📄</span>
    {/if}
    {#if isVideo && file.is_mp4_available}
      <span class="chip mp4" title="put.io MP4 ready">MP4</span>
    {:else if isVideo && !file.is_mp4_available && file.need_convert}
      <span class="chip conv" title="Converting">⚙</span>
    {/if}
    {#if isVideo && file.size > 0}
      <span class="chip size">{fmtBytes(file.size)}</span>
    {/if}
  </div>
  <div class="name">{file.name}</div>
</div>

<style>
  .tile {
    position: relative;
    width: 236px;
    border-radius: var(--r-md);
    background: transparent;
    border: 3px solid transparent;
    transition: transform var(--t-fast) var(--ease), border-color var(--t-fast) var(--ease),
      box-shadow var(--t-fast) var(--ease), opacity var(--t-med) var(--ease);
    display: flex;
    flex-direction: column;
  }
  .tile[data-state="active"] {
    transform: scale(1.06);
    border-color: var(--accent);
    box-shadow: var(--elev-md);
    z-index: 5;
  }
  .tile[data-state="visited"] {
    border-color: var(--accent-visited);
  }
  .tile[data-state="disabled"] {
    opacity: 0.35;
  }
  .thumb {
    width: 236px;
    height: 133px;
    border-radius: var(--r-md);
    overflow: hidden;
    background: linear-gradient(160deg, var(--surface-2), var(--surface));
    display: flex;
    align-items: center;
    justify-content: center;
    position: relative;
  }
  .thumb img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
  }
  .thumb .glyph {
    font-size: 52px;
    opacity: 0.85;
  }
  .thumb.video {
    background: linear-gradient(160deg, var(--thumb-video-1), var(--thumb-video-2));
  }
  .thumb.folder {
    background: linear-gradient(160deg, var(--thumb-folder-1), var(--thumb-folder-2));
  }
  .thumb.archive {
    background: linear-gradient(160deg, var(--thumb-archive-1), var(--thumb-archive-2));
  }
  .thumb.comic {
    background: linear-gradient(160deg, var(--thumb-comic-1), var(--thumb-comic-2));
  }
  .chip {
    position: absolute;
    font-size: var(--fs-micro);
    font-weight: 700;
    padding: 3px 8px;
    border-radius: 6px;
    letter-spacing: 0.05em;
  }
  .chip.mp4 {
    top: 8px;
    left: 8px;
    background: var(--chip-ok-bg);
    color: var(--on-ok);
  }
  .chip.conv {
    top: 8px;
    left: 8px;
    background: var(--chip-warn-bg);
    color: var(--on-warn);
  }
  .chip.size {
    bottom: 8px;
    right: 8px;
    background: rgba(0, 0, 0, 0.55);
    color: var(--chip-ink);
  }
  .name {
    margin-top: 10px;
    padding: 0 4px;
    font-size: var(--fs-body);
    line-height: 1.25;
    color: var(--text);
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
    min-height: 2.5em;
  }
  .tile[data-state="active"] .name {
    color: var(--text);
  }
</style>
