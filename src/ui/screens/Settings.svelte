<script lang="ts">
  import { onMount } from "svelte";
  import { get } from "svelte/store";
  import { auth, signOut } from "../../store/auth";
  import { requestLibrary } from "../../store/nav";
  import { fmtBytes } from "../../putio/api";

  let a: any;
  $: email = a?.accountEmail || "";
  $: name = a?.accountName || "";
  $: disk = a?.disk;
  $: subs = a?.subtitleLanguages || [];

  onMount(() => {
    a = get(auth);
    const unsub = auth.subscribe((v) => (a = v));
    const onKey = (e: KeyboardEvent) => {
      const code = (e as any).keyCode as number;
      if (code === 461 || code === 27 || e.key === "Escape") onBack();
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      unsub();
      window.removeEventListener("keydown", onKey, true);
    };
  });

  function onBack() {
    requestLibrary();
  }

  async function onSignOut() {
    if (confirm("Sign out? Your token will be removed from this TV.")) {
      await signOut();
    }
  }

  let signOutBtn: HTMLButtonElement;
</script>

<div class="settings">
  <header class="head">
    <h1 class="title">Account</h1>
  </header>

  <div class="body">
    <div class="card">
      <div class="avatar-row">
        <div class="avatar">{(name || "?").slice(0, 2).toUpperCase()}</div>
        <div>
          <p class="name">{name || "put.io account"}</p>
          {#if email}<p class="email">{email}</p>{/if}
        </div>
      </div>
      {#if disk}
        <div class="disk">
          <div class="disk-row"><span>Storage</span><span>{fmtBytes(disk.used)} / {fmtBytes(disk.size)}</span></div>
          <div class="disk-bar"><div class="disk-bar-fill" style="width: {Math.min(100, Math.round((disk.used / disk.size) * 100))}%"></div></div>
          <p class="free">{fmtBytes(disk.avail)} free</p>
        </div>
      {/if}
    </div>

    <div class="card">
      <p class="card-title">Subtitle languages</p>
      <p class="desc">
        {#if subs.length}
          Searched automatically when playing: <span class="acc">{subs.join(", ")}</span>
        {:else}
          None set.
        {/if}
      </p>
      <p class="note">
        Change these at <span class="acc">app.put.io → Settings → Show Subtitles</span>. The TV searches OpenSubtitles in
        the languages you pick there.
      </p>
    </div>

    <div class="card danger-zone">
      <p class="card-title">Session</p>
      <button class="btn danger" bind:this={signOutBtn} data-focus on:click={onSignOut}>Sign out</button>
    </div>
  </div>

  <div class="foot-hint">
    <span class="kbd">BACK</span> return to library
  </div>
</div>

<style>
  .settings {
    width: 1920px;
    height: 1080px;
    display: flex;
    flex-direction: column;
    padding: 48px 80px;
  }
  .title {
    font-size: var(--fs-h1);
    font-weight: 700;
    margin-bottom: 36px;
  }
  .body {
    display: flex;
    flex-direction: column;
    gap: 28px;
    max-width: 1100px;
  }
  .card {
    background: var(--bg-raised);
    border: 1px solid var(--line);
    border-radius: var(--r-lg);
    padding: 32px 36px;
  }
  .card-title {
    font-size: var(--fs-h3);
    font-weight: 700;
    margin-bottom: 12px;
  }
  .avatar-row {
    display: flex;
    align-items: center;
    gap: 24px;
    margin-bottom: 28px;
  }
  .avatar {
    width: 84px;
    height: 84px;
    border-radius: 50%;
    background: var(--accent-dim);
    color: var(--accent-2);
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: var(--fs-h2);
    font-weight: 800;
  }
  .name {
    font-size: var(--fs-h2);
    font-weight: 700;
  }
  .email {
    color: var(--text-2);
    margin-top: 4px;
  }
  .disk-row {
    display: flex;
    justify-content: space-between;
    color: var(--text-2);
    margin-bottom: 10px;
  }
  .disk-bar {
    height: 8px;
    border-radius: 4px;
    background: var(--surface-2);
    overflow: hidden;
  }
  .disk-bar-fill {
    height: 100%;
    background: var(--accent);
    border-radius: 4px;
  }
  .free {
    margin-top: 10px;
    color: var(--text-2);
    font-size: var(--fs-small);
  }
  .desc {
    color: var(--text-2);
    line-height: 1.6;
  }
  .note {
    margin-top: 14px;
    color: var(--text-3);
    font-size: var(--fs-small);
    line-height: 1.6;
  }
  .acc {
    color: var(--accent-2);
  }
  .danger-zone .btn {
    margin-top: 8px;
  }
  .foot-hint {
    margin-top: auto;
    color: var(--text-3);
  }
</style>
