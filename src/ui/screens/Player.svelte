<script lang="ts">
  import { onMount, onDestroy, createEventDispatcher } from "svelte";
  import { get } from "svelte/store";
  import { getRemote } from "../../webos/remote";
  import { platform } from "../../webos/platform";
  import { currentAuth, auth } from "../../store/auth";
  import {
    MediaEngine,
    type SourceKind,
    type AudioTrackInfo,
  } from "../../putio/media";
  import type { SubtitleTrackInfo } from "../../putio/media";
  import { fmtTime, fmtBytes } from "../../putio/api";
  import {
    loadSubtitle,
    cueAt,
    subtitleSourceLabel,
    orderSubtitleSources,
    pickSubtitleDefault,
    type LoadedSubtitle,
    type SubtitleCue,
  } from "../../putio/subs";
  import type { SubtitleInfo } from "../../putio/types";
  import { shouldShowResumePrompt, initialSeekTarget } from "../../putio/resume";
  import { clickIsOutsideClickTarget } from "../../putio/overlay";
  import { progressPct } from "../../putio/progress";
  import { playerOkAction } from "../../putio/player-ok";
  import { pickerDefaultIndex, rowFocusState } from "../../putio/picker-default";
  import { config, pickAudioTrack, pickSubtitleTrack } from "../../store/config";

  export let file: {
    id: number;
    name: string;
    is_folder?: boolean;
    is_mp4_available?: boolean;
    start_from?: number;
    size?: number;
  };

  const dispatch = createEventDispatcher();
  const remote = getRemote();

  let videoEl: HTMLVideoElement;
  let engine: MediaEngine | null = null;

  let a: any = get(auth);
  $: subtitleLanguages = a?.subtitleLanguages || [];

  let cfg: any = get(config);
  let cfgSub: (() => void) | null = null;
  $: subScale = cfg?.subScale || 1;
  $: preferredAudioLang = cfg?.audioLang || "";
  $: preferredSubLang = cfg?.subtitleLang || "";

  // --- ui state
  let source: SourceKind = "original";
  let duration = 0;
  let currentTime = 0;
  let paused = true;
  let buffering = false;
  let error: string | null = null;
  let audioTracks: AudioTrackInfo[] = [];
  let audioTrack = 0;
  let hlsSubTracks: SubtitleTrackInfo[] = [];
  let live = false;

  let overlays: { audio: boolean; subs: boolean; source: boolean } = {
    audio: false,
    subs: false,
    source: false,
  };
  let showControls = true;
  let hideTimer: number | null = null;

  let subtitles: LoadedSubtitle[] = [];
  let activeSub = -1; // -1 = off, 0.. = index into put.io subtitles (progressive overlay)
  let hlsSub = -1; // -1 = off, index into hls textTracks (MKV-embedded renditions)
  let subCues: SubtitleCue[] = [];
  let subText = "";

  let sourceOptions = [
    { kind: "original" as SourceKind, label: "Original", available: true, hint: "" },
    { kind: "mp4" as SourceKind, label: "put.io MP4", available: false, hint: "" },
    { kind: "hls" as SourceKind, label: "HLS", available: true, hint: "" },
  ];

  let resumePrompt: { from: number } | null = null;
  let confirmLeave = false;
  let resumePending = false; // prompt shown: engine must not auto-apply

  // ---------------- engine wiring ----------------

  function initEngine() {
    const au = currentAuth();
    if (!au || !videoEl) return;
    cfg = get(config);
    // does the user's preferred source have the file in a state to use?
    const prefSource = cfg?.source === "mp4" ? (file.is_mp4_available ? "mp4" : "original") : cfg?.source || "original";
    engine = new MediaEngine(videoEl, file as any, au, {
      onState: (p) => {
        if (p.source !== undefined) source = p.source;
        if (p.duration !== undefined && p.duration !== Infinity) duration = p.duration;
        if (p.currentTime !== undefined) currentTime = p.currentTime;
        if (p.paused !== undefined) paused = p.paused;
        if (p.buffering !== undefined) buffering = p.buffering;
        if (p.error !== undefined) error = p.error;
        if (p.audioTracks !== undefined) {
          audioTracks = p.audioTracks;
          // FEATURE: honor the preferred audio language on (re)load
          const i = pickAudioTrack(audioTracks, preferredAudioLang);
          if (i >= 0 && i < audioTracks.length) engine?.setAudioTrack(i);
        }
        if (p.audioTrack !== undefined) audioTrack = p.audioTrack;
        if (p.subtitleTracks !== undefined) hlsSubTracks = p.subtitleTracks;
        if (p.live !== undefined) live = p.live;
      },
      onSourceChange: (s) => {
        source = s;
        overlays.source = true;
        showControls = true;
        // a source swap drops the previous source's tracks — reset subtitle selection
        activeSub = -1;
        hlsSub = -1;
        subCues = [];
        subText = "";
        if (s !== "hls") ensureSubtitles();
      },
      onEnded: () => {
        showControls = true;
        platform.toast("Finished — press Back to return to your library");
      },
      // BUG 1: if we'll show the resume prompt, the engine must NOT auto-seek
      suppressAutoResume: file.start_from > 30,
    });

    sourceOptions = engine.sourceOptions().map((o) => ({ ...o }));
    engine.setSource(prefSource, undefined, true); // silent: don't pop the source overlay on entry
  }

  function onBack() {
    if (resumePrompt) {
      resumePrompt = null;
      engine?.play(); // dismissing the prompt = "just play" (scrim-click parity)
      return;
    }
    if (overlays.audio || overlays.subs || overlays.source) {
      overlays.audio = false;
      overlays.subs = false;
      overlays.source = false;
      return;
    }
    if (confirmLeave) {
      confirmLeave = false;
      engine?.saveResume();
      dispatch("back");
      return;
    }
    confirmLeave = true;
    wake();
  }

  function stayInPlayback() {
    confirmLeave = false;
    engine?.play().catch(() => undefined);
    wake();
  }

  /** Explicit "Yes" from the leave-confirmation dialog — always leaves. */
  function leavePlayback() {
    confirmLeave = false;
    engine?.saveResume();
    dispatch("back");
  }

  function onColor(c: "blue" | "green" | "red" | "yellow") {
    if (c === "blue") engine?.togglePlayPause();
    if (c === "green") overlays.source = !overlays.source;
    if (c === "yellow") overlays.audio = !overlays.audio;
    if (c === "red") { overlays.subs = !overlays.subs; }
    wake();
  }

  function onPlayPause() {
    engine?.togglePlayPause();
    wake();
  }
  function onFastForward() {
    engine?.skip(30);
    wake();
  }
  function onRewind() {
    engine?.skip(-10);
    wake();
  }
  function onStop() {
    dispatch("back");
  }

  function wake() {
    showControls = true;
    if (hideTimer) clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      if (!paused && !error && !overlays.audio && !overlays.subs && !overlays.source) {
        showControls = false;
      }
    }, 4000);
  }

  // ---------------- subtitles ----------------

  let subsLoading = false;

  async function ensureSubtitles() {
    if (subtitles.length || subsLoading) return;
    const au = currentAuth();
    if (!au) return;
    subsLoading = true;
    try {
      const { getSubtitles } = await import("../../putio/api");
      const res = await getSubtitles(au, file.id, subtitleLanguages);
      // MKV-embedded tracks first — they belong to the video; OpenSubtitles
      // suggestions last. Auto-select below scans in this order.
      for (const sub of orderSubtitleSources(res.subtitles || [])) {
        const src = await loadSubtitle(sub.url, sub.format);
        subtitles.push({
          id: sub.key,
          language: sub.language,
          languageCode: sub.language_code,
          name: sub.name,
          url: sub.url,
          format: sub.format,
          source: sub.source,
          blobURL: src?.blobURL,
          cues: src?.cues || [],
        });
      }
      // BUG 4: only auto-select a track the user actually asked for (their
      // configured preferred subtitle language, else the put.io web settings).
      // Never guess an arbitrary OpenSubtitles suggestion in another language.
      if (activeSub === -1) {
        const i = preferredSubLang
          ? pickSubtitleTrack(subtitles, preferredSubLang)
          : pickSubtitleDefault(subtitles, subtitleLanguages);
        if (i >= 0) selectSubTrack(i);
      }
    } catch (e: any) {
      platform.toast("Couldn't load subtitles");
    }
    subsLoading = false;
  }

  function selectSubTrack(i: number) {
    if (source === "hls") {
      // MKV-embedded WebVTT renditions live on the video element's textTracks;
      // hls.js renders them natively (that's why HLS subs already worked).
      selectHlsSub(i);
      activeSub = -1;
      subCues = [];
      subText = "";
      return;
    }
    activeSub = i;
    hlsSub = -1;
    subCues = subtitles[i] ? subtitles[i].cues || [] : [];
  }

  function selectHlsSub(i: number) {
    const t = (engine?.video as any);
    const tt = t && t.textTracks;
    if (tt) {
      for (let k = 0; k < tt.length; k++) {
        try {
          tt[k].mode = k === i ? "showing" : "disabled";
        } catch {}
      }
    }
    hlsSub = i;
  }

  // turn whichever subtitle family is currently shown off
  function disableActiveSubs() {
    if (source === "hls") selectHlsSub(-1);
    else {
      activeSub = -1;
      subCues = [];
      subText = "";
    }
  }

  // The overlay text follows the active cue. This MUST be a reactive statement
  // (not a bare function call): Svelte 4 only tracks values the statement
  // itself reads, so `updateSubText()` as a statement never re-ran when
  // currentTime changed and the overlay never synced.
  $: {
    if (activeSub === -1 || !subCues.length) subText = "";
    else {
      const c = cueAt(subCues, currentTime);
      subText = c ? c.text : "";
    }
  }

  function onSubPick(i: number) {
    if (source === "hls") {
      if (i < 0 || hlsSub === i) {
        selectHlsSub(-1);
        platform.toast("Subtitles off");
      } else {
        selectHlsSub(i);
        platform.toast(`Subtitles: ${hlsSubTracks[i]?.label || "track " + i}`);
      }
      return;
    }
    if (i < 0 || activeSub === i) {
      activeSub = -1;
      subCues = [];
      platform.toast("Subtitles off");
    } else {
      selectSubTrack(i);
      if (subtitles[i]) platform.toast(`Subtitles: ${subtitles[i].language}`);
    }
  }

  function onAudioPick(i: number) {
    engine?.setAudioTrack(i);
    if (audioTracks[i]) platform.toast(`Audio: ${audioTracks[i].label}`);
  }

  function onSourcePick(kind: SourceKind) {
    if (kind === source) return;
    const t = engine?.video.currentTime || 0;
    engine?.setSource(kind, t);
    platform.toast(`Source: ${kind === "original" ? "original file" : kind === "mp4" ? "put.io MP4" : "HLS"}`);
  }

  // ---------------- lifecycle ----------------

  let unsub: (() => void) | null = null;

  const kick = () => {
    const v = videoEl as HTMLVideoElement | undefined;
    if (!v) return;
    if (!v.paused && v.readyState >= 2) {
      // force a repaint of the layer: nudge currentTime a hair and re-play
      try { v.currentTime = v.currentTime; } catch {}
      v.play().catch(() => undefined);
    }
  };
  const onVis = () => { if (!document.hidden) kick(); };

  onMount(() => {
    document.body.classList.add("player-mode");
    window.addEventListener("focus", kick);
    document.addEventListener("visibilitychange", onVis);
    unsub = auth.subscribe((v) => (a = v));
    a = get(auth);

    initEngine();

    // keep config-derived values live (the store loads asynchronously)
    cfgSub = config.subscribe((v) => (cfg = v));

    // resume from put.io? (BUG 1: the prompt is ours — the engine was built
    // with suppressAutoResume so it can't race the user's choice; the choice
    // lands through applyInitialSeek, which defers 0-seeks to metadata)
    if (file.start_from && file.start_from > 30) {
      resumePrompt = { from: file.start_from };
      resumePending = true;
    }

    remote.setHandlers({
      onBack,
      onColor,
      onPlayPause,
      onFastForward,
      onRewind,
      onStop,
      onNavigate: () => wake(),
      onOK: () => {
        // Same contract as the Library: a spatially focused control wins
        // (cbtns, pick-rows, panel buttons); only with nothing focused does
        // OK do the screen default — toggle play/pause.
        const a = remote.activeEl;
        const action = playerOkAction(!!a && a.isConnected);
        if (action === "activate-focused") {
          remote.clickActive();
        } else {
          engine?.togglePlayPause();
          wake();
        }
      },
    });

    ensureSubtitles();

  });

  function resume() {
    if (resumePrompt && engine) {
      // BUG 1: apply the user's choice through the engine's tested seek path
      // (it locks out auto-resume and defers 0-seeks to metadata).
      const t = initialSeekTarget(resumePrompt.from, "resume", {
        currentTime: engine.video.currentTime || 0,
        duration: duration || 0,
      });
      engine.applyInitialSeek(t.time);
      engine.play();
    }
    resumePrompt = null;
    resumePending = false;
  }
  function skipResume() {
    if (engine) engine.applyInitialSeek(0); // the engine waits for metadata itself
    resumePrompt = null;
    resumePending = false;
    engine?.play();
  }

  onDestroy(() => {
    document.body.classList.remove("player-mode");
    window.removeEventListener("focus", kick);
    document.removeEventListener("visibilitychange", onVis);
    unsub?.();
    cfgSub?.();
    remote.clearHandlers();
    if (hideTimer) clearTimeout(hideTimer);
    engine?.destroy();
    engine = null;
    for (const s of subtitles) if (s.blobURL) URL.revokeObjectURL(s.blobURL);
    subtitles = [];
  });

  // progress bar interaction (remote: left/right while focused scrubs)
  function onScrubKey(e: KeyboardEvent) {
    const code = (e as any).keyCode as number;
    if (code === 37 || code === 39) {
      const d = (code === 39 ? 10 : -10);
      if (engine) engine.skip(d);
      wake();
    }
  }

  function rebuildTracks() {
    const v = videoEl;
    if (!engine || !v) return;
    // Progressive (original/mp4): the webview's <track src> is unreliable, so
    // subtitles render via the DOM overlay (subCues) instead. For HLS, hls.js
    // muxes WebVTT renditions through MSE and they surface on v.textTracks —
    // selectSubTrack drives their mode.
    const existing = v.querySelectorAll("track");
    existing.forEach((t) => t.remove());
    if (source === "hls") return;
  }
  $: rebuildTracks();

  $: subList = subtitles.map((s) => s.language).join(", ");
  const bufEnd = 0; // not computed; we show a simple buffered bar via engine state later if needed


  // FEATURE: subtitle overlay scale from the config (1 = default 30px)
  $: subFontSize = Math.round(30 * (subScale || 1));

  // BUG 4: put.io returns OpenSubtitles *suggestions*; label them as such
  function subLabel(s: LoadedSubtitle): string {
    const src = subtitleSourceLabel(s.source);
    return src ? `${s.language} (${src})` : s.language;
  }

  // Tracked reactive value: Svelte re-applies the width every time the
  // currentTime/duration pair changes. (Binding a bare function call here
  // would freeze the bar at its mount-time value.)
  $: barPct = progressPct(currentTime, duration);

  let barEl: HTMLDivElement;
  // modal panels (BUG 2: side-click dismiss needs the panel rect)
  let errPanelEl: HTMLDivElement;
  let sourcePanelEl: HTMLDivElement;
  let audioPanelEl: HTMLDivElement;
  let subsPanelEl: HTMLDivElement;
  let resumePanelEl: HTMLDivElement;
  let leavePanelEl: HTMLDivElement;
  function onBarClick(e: MouseEvent) {
    if (!barEl || !duration) return;
    const r = barEl.getBoundingClientRect();
    const f = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    engine?.seek(f * duration);
  }

  // BUG 2: clicking the dim area around any modal dismisses it with no action.
  // Panels stopPropagation, so a click that lands here is genuinely outside.
  function onPanelScrimClick(e: MouseEvent, panelEl: HTMLElement | null) {
    if (!clickIsOutsideClickTarget(e, panelEl)) return;
    const leaving = !!(resumePrompt || confirmLeave);
    overlays.audio = false;
    overlays.subs = false;
    overlays.source = false;
    if (resumePrompt) {
      resumePrompt = null;
      engine?.play(); // dismissing the resume prompt = "just play"
    }
    if (leaving) {
      engine?.saveResume();
    }
  }

  // ---------------- 5-way remote focus wiring ----------------
  // Every interactive control in this screen carries data-focus in the markup,
  // but the engine only sees elements handed to it — without this wiring the
  // D-pad found zero candidates here (dead arrows, dead OK) while pointer
  // clicks worked. Surfaces inside {#if} recreate their DOM on each open, so
  // each is re-scanned whenever it exists (registerAll is idempotent per node;
  // the engine garbage-collects detached nodes in candidates()).

  let controlsEl: HTMLDivElement;
  let baseFocusDone = false;

  function ctlEl(name: string): HTMLElement | null {
    return controlsEl
      ? (controlsEl.querySelector(`[data-ctl="${name}"]`) as HTMLElement | null)
      : null;
  }
  function focusInPanel(root: HTMLElement): boolean {
    const a = remote.activeEl;
    return !!a && root.contains(a);
  }
  /** Re-focus a control when the current focus is gone (stale/detached). */
  function restoreIfStale(target: HTMLElement | null): void {
    const a = remote.activeEl;
    if (!target || (a && a.isConnected)) return;
    remote.focusEl(target);
  }
  /** Focus the natural row of a freshly opened pick panel (selected first). */
  function focusDefaultRow(root: HTMLElement | undefined, rows: HTMLElement[]): void {
    if (!root || !rows.length || focusInPanel(root)) return;
    const idx = pickerDefaultIndex(rows.map((r) => rowFocusState(r)));
    if (idx >= 0) remote.focusEl(rows[idx]);
  }

  // Each panel's bind:this ref is the post-commit signal: it is set when the
  // panel is created and cleared (undefined) when it is removed — both AFTER
  // the DOM swap, which is when restoreIfStale can see the old buttons as
  // detached. (A restore driven by the overlay STATE flags runs in the
  // reactive phase, before the removal commits, and sees them still attached.)
  $: {
    if (controlsEl && !baseFocusDone) {
      baseFocusDone = true;
      remote.registerAll(controlsEl);
      if (!resumePrompt) restoreIfStale(ctlEl("play"));
    }
  }

  const wasOpen = { source: false, audio: false, subs: false, resume: false, leave: false, err: false };

  // pick overlays: focus the selected row so OK re-confirms and arrows explore;
  // when the panel closes, restore focus to the overlay's cbtn
  $: {
    if (sourcePanelEl) {
      focusDefaultRow(sourcePanelEl, remote.registerAll(sourcePanelEl));
    } else if (wasOpen.source) {
      restoreIfStale(ctlEl("source"));
    }
    wasOpen.source = !!sourcePanelEl;
  }
  $: {
    if (audioPanelEl) {
      focusDefaultRow(audioPanelEl, remote.registerAll(audioPanelEl));
    } else if (wasOpen.audio) {
      restoreIfStale(ctlEl("audio"));
    }
    wasOpen.audio = !!audioPanelEl;
  }
  $: {
    if (subsPanelEl) {
      focusDefaultRow(subsPanelEl, remote.registerAll(subsPanelEl));
    } else if (wasOpen.subs) {
      restoreIfStale(ctlEl("subs"));
    }
    wasOpen.subs = !!subsPanelEl;
  }
  // track lists can change or arrive while a panel is open — the new rows are
  // committed to the DOM after this flush's reactive phase, so re-scan on the
  // next frame (registerAll is idempotent; the engine GCs the old rows)
  $: if (audioPanelEl && audioTracks.length) requestAnimationFrame(() => remote.registerAll(audioPanelEl));
  $: if (subsPanelEl && subtitles.length) requestAnimationFrame(() => remote.registerAll(subsPanelEl));

  // D-pad focus trap: while any panel is open, arrows stay inside the
  // topmost one (later template branch = higher z); null restores the
  // control bar. Reads the bind refs, so it re-runs post-commit on open/close.
  $: remote.setFocusScope(
    leavePanelEl || resumePanelEl || subsPanelEl || audioPanelEl || sourcePanelEl || errPanelEl || null
  );

  // modals: focus the natural action — Resume (primary), "No, keep playing"
  // (the safe default of the double-Back guard — Back is already the leave
  // path), Retry; closing any of them restores focus to play
  $: {
    if (resumePanelEl) {
      const btns = remote.registerAll(resumePanelEl);
      if (btns.length && !focusInPanel(resumePanelEl)) remote.focusEl(btns[0]);
    } else if (wasOpen.resume) {
      restoreIfStale(ctlEl("play"));
    }
    wasOpen.resume = !!resumePanelEl;
  }
  $: {
    if (leavePanelEl) {
      const btns = remote.registerAll(leavePanelEl);
      if (btns.length && !focusInPanel(leavePanelEl)) remote.focusEl(btns[btns.length > 1 ? 1 : 0]);
    } else if (wasOpen.leave) {
      restoreIfStale(ctlEl("play"));
    }
    wasOpen.leave = !!leavePanelEl;
  }
  $: {
    if (errPanelEl) {
      const btns = remote.registerAll(errPanelEl);
      if (btns.length && !focusInPanel(errPanelEl)) remote.focusEl(btns[0]);
    } else if (wasOpen.err) {
      restoreIfStale(ctlEl("play"));
    }
    wasOpen.err = !!errPanelEl;
  }
