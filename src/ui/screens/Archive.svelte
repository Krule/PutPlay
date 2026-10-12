<script lang="ts">
  import { onMount, onDestroy, createEventDispatcher } from "svelte";
  import { getRemote, type Dir } from "../../webos/remote";
  import { platform } from "../../webos/platform";
  import { currentAuth } from "../../store/auth";
  import { archive as archiveStore, setArchive } from "../../store/archive";
  import { get } from "svelte/store";
  import { openArchive, extractEntry, mimeFor } from "../../putio/zip-extract";
  import {
    archiveView,
    archiveParentPath,
    ZipError,
    type ArchiveRow,
    type ZipModel,
  } from "../../putio/zip";
  import { isImageFile, type ViewerTarget } from "../../putio/image";
  import { putioIsFolder, type PutFile } from "../../putio/types";
  import ItemTile from "../components/ItemTile.svelte";

  /**
   * Archive viewer v1 — a ZIP on put.io browsed like a folder: ONE range
   * read of the tail lists it (openArchive), entries open on demand.
   *
   * The back stack: inside a subfolder, Back pops ONE level (the archive
   * owns its levels, like the library owns its folder levels); at the
   * archive root, Back dispatches to the App, which leaves for the library.
   *
   * Only decodable images open (into the shared, target-based viewer, via
   * blob URLs). Everything else gets an honest toast — no pretending.
   */
  export let file: PutFile;

  const dispatch = createEventDispatcher();
  const remote = getRemote();

  type Phase = "loading" | "ready" | "error";
  let phase: Phase = "loading";
  let model: ZipModel | null = null;
  let path = ""; // "" = archive root, "sub/" below it
  let errorText = "";
  let gridEl: HTMLElement | null = null;

  $: rows = model ? archiveView(model.entries, path) : [];

  function open() {
    const au = currentAuth();
    if (!au) return;
    phase = "loading";
    openArchive(au, file)
      .then((m) => {
        model = m;
        phase = "ready";
      })
      .catch((err) => {
        // the ZipError's message IS the honest message (zip64 / encrypted /
        // not a zip) — a generic failure would be a lie
        errorText =
          err instanceof ZipError ? err.message : "This archive could not be read.";
        phase = "error";
      });
  }

  // the store is the round-trip memory: opening an image unmounts this
  // screen, and returning must restore the model AND the subfolder
  $: if (model) setArchive(file, model, path);

  function onBack() {
    const parent = archiveParentPath(path);
    if (parent !== path) path = parent; // inside a subfolder: pop one level
    else dispatch("back"); // archive root: leave (the App routes onward)
  }

  /* ---------------- rows ---------------- */
  function rowFile(row: ArchiveRow): PutFile {
    const full = path + row.name;
    return {
      id: -1,
      name: row.name,
      size: row.size,
      content_type: row.isDir ? "application/x-directory" : mimeFor(full),
      is_folder: row.isDir ? 1 : 0,
      parent_id: 0,
    };
  }

  function openRow(f: PutFile) {
    // ItemTile hands back the pseudo-file IT rendered (is_folder, name) —
    // not the ArchiveRow. The row model never crosses this boundary.
    if (putioIsFolder(f)) {
      path = path + f.name + "/";
      return;
    }
    const full = path + f.name;
    if (!isImageFile({ name: full })) {
      platform.toast("Only pictures can be opened from an archive yet");
      return;
    }
    openImagesInFolder(path, f.name);
  }

  /** Every decodable image in this archive folder becomes a viewer target
   *  whose load() extracts the entry and hands back a blob URL. */
  function openImagesInFolder(folderPath: string, pressed: string) {
    const au = currentAuth();
    if (!au || !model) return;
    const targets: ViewerTarget[] = model.entries
      .filter(
        (e) =>
          !e.isDir &&
          e.name.startsWith(folderPath) &&
          e.name.slice(folderPath.length).indexOf("/") === -1 &&
          isImageFile({ name: e.name })
      )
      .map((e) => ({
        name: e.name.slice(folderPath.length),
        size: e.size,
        load: () =>
          extractEntry(au, file, e).then(({ data, mime }) =>
            URL.createObjectURL(new Blob([data], { type: mime }))
          ),
      }));
    const initial = Math.max(0, targets.findIndex((t) => t.name === pressed));
    dispatch("open-image", { targets, initial });
  }

  /* ---------------- remote ---------------- */
  function onNavigate(_dir: Dir) {
    // tiles are spatial (the Remote moves focus between them)
  }

  function wire() {
    remote.setHandlers({
      onBack,
      onNavigate,
      onOK: () => remote.clickActive(),
    });
    const prev = get(archiveStore);
    if (prev.file && prev.file.id === file.id && prev.model) {
      model = prev.model;
      path = prev.path;
      phase = "ready"; // no second network read — the store is the memory
    } else {
      open();
    }
  }

  onMount(wire);
  onDestroy(() => remote.clearHandlers());
</script>

<div class="archive">
  <header class="head">
    <span class="title">📦 {file.name}</span>
    {#if path}
      <span class="subpath">{path}</span>
    {/if}
  </header>

  {#if phase === "loading"}
    <div class="center">
      <div class="spinner" role="status" aria-label="Opening archive"></div>
      <p class="muted">Reading the archive index…</p>
    </div>
  {:else if phase === "error"}
    <div class="center">
      <p class="big">This archive can’t be opened</p>
      <p class="muted">{errorText}</p>
      <button
        class="btn ghost"
        data-focus
        on:click={() => dispatch("back")}
      >Back to library</button>
    </div>
  {:else}
    {#if rows.length === 0}
      <p class="big-empty">This folder inside the archive is empty</p>
    {:else}
      <div class="grid" bind:this={gridEl}>
        {#each rows as row, i (path + row.name)}
          <ItemTile
            file={rowFile(row)}
            index={i}
            onOpen={openRow}
          />
        {/each}
      </div>
    {/if}
  {/if}
</div>

<style>
  .archive {
    position: absolute;
    top: 0;
    right: 0;
    bottom: 0;
    left: 0;
    display: flex;
    flex-direction: column;
    background: var(--bg);
    padding: 28px 36px 20px;
  }

  .head {
    display: flex;
    align-items: baseline;
    margin-bottom: 22px;
  }

  .title {
    font-size: var(--fs-h2);
    font-weight: 700;
    color: var(--text);
  }

  .subpath {
    margin-left: 16px;
    font-size: var(--fs-small);
    color: var(--text-3);
    font-variant-numeric: tabular-nums;
  }

  .center {
    flex: 1;
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
    margin: 0 0 24px;
  }

  .big-empty {
    color: var(--text-3);
    font-size: var(--fs-body);
  }

  .grid {
    flex: 1;
    overflow-y: auto;
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    align-content: start;
  }
</style>
