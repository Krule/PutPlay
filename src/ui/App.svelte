<script lang="ts">
  import { onMount } from "svelte";
  import { get } from "svelte/store";
  import { platform, isWebOSLike } from "../webos/platform";
  import { auth, loadAuth, type AuthState } from "../store/auth";
  import { nav, requestBackLevel, routeNav } from "../store/nav";
  import { library, resetLibrary } from "../store/library";
  import { loadConfig } from "../store/config";
  import { openArchive } from "../putio/zip-extract";
  import { buildComicModel, isComicZip } from "../putio/comic";
  import type { ZipModel } from "../putio/zip";
  import { clampResume } from "../putio/comic-progress";
  import { setComic, resetComic, loadShelf, progressFor, clearShelf, pageCache } from "../store/comic";
  import { clearThumbs } from "../store/thumb-store";
  import { isAudioFile, audioFamily } from "../putio/audio-capable";
  import { buildMusicQueue, buildVideoQueue } from "../putio/queue";
  import { streamURL } from "../putio/api";
  import {
    music,
    startMusic,
    stopMusic,
    toggleMusic,
    seekMusic,
    setExpanded,
    registerMusicElement,
    loadCaps,
    audioUnsupported,
  } from "../store/music";
  import { video, startVideoSession, setVideoMode, endVideoSession } from "../store/video";
  import NowPlaying from "./components/NowPlaying.svelte";

  const getLib = () => get(library);
  import type { PutFile } from "../putio/types";
  import Connect from "./screens/Connect.svelte";
  import Library from "./screens/Library.svelte";
  import Player from "./screens/Player.svelte";
  import Image from "./screens/Image.svelte";
  import Archive from "./screens/Archive.svelte";
  import Comic from "./screens/Comic.svelte";
  import Settings from "./screens/Settings.svelte";
  import { buildLibraryTargets, type ViewerTarget } from "../putio/image";
  import { resetArchive, setArchive } from "../store/archive";
  import { currentAuth } from "../store/auth";

  let a: AuthState;
  let screen: "connect" | "library" | "image" | "archive" | "comic" | "settings" = "connect";
  // the persistent (hidden) media element the music service owns — it lives
  // at the App shell so no screen unmount can ever stop the music
  let musicEl: HTMLVideoElement;
  let imageTargets: ViewerTarget[] = [];
  let imageInitial = 0;
  // where Back from the image lands: the library, or the archive it came from
  let imageReturn: "library" | "archive" = "library";
  let archiveFile: PutFile | null = null;
  let comicFile: PutFile | null = null;

  /* ---------------- back key ----------------
   * Primary path: remote.ts delivers the Back key (keydown 461; appinfo.json
   * disableBackHistoryAPI makes the platform pass it to us) to the active
   * screen's handler. Screens that own sub-levels (menus, overlays, folders)
   * consume it themselves; otherwise Player/Library dispatch a signal that
   * routes here. Fallback path: popstate (when the platform still drives
   * history) feeds the same handler. A short dedupe swallows the pair.
   */
  let lastBackAt = 0;
  let lastRootBackAt = 0;
  let suppressPop = 0;

  /**
   * Pop a history level WE pushed.
   * NOTE: the webOS platform drives `history.back()` itself (Back key →
   * history.back()), so the app never pops its own levels — doing so would
   * consume a level the user's next real Back press needs, and on the TV the
   * platform shows its exit prompt for that. pushBackLevel() therefore only
   * ever ADDS protection against the platform exiting on a Back press.
   */
  function historyBack() {
    // no-op by design on webOS; kept for a plain browser where the history is
    // ours to manage and popstate is the back channel.
    if (!isWebOSLike()) {
      if (history.length > 1) {
        suppressPop = Date.now() + 600;
        try { history.back(); } catch {}
      }
    }
  }

  function libraryAtRoot(): boolean {
    const s = getLib();
    return s && s.breadcrumbs.length <= 1;
  }

  function onGlobalBack() {
    const now = Date.now();
    if (now - lastBackAt < 500) return; // keydown + popstate pair
    lastBackAt = now;

    // the expanded now-playing panel is a sub-level: Back collapses it
    // (never stops the music — that is the close button's job)
    if (get(music)?.expanded) {
      setExpanded(false);
      return;
    }
    // the video session (plan §9.1): in FULL, Back docks to mini — it never
    // stops the media. Docked (mini/micro) the background screen owns Back,
    // so fall through to its routing below.
    const vs = get(video);
    if (vs && vs.mode === "full") {
      setVideoMode("mini");
      return;
    }
    if (screen === "image") {
      imageTargets = [];
      screen = imageReturn;
      return;
    }
    if (screen === "archive") {
      archiveFile = null;
      resetArchive();
      screen = "library";
      return;
    }
    if (screen === "comic") {
      comicFile = null;
      resetComic();
      screen = "library";
      return;
    }
    if (screen === "settings") {
      screen = "library";
      return;
    }
    if (screen === "connect") {
      platform.back();
      return;
    }
    // library
    if (libraryAtRoot()) {
      // double-press within 2s → official exit prompt; single press → hint
      if (now - lastRootBackAt < 2000) {
        lastRootBackAt = 0;
        platform.back();
      } else {
        lastRootBackAt = now;
        platform.toast("Press Back again to exit", 1800);
      }
    } else {
      requestBackLevel(); // Library subscribes and pops a folder level
    }
  }

  function onPopstate() {
    if (Date.now() < suppressPop) return; // we triggered this back ourselves
    onGlobalBack();
  }

  onMount(async () => {
    platform.init();
    platform.onBack(onGlobalBack);
    window.addEventListener("popstate", onPopstate);
    document.body.classList.add("app");
    platform.ensureBackLevel();
    registerMusicElement(musicEl);
    void loadCaps();

    // Transport keys drive the music while it runs (the remote hands them to
    // the active screen's handlers, which don't know about music — App does).
    // Inert whenever no session runs: video and music share one output, so a
    // Player-screen session can never be music.
    const onMusicKey = (e: Event) => {
      if (!get(music)) return;
      const code = (e as KeyboardEvent).keyCode as number;
      if (code === 415 || code === 19) toggleMusic();
      else if (code === 413) stopMusic();
      else if (code === 412) seekMusic(-15);
      else if (code === 417) seekMusic(15);
    };
    window.addEventListener("keydown", onMusicKey);

    a = get(auth);

    const unsubAuth = auth.subscribe((v) => {
      a = v;
      if (v.status === "authed" && screen === "connect") screen = "library";
      if (v.status === "unauthed" && screen !== "connect") {
        endVideoSession(); // …and the session's video (the Player unmounts and tears its engine down)
        imageTargets = [];
        archiveFile = null;
        resetArchive();
        comicFile = null;
        resetComic();
        clearShelf(); // the shelf is personal data; it goes with the session
        pageCache.clear(); // …and the cached page blobs are that account's book
        clearThumbs(); // …and the persisted cover thumbs are that account's art
        stopMusic(); // …and the session's music (the TV's caps record stays — it's the TV's, not the account's)
        // the store is module-level: without this, a fresh login would show
        // the previous account's folders (needsInitialList skips the fetch
        // when a cached listing exists)
        resetLibrary();
        screen = "connect";
      }
    });

    // EDGE-triggered routing through the tested routeNav decision: react to
    // counter increments (prev→next), never to the level being > 0 — the
    // counters are monotonic, so a level check re-fires forever and reverted
    // every Settings entry after the first round-trip (the .acct bug).
    let navSeen = get(nav);
    const unsubNav = nav.subscribe((v) => {
      const enteredSettings = v.navToSettings !== navSeen.navToSettings && screen === "library";
      screen = routeNav(navSeen, v, screen);
      if (enteredSettings) platform.pushBackLevel();
      navSeen = v;
    });

    const ok = await loadAuth();
    loadConfig().catch(() => undefined);
    loadShelf().catch(() => undefined);
    if (ok) screen = "library";
    else screen = "connect";

    return () => {
      unsubAuth();
      unsubNav();
      platform.offBack(onGlobalBack);
      window.removeEventListener("popstate", onPopstate);
      window.removeEventListener("keydown", onMusicKey);
    };
  });

  /** The folder's cover (cover.jpg/png/folder.jpg), if the listing has one. */
  function folderCover(files: PutFile[], auth: { oauthToken: string; downloadToken: string | null }): string | null {
    const cover = files.find((f) => /^(cover|folder)\.(jpe?g|png)$/i.test(f.name || ""));
    return cover ? streamURL(auth, cover.id) : null;
  }

  function onOpen(e: CustomEvent<{ file: PutFile }>) {
    const file = e.detail.file;
    // MUSIC is not a screen: it starts the persistent session and the user
    // stays where they are (folders, images and comics all keep working
    // under the now-playing strip). Video keeps the full-screen Player.
    if (isAudioFile(file)) {
      const fam = audioFamily(file);
      if (audioUnsupported(fam)) {
        // this TV vetoed the family on a real attempt — say so before the
        // user wastes a stream start
        platform.toast(`This TV can't play .${fam} files`);
        return;
      }
      const au = currentAuth();
      if (!au) return;
      endVideoSession(); // one engine, one output: music starts, the video session ends
      const q = buildMusicQueue(getLib().files, file);
      startMusic(file, q.queue, q.index, au, folderCover(getLib().files, au));
      return;
    }
    // one engine, one output: a video starts, the music stops
    stopMusic();
    // VIDEO is a session (plan §9.1): the Player renders from the session
    // store (full mode). The background screen stays where the user was —
    // Back from the full player docks, it does not leave.
    const q = buildVideoQueue(getLib().files, file);
    startVideoSession(file, q.queue, q.index);
    platform.pushBackLevel();
  }

  function onOpenImage(e: CustomEvent<{ file: PutFile }>) {
    // the folder's decodable images become the viewer's targets
    const au = currentAuth();
    if (!au) return;
    const targets = buildLibraryTargets(get(library).files, au);
    imageTargets = targets;
    imageInitial = Math.max(0, targets.findIndex((t) => t.name === e.detail.file.name));
    imageReturn = "library";
    screen = "image";
    platform.pushBackLevel();
  }

  async function onOpenArchive(e: CustomEvent<{ file: PutFile }>) {
    const file = e.detail.file;
    const au = currentAuth();
    if (!au) return;
    // The listing read (a 64KB EOCD window, plus the index when it is
    // bigger) is cheap — and the App pays for it, because the App decides
    // what the file IS: a book goes to the reader, a folder goes to the
    // browser. Both branches get the parsed model for free.
    let model: ZipModel;
    try {
      model = await openArchive(au, file);
    } catch (err) {
      // truncated / zip64 / encrypted / unreachable — the ZipError's message
      // is already the honest sentence; a network error gets one too
      const msg = err instanceof Error && err.message ? err.message : "Couldn’t read that archive";
      platform.toast(msg, 3200);
      return; // stay in the library — a refusal, not a freeze
    }
    if (isComicZip(model.entries)) {
      const book = buildComicModel(model.entries);
      const remembered = progressFor(file.id);
      // a per-comic choice beats the global Settings default; a remembered
      // page is clamped against the book as it is NOW (re-scans happen)
      // No Settings default (removed 2026-10-13): a never-flipped comic is
      // LTR; the per-comic flip lives in the reader (Up) and the progress store.
      const direction: "ltr" | "rtl" = remembered ? remembered.direction : "ltr";
      const index = remembered ? clampResume(remembered.page, book.pages.length) : 0;
      setComic(file, book, index, direction);
      comicFile = file;
      screen = "comic";
      platform.pushBackLevel();
    } else {
      setArchive(file, model, "");
      archiveFile = file;
      screen = "archive";
      platform.pushBackLevel();
    }
  }

  function onOpenArchiveImage(e: CustomEvent<{ targets: ViewerTarget[]; initial: number }>) {
    imageTargets = e.detail.targets;
    imageInitial = e.detail.initial;
    imageReturn = "archive"; // Back returns to the archive (folder intact — its store persists)
    screen = "image";
    platform.pushBackLevel();
  }

  function onImageBack() {
    imageTargets = [];
    screen = imageReturn;
  }

  function onArchiveBack() {
    archiveFile = null;
    resetArchive();
    screen = "library";
  }

  function onComicBack() {
    comicFile = null;
    resetComic();
    screen = "library";
  }

  function onSettingsBack() {
    screen = "library";
  }

  function onLibraryRoot() {
    // Library signalled "I'm at the root, no more levels"
    const now = Date.now();
    if (now - lastRootBackAt < 2000) {
      lastRootBackAt = 0;
      platform.back();
    } else {
      lastRootBackAt = now;
      platform.toast("Press Back again to exit", 1800);
    }
  }
