<script lang="ts">
  import { onMount } from "svelte";
  import { get } from "svelte/store";
  import { auth, signOut } from "../../store/auth";
  import { config, saveConfig, type ConfigState } from "../../store/config";
  import { requestLibrary } from "../../store/nav";
  import { getRemote } from "../../webos/remote";
  import { fmtBytes } from "../../putio/api";
  import { LANGUAGES } from "../../putio/languages";
  import LangPicker from "../components/LangPicker.svelte";

  import { BUILD_INFO } from "../build-info";

  const remote = getRemote();

  let a: any;
  $: email = a?.accountEmail || "";
  $: name = a?.accountName || "";
  $: disk = a?.disk;
  $: subs = a?.subtitleLanguages || [];

  // config page state
  let c: ConfigState = get(config);
  $: cfgSource = c?.source ?? "original";
  $: cfgAudio = c?.audioLang ?? "";
  $: cfgSub = c?.subtitleLang ?? "";
  $: cfgPlayNext = c?.playNext ?? true;
  // skip segments (intro / recap / credits): ONE switch — auto-skip at each
  // section's boundary (TheIntroDB times) or ask per section. The TMDb key
  // that resolves the title → show id is baked into the app (a TV has no
  // viable keyboard for it), so there is nothing else to configure.
  let cfgSkipSegs = true;

  const SOURCE_OPTIONS: { kind: ConfigState["source"]; label: string }[] = [
    { kind: "original", label: "Original" },
    { kind: "mp4", label: "put.io MP4" },
    { kind: "hls", label: "HLS" },
  ];

  let confirmSignOut = false;

  // language pickers (TV remotes can't type — dropdown, not text field)
  let langPicker: "audio" | "sub" | null = null;
  let audioFieldEl: HTMLButtonElement;
  let subFieldEl: HTMLButtonElement;

  const langLabel = (code: string): string => LANGUAGES.find((l) => l.code === code)?.label || "";
  const pickerOptions = (kind: "audio" | "sub") => [
    { value: "", label: kind === "audio" ? "First track (no preference)" : "None (no auto-select)" },
    ...LANGUAGES.map((l) => ({ value: l.code, label: l.label })),
  ];
  function pickLang(v: string): void {
    if (langPicker === "audio") cfgAudio = v;
    else if (langPicker === "sub") cfgSub = v;
    closeLangPicker();
  }
  function closeLangPicker(): void {
    const field = langPicker === "audio" ? audioFieldEl : subFieldEl;
    langPicker = null;
    // return the D-pad to the field that opened the picker
    if (field) requestAnimationFrame(() => remote.focusEl(field));
  }

  // ---------------- 5-way remote focus wiring ----------------
  // Chips, inputs and buttons carry data-focus in the markup, but the engine
  // only sees registered elements — without this the D-pad found zero
  // candidates on this screen (dead arrows, dead OK) while pointer clicks
  // worked. The root scan is idempotent per node, and re-runs when the
  // Sign-out → confirm swap recreates the button row.
  let settingsEl: HTMLDivElement;
  let signOutBtn: HTMLButtonElement;
  let confirmRowEl: HTMLDivElement;
  let confirmWasOpen = false;

  // base controls (chips, inputs, etc.): registered once — the bind ref
  // invalidates after the initial render commits, so the DOM is complete
  $: if (settingsEl) remote.registerAll(settingsEl);
  // the confirm row is committed to the DOM AFTER the reactive phase (Svelte
  // evaluates $: before template updates), so drive it from the bind ref:
  // register both buttons and focus the PRIMARY action — TV idiom: the remote
  // has no cancel key, Back is the cancel (see onBack)
  $: {
    if (confirmRowEl) {
      confirmWasOpen = true;
      remote.registerAll(confirmRowEl);
      const primary = confirmRowEl.querySelector<HTMLElement>(".btn.primary");
      if (primary) remote.focusEl(primary);
    }
  }
  // the Sign-out button is (re)created each time the confirm toggles — its
  // bind ref re-invalidates every time, post-commit: register the fresh node,
  // and when the confirm just closed, restore focus to it (the focused
  // confirm button is detached by then)
  $: {
    if (signOutBtn) {
      remote.register(signOutBtn);
      if (confirmWasOpen) {
        confirmWasOpen = false;
        const a = remote.activeEl;
        if (!a || !a.isConnected) remote.focusEl(signOutBtn);
      }
    }
  }

  // BUG 5: Settings owns Back through the same channel as every other screen
  // and clears it on unmount, so the stale Library handlers can't leak in.
  function onBack() {
    if (langPicker) {
      closeLangPicker();
      return;
    }
    if (confirmSignOut) {
      confirmSignOut = false;
      return;
    }
    persist();
    remote.blur();
    requestLibrary();
  }

  function persist() {
    // fold any edited value back into the store and persist it — SPREADING
    // the current config on purpose: keys this page no longer edits (the
    // player-owned subScale, last picked in the player) must survive a save
    // instead of being reset to defaults.
    if (c) {
      config.set({
        ...c,
        source: cfgSource,
        audioLang: cfgAudio,
        subtitleLang: cfgSub,
        playNext: cfgPlayNext,
        skipSegments: cfgSkipSegs,
      });
    }
    saveConfig().catch(() => undefined);
  }

  function onSignOut() {
    if (!confirmSignOut) {
      confirmSignOut = true;
      return;
    }
    confirmSignOut = false;
    signOut();
  }

  onMount(() => {
    a = get(auth);
    c = get(config);
    cfgSkipSegs = c?.skipSegments ?? true;
    const unsubAuth = auth.subscribe((v) => (a = v));
    const unsubCfg = config.subscribe((v) => (c = v));
    remote.setHandlers({ onBack, onOK: () => remote.clickActive() });
    requestAnimationFrame(() => remote.focusFirst());
    return () => {
      unsubAuth();
      unsubCfg();
      persist();
      remote.clearHandlers();
    };
  });