</script>

<div class="player">
  <video
    bind:this={videoEl}
    class="video"
    class:active={engine}
    playsinline
    preload="auto"
    on:click={() => {
      engine?.togglePlayPause();
      wake();
    }}
    on:keydown={onScrubKey}
  ></video>


  {#if activeSub >= 0 && source !== "hls" && subText}
    <div class="subs" class:show={!!subText} style="font-size:{subFontSize}px">{subText}</div>
  {/if}

  <!-- ================= bottom control bar ================= -->
  <div class="controls" bind:this={controlsEl} class:visible={showControls || paused || !!error || overlays.audio || overlays.subs || overlays.source} class:dim={paused ? "" : "dim"}>
    <div class="title-line">
      <h1 class="title">{file.name}</h1>
      {#if live}<span class="badge accent">LIVE</span>{/if}
      {#if source === "mp4"}<span class="badge">MP4</span>{/if}
      {#if source === "hls"}<span class="badge">HLS</span>{/if}
    </div>

    <div class="progress-row">
      <span class="time">{fmtTime(currentTime)}</span>
      <div class="bar" bind:this={barEl} on:click={onBarClick}>
        <div class="bar-track">
          <div class="bar-fill" style="width: {barPct}%"></div>
        </div>
      </div>
      <span class="time">{live ? "" : fmtTime(duration)}</span>
    </div>

    <div class="button-row">
      <button class="cbtn" data-focus data-ctl="rewind" on:click={() => { engine?.skip(-10); wake(); }}>
        <span class="ico">«10</span>
      </button>
      <button class="cbtn play" data-focus data-ctl="play" on:click={() => { engine?.togglePlayPause(); wake(); }}>
        <span class="ico">{paused ? "▶" : "❚❚"}</span>
      </button>
      <button class="cbtn" data-focus data-ctl="forward" on:click={() => { engine?.skip(30); wake(); }}>
        <span class="ico">30»</span>
      </button>

      <span class="spacer"></span>

      <button class="cbtn text" data-focus data-ctl="source" on:click={() => (overlays.source = !overlays.source)} class:sel={overlays.source}>
        Source <span class="sub">{source === "original" ? "original" : source}</span>
      </button>
      <button class="cbtn text" data-focus data-ctl="audio" on:click={() => (overlays.audio = !overlays.audio)} class:sel={overlays.audio}>
        Audio <span class="sub">{audioTracks.length ? audioTracks[audioTrack]?.label || audioTracks[0]?.label : "—"}</span>
      </button>
      <button class="cbtn text" data-focus data-ctl="subs" on:click={() => { overlays.subs = !overlays.subs; ensureSubtitles(); }} class:sel={overlays.subs}>
        Subtitles <span class="sub">{source === "hls" ? (hlsSub === -1 ? "off" : hlsSubTracks[hlsSub]?.label || "on") : (activeSub === -1 ? "off" : subtitles[activeSub]?.language || "off")}</span>
      </button>
      <button class="cbtn text" data-focus data-ctl="fullscreen" on:click={() => { if (videoEl) platform.toggleFullscreen(videoEl); }}>
        Fullscreen
      </button>
    </div>
  </div>

  <!-- ================= overlays ================= -->

  {#if error}
    <div class="center-panel" on:click={(e) => onPanelScrimClick(e, errPanelEl)}>
      <div class="panel err-panel" bind:this={errPanelEl} on:click={(e) => e.stopPropagation()}>
        <p class="err-title">Playback problem</p>
        <p class="muted">{error}</p>
        <div class="row" style="margin-top: 20px">
          <button class="btn primary" data-focus on:click={() => { error = null; engine?.setSource(source); }}>
            Retry
          </button>
          <button class="btn ghost" data-focus on:click={() => dispatch("back")}>Back to library</button>
        </div>
      </div>
    </div>
  {/if}

  {#if overlays.source}
    <div class="center-panel" on:click={(e) => onPanelScrimClick(e, sourcePanelEl)}>
      <div class="panel pick-panel" data-focus="" bind:this={sourcePanelEl} on:click={(e) => e.stopPropagation()}>
        <p class="pick-title">Playback source</p>
        {#each sourceOptions as opt (opt.kind)}
          <button
            class="pick-row"
            class:sel={source === opt.kind}
            class:disabled={!opt.available}
            data-focus
            data-focus-disabled={!opt.available ? "true" : ""}
            on:click={() => opt.available && onSourcePick(opt.kind)}
          >
            <span class="pick-label">{opt.label}</span>
            <span class="pick-hint" class:ok={source === opt.kind}>
              {source === opt.kind ? "now playing" : opt.available ? opt.hint : opt.hint || "unavailable"}
            </span>
          </button>
        {/each}
      </div>
    </div>
  {/if}

  {#if overlays.audio}
    <div class="center-panel" on:click={(e) => onPanelScrimClick(e, audioPanelEl)}>
      <div class="panel pick-panel" bind:this={audioPanelEl} on:click={(e) => e.stopPropagation()}>
        <p class="pick-title">Audio track</p>
        {#if audioTracks.length === 0}
          <p class="muted pad">Only one audio track is available in this source.</p>
          {#if source === "original"}
            <p class="muted small pad">
              Switching to <button class="link" on:click={() => onSourcePick("hls")}>HLS</button> often exposes more
              audio tracks for multi-language files.
            </p>
          {/if}
        {:else}
          {#each audioTracks as t, i (t.id)}
            <button
              class="pick-row"
              class:sel={audioTrack === i}
              data-focus
              on:click={() => onAudioPick(i)}
            >
              <span class="pick-label">{t.label}</span>
              <span class="pick-hint" class:ok={audioTrack === i}>{audioTrack === i ? "on" : ""}</span>
            </button>
          {/each}
        {/if}
      </div>
    </div>
  {/if}

  {#if overlays.subs}
    <div class="center-panel" on:click={(e) => onPanelScrimClick(e, subsPanelEl)}>
      <div class="panel pick-panel" bind:this={subsPanelEl} on:click={(e) => e.stopPropagation()}>
        <p class="pick-title">Subtitles</p>
        {#if source === "hls"}
          <button class="pick-row" class:sel={hlsSub === -1} data-focus on:click={() => onSubPick(-1)}>
            <span class="pick-label">Off</span>
            <span class="pick-hint" class:ok={hlsSub === -1}>{hlsSub === -1 ? "on" : ""}</span>
          </button>
          {#each hlsSubTracks as t, i (t.id)}
            <button class="pick-row" class:sel={hlsSub === i} data-focus on:click={() => onSubPick(i)}>
              <span class="pick-label">{t.label}</span>
              <span class="pick-hint" class:ok={hlsSub === i}>{hlsSub === i ? "on" : ""}</span>
            </button>
          {/each}
          {#if hlsSubTracks.length === 0}
            <p class="muted pad">No subtitle tracks in this stream.</p>
          {/if}
        {:else}
          <button class="pick-row" class:sel={activeSub === -1} data-focus on:click={() => onSubPick(-1)}>
            <span class="pick-label">Off</span>
            <span class="pick-hint" class:ok={activeSub === -1}>{activeSub === -1 ? "on" : ""}</span>
          </button>
          {#if subsLoading}
            <div class="pad" style="display:flex;align-items:center">
              <div class="spinner small"></div>
              <span class="muted" style="margin-left:12px">Searching subtitles in {subtitleLanguages.join(", ")}…</span>
            </div>
          {:else if subtitles.length === 0}
            <p class="muted pad">No subtitle tracks found for this title.</p>
            <p class="muted small pad">No matches in your subtitle languages. Change the preferred subtitle language in Settings.</p>
          {:else}
            {#each subtitles as sub, i (sub.id)}
              <button class="pick-row" class:sel={activeSub === i} data-focus on:click={() => onSubPick(i)}>
                <span class="pick-label">{subLabel(sub)}</span>
                <span class="pick-hint" class:ok={activeSub === i}>{activeSub === i ? "on" : ""}</span>
              </button>
            {/each}
          {/if}
        {/if}
      </div>
    </div>
  {/if}

  {#if resumePrompt}
    <div class="center-panel" on:click={(e) => onPanelScrimClick(e, resumePanelEl)}>
      <div class="panel pick-panel resume-panel" bind:this={resumePanelEl} on:click={(e) => e.stopPropagation()}>
        <p class="pick-title">Resume?</p>
        <p class="muted pad" style="text-align:center">
          You left this at {fmtTime(resumePrompt.from)}
        </p>
        <div class="row center">
          <button class="btn primary" data-focus on:click={resume}>Resume from {fmtTime(resumePrompt.from)}</button>
          <button class="btn ghost" data-focus on:click={skipResume}>Start from beginning</button>
        </div>
      </div>
    </div>
  {:else if confirmLeave}
    <div class="center-panel" on:click={(e) => onPanelScrimClick(e, leavePanelEl)}>
      <div class="panel pick-panel resume-panel" bind:this={leavePanelEl} on:click={(e) => e.stopPropagation()}>
        <p class="pick-title">Leave playback?</p>
        <p class="muted pad" style="text-align:center">
          Your position is saved — you'll resume where you left off.
        </p>
        <div class="row center">
          <button class="btn primary" data-focus on:click={leavePlayback}>Yes, back to library</button>
          <button class="btn ghost" data-focus on:click={stayInPlayback}>No, keep playing</button>
        </div>
      </div>
    </div>
  {/if}

  <!-- color legend: physical keys on the remote -->
  <div class="color-legend legend-player" class:visible={showControls}>
    <div class="cl"><span class="dot c4"></span>Subs</div>
    <div class="cl"><span class="dot c2"></span>Source</div>
    <div class="cl"><span class="dot c3"></span>Audio</div>
    <div class="cl"><span class="dot c1"></span>Play</div>
  </div>
</div>

<style>
  .player {
    position: absolute;
    top: 0;
    right: 0;
    bottom: 0;
    left: 0;
    background: var(--black);
  }
  .video {
    width: 100%;
    height: 100%;
    display: block;
    background: var(--black);
  }
  /* Native textTracks (HLS source): the browser's default cue rendering is
     an opaque black box. Override it to a transparent, shadowed caption in
     the app font. Chrome 79 (webOS 6) supports ::cue. :global() keeps the
     rule un-scoped — Svelte's attribute-scoping can't apply to ::cue. */
  :global(video::cue) {
    background: transparent;
    color: var(--text);
    font-family: "Segoe UI", "Noto Sans", Roboto, Arial, sans-serif;
    font-size: 30px;
    text-shadow: 0 2px 4px rgba(0, 0, 0, 0.9), 0 0 18px rgba(0, 0, 0, 0.6);
  }
  .subs {
    position: absolute;
    left: 50%;
    bottom: 190px;
    transform: translateX(-50%);
    z-index: 15;
    max-width: 78%;
    padding: 6px 18px;
    font-size: 30px;
    line-height: 1.4;
    text-align: center;
    color: var(--text);
    text-shadow: 0 2px 4px rgba(0, 0, 0, 0.9), 0 0 18px rgba(0, 0, 0, 0.6);
    white-space: pre-wrap;
    pointer-events: none;
  }
  .subs.show {
    opacity: 1;
  }
  .subs:not(.show) {
    opacity: 0;
  }
  .controls {
    position: absolute;
    left: 0;
    right: 0;
    bottom: 0;
    padding: 40px 72px 36px;
    background: linear-gradient(transparent, rgba(0, 0, 0, 0.78) 40%);
    display: flex;
    flex-direction: column;
    opacity: 0;
    transition: opacity var(--t-slow) var(--ease);
    pointer-events: none;
    z-index: 20;
  }
  .controls > :not(:first-child) {
    margin-top: 22px;
  }
  .controls.visible {
    opacity: 1;
    pointer-events: auto;
  }
  .title-line {
    display: flex;
    align-items: center;
  }
  .title-line > :not(:first-child) {
    margin-left: 16px;
  }
  .title {
    font-size: var(--fs-h1);
    font-weight: 700;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .progress-row {
    display: flex;
    align-items: center;
  }
  .progress-row > :not(:first-child) {
    margin-left: 20px;
  }
  .time {
    font-variant-numeric: tabular-nums;
    font-size: var(--fs-body);
    color: var(--text-2);
    min-width: 84px;
    text-align: center;
  }
  .bar {
    flex: 1;
    height: 36px;
    display: flex;
    align-items: center;
    cursor: pointer;
  }
  .bar-track {
    width: 100%;
    height: 10px;
    border-radius: 5px;
    background: rgba(255, 255, 255, 0.28);
    border: 1px solid rgba(255, 255, 255, 0.4);
    overflow: hidden;
  }
  .bar-fill {
    height: 100%;
    background: var(--accent);
    border-radius: 5px;
    transition: width 200ms linear;
  }
  .button-row {
    display: flex;
    align-items: center;
  }
  .button-row > :not(:first-child) {
    margin-left: 20px;
  }
  .spacer {
    flex: 1;
  }
  .cbtn {
    padding: 12px 22px;
    border-radius: var(--r-md);
    background: rgba(255, 255, 255, 0.08);
    border: 2px solid transparent;
    font-size: var(--fs-body);
    display: flex;
    align-items: center;
  }
  .cbtn .ico {
    font-size: 22px;
  }
  .cbtn.play {
    width: 76px;
    height: 76px;
    border-radius: 50%;
    justify-content: center;
    background: rgba(255, 255, 255, 0.1);
  }
  .cbtn.play .ico {
    font-size: 30px;
  }
  .cbtn[data-state="active"] {
    border-color: var(--accent);
    background: var(--accent-dim-solid);
  }
  .cbtn.sel {
    border-color: var(--accent);
    background: var(--accent-dim-solid);
  }
  .cbtn .sub {
    margin-left: 12px; /* NOT ".cbtn > :not(:first-child)": the label is a text node,
                          so the span IS the first *element* child */
    color: var(--accent-2);
    font-size: var(--fs-small);
    max-width: 220px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .center-panel {
    position: absolute;
    top: 0;
    right: 0;
    bottom: 0;
    left: 0;
    background: rgba(0, 0, 0, 0.55);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 40;
  }
  .pick-panel,
  .err-panel {
    width: 620px;
    padding: 28px 32px;
    max-height: 800px;
    overflow-y: auto;
  }
  .pick-title,
  .err-title {
    font-size: var(--fs-h2);
    font-weight: 700;
    margin-bottom: 18px;
  }
  .pick-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    width: 100%;
    padding: 16px 20px;
    margin-bottom: 8px;
    border-radius: var(--r-md);
    background: var(--surface);
    border: 2px solid transparent;
    font-size: var(--fs-body);
    text-align: left;
  }
  .pick-row[data-state="active"] {
    border-color: var(--accent);
    background: var(--surface-2);
  }
  .pick-row.sel {
    border-color: var(--accent);
    background: var(--accent-dim-solid);
  }
  .pick-row.disabled {
    opacity: 0.4;
  }
  .pick-label {
    font-weight: 600;
  }
  .pick-hint {
    color: var(--text-3);
    font-size: var(--fs-small);
  }
  .pick-hint.ok {
    color: var(--accent-2);
    font-weight: 700;
  }
  .pad {
    padding: 8px 4px 16px;
  }
  .small {
    font-size: var(--fs-small);
  }
  .muted {
    color: var(--text-2);
  }
  .err-title {
    color: var(--danger);
  }
  .row {
    display: flex;
  }
  .row > :not(:first-child) {
    margin-left: 18px;
  }
  .row.center {
    justify-content: center;
  }
  .link {
    color: var(--accent-2);
    font-weight: 700;
  }
  .spinner.small {
    width: 28px;
    height: 28px;
    border-width: 3px;
  }
  .resume-panel {
    width: 640px;
  }
  .legend-player {
    position: absolute;
    right: 72px;
    bottom: 26px;
    opacity: 0;
    transition: opacity var(--t-med);
  }
  .legend-player.visible {
    opacity: 1;
  }
</style>