</script>

<div class="app-shell">
  {#if screen === "connect"}
    <Connect state={auth} />
  {:else}
    <!-- the background screen. The full player covers it entirely; the
         docked player (mini/micro) overlays it in the corner while it keeps
         playing. Both are rendered from the session store, never from a
         "player" screen (plan §9.1). -->
    {#if !($video && $video.mode === "full")}
      {#if screen === "library"}
        <Library on:open={onOpen} on:open-image={onOpenImage} on:open-archive={onOpenArchive} on:root={onLibraryRoot} />
      {:else if screen === "archive" && archiveFile}
        <Archive file={archiveFile} on:open-image={onOpenArchiveImage} on:back={onArchiveBack} />
      {:else if screen === "comic" && comicFile}
        <Comic on:back={onComicBack} />
      {:else if screen === "image" && imageTargets.length}
        <Image targets={imageTargets} initial={imageInitial} on:back={onImageBack} />
      {:else if screen === "settings"}
        <Settings on:back={onSettingsBack} />
      {/if}
    {/if}
    {#if $video}
      <Player file={$video.file} mode={$video.mode} />
    {/if}
  {/if}

  {#if $music}
    <NowPlaying />
  {/if}
  <video class="music-el" bind:this={musicEl} aria-hidden="true"></video>
</div>

<style>
  .app-shell {
    position: absolute;
    top: 0;
    right: 0;
    bottom: 0;
    left: 0;
    overflow: hidden;
    background: var(--bg);
  }
  /* the music's media element: present in the render tree (the webOS
     pipeline wants it), invisible to the eye and the pointer. 1px rather
     than display:none — a display:none element can have its pipeline
     suspended by the webview. */
  .music-el {
    position: fixed;
    left: 0;
    bottom: 0;
    width: 1px;
    height: 1px;
    opacity: 0;
    pointer-events: none;
  }
</style>
