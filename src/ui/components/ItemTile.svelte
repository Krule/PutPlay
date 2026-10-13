<script lang="ts">
  import { onMount, onDestroy, createEventDispatcher } from "svelte";
  import { getRemote } from "../../webos/remote";
  import { fmtBytes } from "../../putio/api";
  import { putioIsFolder, type PutFile } from "../../putio/types";

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
      <span class="glyph">📖</span>
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