</script>

<div class="settings" bind:this={settingsEl}>
  <header class="head">
    <h1 class="title">Account</h1>
    <p class="sub">
      PutPlay — put.io for webOS{#if BUILD_INFO && BUILD_INFO.sha}<span class="stamp">{BUILD_INFO.version} · {BUILD_INFO.sha}{BUILD_INFO.dirty ? " (dirty)" : ""}</span>{/if}
    </p>
  </header>

  <div class="cols">
    <div class="col">
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
        {#if subs.length}
          <p class="note">put.io web-app languages: <span class="acc">{subs.join(", ")}</span> — these still drive the subtitle search.</p>
        {/if}
      </div>

      <div class="card">
        <p class="card-title">Playback</p>
        <p class="opt-label">Default video source</p>
        <div class="opt-row">
          {#each SOURCE_OPTIONS as o (o.kind)}
            <button class="chip" class:sel={cfgSource === o.kind} data-focus on:click={() => (cfgSource = o.kind)}>{o.label}</button>
          {/each}
        </div>
        <p class="opt-label">Play next in folder</p>
        <div class="opt-row">
          <button class="chip" class:sel={cfgPlayNext} data-focus on:click={() => (cfgPlayNext = true)}>On</button>
          <button class="chip" class:sel={!cfgPlayNext} data-focus on:click={() => (cfgPlayNext = false)}>Off</button>
        </div>
        <p class="note">When a video ends, the next video in the same folder starts automatically. Music always plays on through.</p>
      </div>

      <div class="card danger-zone">
        <p class="card-title">Session</p>
        {#if confirmSignOut}
          <div class="opt-row" bind:this={confirmRowEl}>
            <button class="btn primary" data-focus on:click={onSignOut}>Yes, sign out</button>
            <button class="btn ghost" data-focus on:click={() => (confirmSignOut = false)}>Cancel</button>
          </div>
          <p class="note">Your token will be removed from this TV.</p>
        {:else}
          <button class="btn danger" data-focus bind:this={signOutBtn} on:click={onSignOut}>Sign out</button>
        {/if}
      </div>
    </div>

    <div class="col">
      <div class="card">
        <p class="card-title">Preferred audio language</p>
        <button class="lang-field" bind:this={audioFieldEl} data-focus on:click={() => (langPicker = "audio")}>
          {#if cfgAudio}<span class="lf-value">{langLabel(cfgAudio) || cfgAudio}</span>{:else}<span class="lf-empty">First track (no preference)</span>{/if}
        </button>
        <p class="note">When a file has several audio tracks, the app picks the first one in this language.</p>
      </div>

      <div class="card">
        <p class="card-title">Preferred subtitle language</p>
        <button class="lang-field" bind:this={subFieldEl} data-focus on:click={() => (langPicker = "sub")}>
          {#if cfgSub}<span class="lf-value">{langLabel(cfgSub) || cfgSub}</span>{:else}<span class="lf-empty">None (no auto-select)</span>{/if}
        </button>
        <p class="note">Only subtitles in this language turn on automatically. OpenSubtitles finds are labelled.</p>
      </div>

      <div class="card">
        <p class="card-title">Skip intro, recap and credits</p>
        <div class="opt-row">
          <button class="chip" class:sel={cfgSkipSegs} data-focus on:click={() => (cfgSkipSegs = true)}>Auto-skip</button>
          <button class="chip" class:sel={!cfgSkipSegs} data-focus on:click={() => (cfgSkipSegs = false)}>Ask me</button>
        </div>
        <p class="note">
          Section times come from TheIntroDB (community data), matched to your file's episode
          automatically. No match or no data for a file: nothing is skipped. Auto-skip jumps
          each section as playback reaches it; Ask me asks, section by section. A resume
          always wins.
        </p>
      </div>
    </div>
  </div>

  <div class="foot-hint">
    <span class="kbd">BACK</span> return to library · changes save automatically
  </div>

  {#if langPicker}
    <LangPicker
      title={langPicker === "audio" ? "Preferred audio language" : "Preferred subtitle language"}
      options={pickerOptions(langPicker)}
      selected={langPicker === "audio" ? cfgAudio : cfgSub}
      on:pick={(e) => pickLang(e.detail)}
      on:close={closeLangPicker}
    />
  {/if}
</div>

<style>
  .settings {
    width: 1920px;
    height: 1080px;
    display: flex;
    flex-direction: column;
    padding: 48px 80px;
  }
  .head {
    display: flex;
    align-items: baseline;
    margin-bottom: 30px;
  }
  .head > :not(:first-child) {
    margin-left: 18px;
  }
  .title {
    font-size: var(--fs-h1);
    font-weight: 700;
  }
  .sub {
    color: var(--text-3);
    font-size: var(--fs-h3);
  }
  .stamp {
    margin-left: 14px;
    font-variant-numeric: tabular-nums;
    letter-spacing: 0.02em;
  }
  .cols {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 28px;
    flex: 1;
    min-height: 0;
  }
  .col {
    display: flex;
    flex-direction: column;
    min-height: 0;
    /* scrollable, like the Library grid: the columns are at capacity, so a
       card past the fold must scroll into view as the D-pad reaches it
       (the remote engine's focus-time scrollIntoView) — a clipped card is
       unreachable, and a card the user can't reach does not exist.
       clip-x: the scaled focus target must never grow x-overflow (it
       summons a bottom scrollbar), vertical scrolling is untouched. */
    overflow-y: auto;
    overflow-x: hidden;
    scrollbar-width: thin;
    scrollbar-color: var(--surface-3) transparent;
  }
  .col::-webkit-scrollbar {
    width: 10px;
  }
  .col::-webkit-scrollbar-thumb {
    background: var(--surface-3);
    border-radius: 5px;
  }
  .col > :not(:first-child) {
    margin-top: 28px;
  }
  .card {
    background: var(--bg-raised);
    border: 1px solid var(--line);
    border-radius: var(--r-lg);
    padding: 28px 32px;
  }
  .card-title {
    font-size: var(--fs-h3);
    font-weight: 700;
    margin-bottom: 14px;
  }
  .avatar-row {
    display: flex;
    align-items: center;
    margin-bottom: 24px;
  }
  .avatar-row > :not(:first-child) {
    margin-left: 24px;
  }
  .avatar {
    width: 84px;
    height: 84px;
    border-radius: 50%;
    background: var(--accent-dim-solid);
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
  .opt-label {
    color: var(--text-2);
    font-size: var(--fs-body);
    margin-bottom: 12px;
  }
  .opt-row {
    display: flex;
    flex-wrap: wrap;
    margin: -7px;
  }
  .opt-row > * {
    margin: 7px;
  }
  .chip {
    padding: 12px 22px;
    border-radius: 999px;
    border: 2px solid var(--line-strong);
    background: var(--surface);
    color: var(--text-2);
    font-size: var(--fs-body);
    cursor: pointer;
  }
  .chip.sel {
    border-color: var(--accent);
    background: var(--accent-dim-solid);
    color: var(--accent-2);
    font-weight: 700;
  }
  .lang-field {
    width: 100%;
    box-sizing: border-box;
    padding: 14px 18px;
    font-size: var(--fs-body);
    border-radius: var(--r-md);
    background: var(--surface);
    border: 2px solid var(--line-strong);
    color: var(--text);
    text-align: left;
    cursor: pointer;
  }
  .lang-field[data-state="active"] {
    border-color: var(--accent);
    background: var(--surface-2);
  }
  .lang-field .lf-empty {
    color: var(--text-3);
  }
  .note {
    margin-top: 12px;
    color: var(--text-3);
    font-size: var(--fs-small);
    line-height: 1.55;
  }
  .acc {
    color: var(--accent-2);
  }
  .danger-zone .btn {
    margin-top: 4px;
  }
  .foot-hint {
    margin-top: 24px;
    color: var(--text-3);
  }
</style>
