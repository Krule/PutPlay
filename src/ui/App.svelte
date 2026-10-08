<script lang="ts">
  import { onMount } from "svelte";
  import { get } from "svelte/store";
  import { platform } from "../webos/platform";
  import { auth, loadAuth, type AuthState } from "../store/auth";
  import { nav, requestBackLevel } from "../store/nav";
  import type { PutFile } from "../putio/types";
  import Connect from "./screens/Connect.svelte";
  import Library from "./screens/Library.svelte";
  import Player from "./screens/Player.svelte";
  import Settings from "./screens/Settings.svelte";

  let a: AuthState;
  let screen: "connect" | "library" | "player" | "settings" = "connect";
  let playingFile: PutFile | null = null;

  function onGlobalBack() {
    if (screen === "player") {
      playingFile = null;
      screen = "library";
    } else if (screen === "settings") {
      screen = "library";
    } else if (screen === "connect") {
      platform.quit();
    } else if (screen === "library") {
      requestBackLevel(); // Library subscribes and pops a folder level
    }
  }

  onMount(async () => {
    platform.init();
    platform.onBack(onGlobalBack);
    document.body.classList.add("app");

    a = get(auth);

    const unsubAuth = auth.subscribe((v) => {
      a = v;
      if (v.status === "authed" && screen === "connect") screen = "library";
      if (v.status === "unauthed" && screen !== "connect") {
        playingFile = null;
        screen = "connect";
      }
    });

    const unsubNav = nav.subscribe((v) => {
      if (v.navToSettings > 0 && screen === "library") screen = "settings";
      if (v.navToLibrary > 0 && screen === "settings") screen = "library";
    });

    const ok = await loadAuth();
    if (ok) screen = "library";
    else screen = "connect";

    return () => {
      unsubAuth();
      unsubNav();
      platform.offBack(onGlobalBack);
    };
  });

  function onOpen(e: CustomEvent<{ file: PutFile }>) {
    playingFile = e.detail.file;
    screen = "player";
  }
</script>

<div class="app-shell">
  {#if screen === "connect"}
    <Connect state={auth} />
  {:else if screen === "library"}
    <Library on:open={onOpen} />
  {:else if screen === "player" && playingFile}
    <Player file={playingFile} on:back={() => { playingFile = null; screen = "library"; }} />
  {:else if screen === "settings"}
    <Settings on:back={() => (screen = "library")} />
  {/if}
</div>

<style>
  .app-shell {
    position: absolute;
    inset: 0;
    overflow: hidden;
    background: var(--bg);
  }
</style>
