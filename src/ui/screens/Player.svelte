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
  import { fmtTime, fmtBytes } from "../../putio/api";
  import { loadSubtitle, type LoadedSubtitle } from "../../putio/subs";
  import type { SubtitleInfo } from "../../putio/types";

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

  // --- simulator diagnostic: is the video layer actually painting? ---
  let diagVisible = false;
  let diagText = "";
  let diagStyle = "";
  let diagTimer: number | null = null;
  let glRenderer = "";
  try {
    const c = document.createElement("canvas");
    const gl = c.getContext("webgl");
    const ext = gl?.getExtension("WEBGL_debug_renderer_info");
    glRenderer = String((gl && ((ext && gl.getParameter(ext.UNMASK_RENDERER)) || gl.getParameter(gl.RENDERER))) || "no-webgl");
  } catch {
    glRenderer = "?";
  }
  let a: any = get(auth);
  $: subtitleLanguages = a?.subtitleLanguages || [];

  // --- ui state
  let source: SourceKind = "original";
  let duration = 0;
  let currentTime = 0;
  let paused = true;
  let buffering = false;
  let error: string | null = null;
  let audioTracks: AudioTrackInfo[] = [];
  let audioTrack = 0;
  let live = false;

  let overlays: { audio: boolean; subs: boolean; source: boolean } = {
    audio: false,
    subs: false,
    source: false,
  };
  let showControls = true;
  let hideTimer: number | null = null;

  let subtitles: LoadedSubtitle[] = [];
  let activeSub = -1; // -1 = off, 0.. = index into subtitles

  let sourceOptions = [
    { kind: "original" as SourceKind, label: "Original", available: true, hint: "" },
    { kind: "mp4" as SourceKind, label: "put.io MP4", available: false, hint: "" },
    { kind: "hls" as SourceKind, label: "HLS", available: true, hint: "" },
  ];

  let resumePrompt: { from: number } | null = null;

  // ---------------- engine wiring ----------------

  function initEngine() {
    const au = currentAuth();
    if (!au || !videoEl) return;
    engine = new MediaEngine(videoEl, file as any, au, {
      onState: (p) => {
        if (p.source !== undefined) source = p.source;
        if (p.duration !== undefined && p.duration !== Infinity) duration = p.duration;
        if (p.currentTime !== undefined) currentTime = p.currentTime;
        if (p.paused !== undefined) paused = p.paused;
        if (p.buffering !== undefined) buffering = p.buffering;
        if (p.error !== undefined) error = p.error;
        if (p.audioTracks !== undefined) audioTracks = p.audioTracks;
        if (p.audioTrack !== undefined) audioTrack = p.audioTrack;
        if (p.live !== undefined) live = p.live;
      },
      onSourceChange: (s) => {
        source = s;
        overlays.source = true;
        showControls = true;
      },
      onEnded: () => {
        showControls = true;
        platform.toast("Finished — press Back to return to your library");
      },
    });

    sourceOptions = engine.sourceOptions().map((o) => ({ ...o }));
    engine.setSource("original", undefined, true); // silent: don't pop the source overlay on entry
  }

  function onBack() {
    if (resumePrompt) {
      resumePrompt = null;
      return;
    }
    if (overlays.audio || overlays.subs || overlays.source) {
      overlays.audio = false;
      overlays.subs = false;
      overlays.source = false;
      return;
    }
    dispatch("back");
  }

  function onColor(c: "blue" | "green" | "red" | "yellow") {
    if (c === "blue") overlays.source = !overlays.source;
    if (c === "green") overlays.audio = !overlays.audio;
    if (c === "red") overlays.subs = !overlays.subs;
    if (c === "yellow") engine?.togglePlayPause();
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
      for (const sub of res.subtitles || []) {
        const blobURL = await loadSubtitle(sub.url, sub.format);
        subtitles.push({
          id: sub.key,
          language: sub.language,
          languageCode: sub.language_code,
          name: sub.name,
          url: sub.url,
          format: sub.format,
          blobURL: blobURL || undefined,
        });
      }
    } catch (e: any) {
      platform.toast("Couldn't load subtitles");
    }
    subsLoading = false;
  }

  function toggleSub(i: number) {
    const v = videoEl as any;
    const tracks = v.textTracks;
    if (tracks) {
      for (let i = 0; i < tracks.length; i++) {
        try {
          tracks[i].mode = i === activeSub ? "showing" : "disabled";
        } catch {}
      }
    }
  }

  function onSubPick(i: number) {
    activeSub = activeSub === i ? -1 : i;
    toggleSub(activeSub);
    if (activeSub === -1) platform.toast("Subtitles off");
    else if (subtitles[activeSub]) platform.toast(`Subtitles: ${subtitles[activeSub].language}`);
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

    // resume from put.io?
    if (file.start_from && file.start_from > 30) {
      resumePrompt = { from: file.start_from };
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
        // in player, OK without a focused overlay control toggles play
        if (!overlays.audio && !overlays.subs && !overlays.source) {
          engine?.togglePlayPause();
          wake();
        }
      },
    });

    engine?.applyResume().then((from) => {
      if (from && !resumePrompt) {
        resumePrompt = { from };
      }
    });

    ensureSubtitles();

    // Sample the painted video frame every ~1.5s so a black-but-playing video
    // is visible from the DIAG badge instead of a silent dark screen.
    if (videoEl) {
      const cv = document.createElement("canvas");
      cv.width = 32;
      cv.height = 18;
      const cx = cv.getContext("2d", { willReadFrequently: true });
      const sample = () => {
        const v = videoEl;
        if (!cx) return;
        if (!v.videoWidth) {
          diagVisible = false;
          return;
        }
        let luma = 0;
        try {
          cx.drawImage(v, 0, 0, 32, 18);
          const d = cx.getImageData(0, 0, 32, 18).data;
          let sum = 0;
          for (let i = 0; i < d.length; i += 4) sum += (d[i] + d[i + 1] + d[i + 2]) / 3;
          luma = sum / (32 * 18);
        } catch {
          luma = -1; // canvas tainted (shouldn't happen in-app) — can't sample
        }
        const pic = luma < 0 ? "(n/a)" : "PIC " + Math.round(luma);
        diagText =
          "DIAG " + v.videoWidth + "x" + v.videoHeight +
          " ready=" + v.readyState +
          " " + (v.paused ? "PAUSED" : "PLAYING") +
          " " + pic +
          (luma < 8 ? "  ⚠ NO PICTURE" : "") +
          "  | " + glRenderer;
        diagVisible = true;
      };
      sample();
      diagTimer = window.setInterval(sample, 1500);
    }
  });

  function resume() {
    if (resumePrompt && engine) {
      engine.video.currentTime = Math.max(0, resumePrompt.from - 5);
      engine.play();
    }
    resumePrompt = null;
  }
  function skipResume() {
    resumePrompt = null;
    engine?.play();
  }

  onDestroy(() => {
    document.body.classList.remove("player-mode");
    window.removeEventListener("focus", kick);
    document.removeEventListener("visibilitychange", onVis);
    if (diagTimer) clearInterval(diagTimer);
    unsub?.();
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
    const existing = v.querySelectorAll("track");
    existing.forEach((t) => t.remove());
    subtitles.forEach((sub, i) => {
      if (!sub.blobURL) return;
      const tr = document.createElement("track");
      tr.kind = "subtitles";
      tr.label = sub.language;
      tr.srclang = sub.languageCode;
      tr.src = sub.blobURL;
      try {
        tr.mode = i === activeSub ? "showing" : "disabled";
      } catch {}
      v.appendChild(tr);
    });
  }
  $: rebuildTracks();

  $: subList = subtitles.map((s) => s.language).join(", ");
  const bufEnd = 0; // not computed; we show a simple buffered bar via engine state later if needed

  function pct(): number {
    if (!duration) return 0;
    return Math.min(100, (currentTime / duration) * 100);
  }

  let barEl: HTMLDivElement;
  function onBarClick(e: MouseEvent) {
    if (!barEl || !duration) return;
    const r = barEl.getBoundingClientRect();
    const f = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    engine?.seek(f * duration);
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

  {#if diagVisible}
    <div class="diag" style={diagStyle}>{diagText}</div>
  {/if}

  <!-- ================= bottom control bar ================= -->
  <div class="controls" class:visible={showControls || paused || !!error || overlays.audio || overlays.subs || overlays.source} class:dim={paused ? "" : "dim"}>
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
          <div class="bar-fill" style="width: {pct()}%"></div>
        </div>
      </div>
      <span class="time">{live ? "" : fmtTime(duration)}</span>
    </div>

    <div class="button-row">
      <button class="cbtn" data-focus on:click={() => { engine?.skip(-10); wake(); }}>
        <span class="ico">«10</span>
      </button>
      <button class="cbtn play" data-focus on:click={() => { engine?.togglePlayPause(); wake(); }}>
        <span class="ico">{paused ? "▶" : "❚❚"}</span>
      </button>
      <button class="cbtn" data-focus on:click={() => { engine?.skip(30); wake(); }}>
        <span class="ico">30»</span>
      </button>

      <span class="spacer"></span>

      <button class="cbtn text" data-focus on:click={() => (overlays.source = !overlays.source)} class:sel={overlays.source}>
        Source <span class="sub">{source === "original" ? "original" : source}</span>
      </button>
      <button class="cbtn text" data-focus on:click={() => (overlays.audio = !overlays.audio)} class:sel={overlays.audio}>
        Audio <span class="sub">{audioTracks.length ? audioTracks[audioTrack]?.label || audioTracks[0]?.label : "—"}</span>
      </button>
      <button class="cbtn text" data-focus on:click={() => { overlays.subs = !overlays.subs; ensureSubtitles(); }} class:sel={overlays.subs}>
        Subtitles <span class="sub">{activeSub === -1 ? "off" : subtitles[activeSub]?.language || "off"}</span>
      </button>
    </div>
  </div>

  <!-- ================= overlays ================= -->

  {#if error}
    <div class="center-panel">
      <div class="panel err-panel">
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
    <div class="center-panel">
      <div class="panel pick-panel" data-focus="">
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
    <div class="center-panel">
      <div class="panel pick-panel">
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
    <div class="center-panel">
      <div class="panel pick-panel">
        <p class="pick-title">Subtitles</p>
        <button class="pick-row" class:sel={activeSub === -1} data-focus on:click={() => onSubPick(-1)}>
          <span class="pick-label">Off</span>
          <span class="pick-hint" class:ok={activeSub === -1}>{activeSub === -1 ? "on" : ""}</span>
        </button>
        {#if subsLoading}
          <div class="pad" style="display:flex;align-items:center;gap:12px">
            <div class="spinner small"></div>
            <span class="muted">Searching subtitles in {subtitleLanguages.join(", ")}…</span>
          </div>
        {:else if subtitles.length === 0}
          <p class="muted pad">No subtitles found for this title.</p>
        {:else}
          {#each subtitles as sub, i (sub.id)}
            <button class="pick-row" class:sel={activeSub === i} data-focus on:click={() => onSubPick(i)}>
              <span class="pick-label">{sub.language}</span>
              <span class="pick-hint" class:ok={activeSub === i}>{activeSub === i ? "on" : ""}</span>
            </button>
          {/each}
        {/if}
      </div>
    </div>
  {/if}

  {#if resumePrompt}
    <div class="center-panel">
      <div class="panel pick-panel resume-panel">
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
  {/if}

  <!-- color legend -->
  <div class="color-legend legend-player" class:visible={showControls}>
    <div class="cl"><span class="dot c1"></span>Source</div>
    <div class="cl"><span class="dot c2"></span>Audio</div>
    <div class="cl"><span class="dot c3"></span>Subs</div>
    <div class="cl"><span class="dot c4"></span>Play</div>
  </div>
</div>

<style>
  .player {
    position: absolute;
    inset: 0;
    background: #000;
  }
  .video {
    width: 100%;
    height: 100%;
    display: block;
    background: #000;
  }
  .diag {
    position: absolute;
    top: 16px;
    left: 16px;
    z-index: 30;
    padding: 6px 14px;
    border-radius: var(--r-sm);
    background: rgba(0, 0, 0, 0.72);
    color: #b6f0b6;
    font-family: ui-monospace, Menlo, monospace;
    font-size: 15px;
    letter-spacing: 0.03em;
    pointer-events: none;
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
    gap: 22px;
    opacity: 0;
    transition: opacity var(--t-slow) var(--ease);
    pointer-events: none;
    z-index: 20;
  }
  .controls.visible {
    opacity: 1;
    pointer-events: auto;
  }
  .title-line {
    display: flex;
    align-items: center;
    gap: 16px;
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
    gap: 20px;
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
    height: 8px;
    border-radius: 4px;
    background: rgba(255, 255, 255, 0.18);
    overflow: hidden;
  }
  .bar-fill {
    height: 100%;
    background: var(--accent);
    border-radius: 4px;
    transition: width 200ms linear;
  }
  .button-row {
    display: flex;
    align-items: center;
    gap: 20px;
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
    gap: 12px;
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
    background: var(--accent-dim);
  }
  .cbtn.sel {
    border-color: var(--accent);
    background: var(--accent-dim);
  }
  .cbtn .sub {
    color: var(--accent-2);
    font-size: var(--fs-small);
    max-width: 220px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .center-panel {
    position: absolute;
    inset: 0;
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
    background: var(--accent-dim);
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
    gap: 18px;
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
