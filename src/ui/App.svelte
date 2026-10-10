<script lang="ts">
  import { onMount } from "svelte";
  import { get } from "svelte/store";
  import { platform, isWebOSLike } from "../webos/platform";
  import { auth, loadAuth, type AuthState } from "../store/auth";
  import { nav, requestBackLevel, routeNav } from "../store/nav";
  import { library } from "../store/library";
  import { loadConfig } from "../store/config";

  const getLib = () => get(library);
  import type { PutFile } from "../putio/types";
  import Connect from "./screens/Connect.svelte";
  import Library from "./screens/Library.svelte";
  import Player from "./screens/Player.svelte";
  import Settings from "./screens/Settings.svelte";

  let a: AuthState;
  let screen: "connect" | "library" | "player" | "settings" = "connect";
  let playingFile: PutFile | null = null;

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

    if (screen === "player") {
      playingFile = null;
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

    a = get(auth);

    const unsubAuth = auth.subscribe((v) => {
      a = v;
      if (v.status === "authed" && screen === "connect") screen = "library";
      if (v.status === "unauthed" && screen !== "connect") {
        playingFile = null;
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
    if (ok) screen = "library";
    else screen = "connect";

    return () => {
      unsubAuth();
      unsubNav();
      platform.offBack(onGlobalBack);
      window.removeEventListener("popstate", onPopstate);
    };
  });

  function onOpen(e: CustomEvent<{ file: PutFile }>) {
    playingFile = e.detail.file;
    screen = "player";
    platform.pushBackLevel();
  }

  function onPlayerBack() {
    playingFile = null;
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
  {:else if screen === "library"}
    <Library on:open={onOpen} on:root={onLibraryRoot} />
  {:else if screen === "player" && playingFile}
    <Player file={playingFile} on:back={onPlayerBack} />
  {:else if screen === "settings"}
    <Settings on:back={onSettingsBack} />
  {/if}
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
</style>
