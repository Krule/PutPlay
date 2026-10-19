<script lang="ts">
  import { onMount, onDestroy, tick } from "svelte";
  import { get } from "svelte/store";
  import { getRemote } from "../../webos/remote";
  import { platform } from "../../webos/platform";
  import { currentAuth, auth } from "../../store/auth";
  import {
    MediaEngine,
    type SourceKind,
    type AudioTrackInfo,
    type MediaState,
  } from "../../putio/media";
  import type { SubtitleTrackInfo } from "../../putio/media";
  import type { AudioPanelRow } from "../../putio/track-merge";
  import { panelRowHint } from "../../putio/track-merge";
  import { fmtTime } from "../../putio/api";
  import {
    loadSubtitle,
    cuesAt,
    subtitleSourceLabel,
    orderSubtitleSources,
    pickSubtitleDefault,
    unionSubtitleLanguages,
    type LoadedSubtitle,
    type SubtitleCue,
  } from "../../putio/subs";
  import { segAction, type Seg } from "../../putio/segments";
  import { lookupSegments } from "../../putio/seglookup";
  import { segCache } from "../../putio/seg-cache";
  import { TMDB_KEY } from "../../putio/tmdb-key";
  import { surfaceVisibility } from "../../putio/player-surface";
  import { pillState } from "../../putio/ctx-pill";
  import { clickIsOutsideClickTarget } from "../../putio/overlay";
  import { shouldAdviseSmootherSource } from "../../putio/stall";
  import { playerOkAction } from "../../putio/player-ok";
  import { isRowKey, rowStep } from "../row-nav";
  import { pickerDefaultIndex, rowFocusState } from "../../putio/picker-default";
  import { buildTitleView } from "../../putio/title-view";
  import { parseEpisode, parseMovieName } from "../../putio/titles";
  import { scrubSeek, scrubThumbPct, segSpans, barTrackFraction, trackLeftCss } from "../../putio/scrub";
  import { buildInfoPanel, type PanelAction } from "../../putio/info-tab";
  import { upNext } from "../../putio/upnext";
  import {
    lookupEpisodeInfo,
    lookupMovieInfo,
    type InfoData,
  } from "../../putio/info-data";
  import { infoCache } from "../../putio/info-cache";
  import { config, pickSubtitleTrack, saveConfig, SUB_SCALE_OPTIONS } from "../../store/config";
  import {
    video as videoStore,
    setVideoMode,
    endVideoSession,
    advanceVideo,
    stepVideo,
  } from "../../store/video";

  export let file: {
    id: number;
    name: string;
    is_folder?: boolean;
    is_mp4_available?: boolean;
    start_from?: number;
    size?: number;
  };

  /** Which chrome the session is in. The <video> element and the engine are
   *  the SAME node across all modes — docking is a chrome change, never an
   *  engine change (plan §9.1). */
  export let mode: "full" | "mini" | "micro" = "full";
  /** While a reading screen (comic/image) is up, the MICRO form (the icon
   *  row) recedes to 0.25 like the music row; :focus-within brings it
   *  back. The mini keeps the video fully visible. */
  export let dimmed = false;

  const remote = getRemote();
  $: session = $videoStore;
  // manual-queue edges: the dock's prev/next disable at the ends (music parity)
  $: atFirst = session ? session.index <= 0 : true;
  $: atLast = session ? session.index >= session.queue.length - 1 : true;
  // the file the engine is currently built for — a session file change
  // (auto-next / manual step) rebuilds the engine on the SAME element
  let engineFileId: number | null = null;
  let videoSub: (() => void) | null = null;
  let dockEl: HTMLElement | null = null;
  let dockPrev: HTMLButtonElement | null = null;
  let dockNext: HTMLButtonElement | null = null;
  // The ladder's {#if} swap recreates the size button IN PLACE (the
  // container is never reassigned), so the scan must track `mode` — and
  // it must run AFTER Svelte patches the template: reactive statements
  // run before the DOM update, so a synchronous scan sees the old
  // buttons and the recreated one is never registered (the D-pad walk
  // jumps over it). registerAll is idempotent per node; detached old
  // nodes are GC'd by the engine on the next press.
  $: if (dockEl && mode) tick().then(() => remote.registerAll(dockEl));
  $: if (dockPrev) remote.setDisabled(dockPrev, atFirst);
  $: if (dockNext) remote.setDisabled(dockNext, atLast);
  // FULL only: the body class swaps the app-shell layout behind the takeover
  $: if (typeof document !== "undefined")
    document.body.classList.toggle("player-mode", mode === "full");

  let videoEl: HTMLVideoElement;
  let engine: MediaEngine | null = null;

  // --- the title view (the chrome's identity row) + playback speed ---
  // The parsed episode (titles.ts) feeds both the title view and the
  // segment-skip chain; a non-episode file (a movie) is null → the title
  // view falls back to the file name, no subtitle line (A8).
  $: episodeParse = parseEpisode(file.name);
  /** The TMDb-resolved episode title (late enrichment from the info data). */
  let tmdbEpisodeTitle: string | null = null;
  $: tv = buildTitleView({
    name: file.name,
    episode: episodeParse,
    live,
    source,
    episodeName: tmdbEpisodeTitle,
    showTitle: infoData?.showTitle ?? null, // late canonical title (the info lookup)
  });

  /** Playback speed: the Player owns the state (icon + menu) and re-applies
   *  it per file; session-level (no persistence in v1). VOD-only. */
  let speed = 1;
  const SPEED_OPTIONS = [0.5, 0.75, 1, 1.25, 1.5, 2];
  $: speedLabel = `${speed}x`;

  // --- the info panel (D-pad down from the transport row) ---
  // The data arrives LATE (network) — the panel renders the instant it
  // opens and re-renders when the data lands; a file switch invalidates the
  // in-flight lookup (req id); nothing ever blocks the first frame.
  let infoOpen = false;
  let infoData: InfoData | null = null;
  let infoReq = 0;
  $: infoPanel = buildInfoPanel({
    kind: episodeParse ? "episode" : "movie",
    synopsis: infoData?.synopsis ?? null,
    details: infoData
      ? {
          rating: infoData.rating,
          genres: infoData.genres,
          airDate: infoData.airDate,
          runtime: infoData.runtime,
        }
      : null,
    upNext: upNext(session?.queue, session?.index ?? 0),
  });

  let a: any = get(auth);
  $: subtitleLanguages = a?.subtitleLanguages || [];

  let cfg: any = get(config);
  let cfgSub: (() => void) | null = null;
  $: subScale = cfg?.subScale || 1;
  $: preferredSubLang = cfg?.subtitleLang || "";

  // --- ui state
  let source: SourceKind = "original";
  let duration = 0;
  let currentTime = 0;
  let paused = true;
  let buffering = false;
  let bufferEnd = 0; // seconds — how far ahead of the file start data is buffered
  let error: string | null = null;
  let audioTracks: AudioTrackInfo[] = [];
  let audioTrack = 0;
  /** The merged panel model: one row per audio stream in the FILE. */
  let audioPanelRows: AudioPanelRow[] = [];
  let audioActiveKey: string | null = null;
  let audioSwitching = false;
  /** The preferred audio language was already applied for the current
   *  source — it must NOT be re-applied on every track sync (a `change`
   *  event from our own confirmed switch would otherwise fight the user's
   *  pick). Reset on every source change. */
  /** The user's pending audio pick (row key) — confirmed (or refused) by the engine's next state. */
  let pendingAudioPick: string | null = null;
  /** The auto-hls fallback was already tried for this pick — a second
   *  refusal toasts instead of looping back into the stream. */
  let autoHlsTried = false;
  let hlsSubTracks: SubtitleTrackInfo[] = [];
  let live = false;
  /** Mid-playback stalls on the current source (engine-owned). */
  let stalls = 0;
  /** The smoother-stream advice was already given for this file (once, not a nag). */
  let stallAdvised = false;

  let overlays: { audio: boolean; subs: boolean; source: boolean; speed: boolean } = {
    audio: false,
    subs: false,
    source: false,
    speed: false,
  };
  let showControls = true;
  let hideTimer: number | null = null;
  let startedPlaying = false;

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

  /** The episode's segments from TheIntroDB (the lookup's result) — the
   *  auto-skip and the offer both act on these windows. */
  let segs: Seg[] = [];
  /** Per segment: settled (skipped or played through) — a settled section
   *  never fires its action again. */
  let segConsumed: boolean[] = [];
  /** Any overlay/panel on top of the chrome: the focus owner while true. */
  $: anyPanelOpen =
    overlays.audio ||
    overlays.subs ||
    overlays.source ||
    overlays.speed ||
    infoOpen;
  /** The contextual skip BUTTON (ctx-pill): the offer's display state.
   *  A button above the title row in the player's own button material,
   *  FOCUSED the moment it lands (OK alone = the instant skip), Back =
   *  play through, leaving the window settles it too. */
  $: pill = pillState({
    segs,
    time: currentTime,
    duration,
    consumed: segConsumed,
    mode,
    autoSkip: !!cfg?.skipSegments,
    panelOpen: anyPanelOpen,
  });
  /** The offer panel is up for this segment index (-1 = closed). At most
   *  one offer per section per file — "play through" or a natural end
   *  settles it. */
  // ---------------- engine wiring ----------------

  /** "Play next in folder" applies: the setting is on AND there is a next
   *  video in the queue (end of queue is a STOP, same rule as music). */
  function canAdvanceVideo(): boolean {
    return get(config).playNext && !!session && session.index < session.queue.length - 1;
  }

  /** Engine state patch → screen state, one field at a time (undefined = unchanged). */
  function applyEngineState(p: Partial<MediaState>): void {
    // (a new source invalidates any pending pick — done in
    // onSourceChange, which runs BEFORE this patch and can therefore
    // observe the change at all; comparing p.source here against the
    // already-updated `source` state was dead code)
    if (p.source !== undefined) source = p.source;
    if (p.duration !== undefined && p.duration !== Infinity) duration = p.duration;
    if (p.currentTime !== undefined) currentTime = p.currentTime;
    if (p.paused !== undefined) paused = p.paused;
    if (p.buffering !== undefined) buffering = p.buffering;
    if (p.buffered !== undefined) bufferEnd = p.buffered;
    if (p.error !== undefined) {
      error = p.error;
      // the fallback's setSource clears the panel error a moment later —
      // toast the (descriptive) message so the source bounce is explained
      // instead of reading as a silent refusal
      if (p.error) {
        platform.toast(p.error);
        startMeta(); // no first frame on a broken stream — the info tab still wants its data
      }
    }
    if (p.audioPanelRows !== undefined) audioPanelRows = p.audioPanelRows;
    if (p.audioActiveKey !== undefined) audioActiveKey = p.audioActiveKey;
    if (p.audioSwitching !== undefined) audioSwitching = p.audioSwitching;
    // The configured preference named a language this file has no track
    // for — say so (one toast per file open; the old behavior was
    // silence, which read as "the setting does nothing")
    if (p.audioPrefMiss) platform.toast(p.audioPrefMiss);
    // a fresh start skipped past the leading segments — say what was
    // skipped (the engine names the types: "intro + recap")
    if (p.skippedSeg) platform.toast(`Skipped ${p.skippedSeg}`);
    if (p.audioTracks !== undefined) audioTracks = p.audioTracks;
    // NOTE: the preferred-language pick is owned by the ENGINE
    // (setAudioPreference → applied to the first REAL track list, with
    // full escalation). Doing it here per-sync consumed the once-flag on
    // the EMPTY first sync (src set → bindTrackEvents before the pipeline
    // exposes tracks) and the preference was never applied — the reported
    // "still plays italian" bug.
    // A pick is only toasted once the ENGINE confirms it landed (the webview
    // can silently veto the switch). A refusal arrives as audioSwitchFailed —
    // say so (with the reason when the engine has one), never pretend.
    if (p.audioSwitchFailed) {
      // a user pick resolves via pendingAudioPick; a PREFERENCE refusal
      // has none — resolve its row via audioPickIndex instead, or the
      // "use the put.io stream" setting is dead for configured
      // preferences (the user's exact case)
      const row =
        pendingAudioPick !== null
          ? audioPanelRows.find((r) => r.key === pendingAudioPick)
          : p.audioPickIndex !== undefined
          ? audioPanelRows.find((r) => r.nativeIndex === p.audioPickIndex)
          : undefined;
      // A native switch the webview refuses ALWAYS falls back to the put.io
      // rendition of the chosen language, position kept (the old "if the
      // original can't switch audio" setting is gone — auto switch is the
      // only behavior now). Single-flight: a second refusal in the same
      // session toasts and stops, it cannot loop.
      const autoHls = !!row && row.hlsIndex >= 0 && !autoHlsTried;
      if (autoHls) {
        autoHlsTried = true;
        platform.toast("The TV couldn't switch — using the put.io stream for this language.");
        engine?.enterHlsForRow(row);
      } else {
        platform.toast(
          p.audioFailReason ||
            "The TV player didn't switch audio for this file. The HLS source often exposes switchable tracks."
        );
        pendingAudioPick = null;
      }
    } else if (p.audioTrack !== undefined) {
      audioTrack = p.audioTrack;
      // A pick is confirmed ONLY by the terminal patch (the one that clears
      // audioSwitching). Mid-switch syncs — the dance re-binds the track
      // list and reports the CURRENT track — must not confirm: doing so
      // toasted the wrong track ("Audio: English" for a Spanish pick) and
      // cleared the pending pick before the real confirmation arrived.
      if (pendingAudioPick !== null && !audioSwitching) {
        const row = audioPanelRows.find((r) => r.key === pendingAudioPick);
        if (row) platform.toast(`Audio: ${row.label}`);
        pendingAudioPick = null;
      }
    }
    if (p.subtitleTracks !== undefined) hlsSubTracks = p.subtitleTracks;
    if (p.live !== undefined) live = p.live;
    if (p.stalls !== undefined) stalls = p.stalls;
  }

  function initEngine() {
    const au = currentAuth();
    if (!au || !videoEl) return;
    // A session file change (auto-next / manual step) rebuilds the engine on
    // the SAME element: tear the old one down first, and reset only the
    // per-file UI state (position/tracks arrive fresh from the new engine).
    if (engine) {
      engine.destroy();
      engine = null;
      for (const s of subtitles) if (s.blobURL) URL.revokeObjectURL(s.blobURL);
      subtitles = [];
      activeSub = -1;
      hlsSub = -1;
      subCues = [];
      subText = "";
      startedPlaying = false;
      metaStarted = false; // the new file's lookups haven't fired yet
      abortMeta(); // the old file's in-flight lookups die with it
      scrubHover = null; // a stale pointer preview must not survive the file change
      segs = []; // a new file is a fresh segment decision
      segConsumed = [];
    }
    engineFileId = file.id;
    cfg = get(config);
    // does the user's preferred source have the file in a state to use?
    // ("put.io MP4" preference falls back to original when not converted)
    const cfgSource = cfg?.source || "original";
    const prefSource = cfgSource === "mp4" && !file.is_mp4_available ? "original" : cfgSource;
    engine = new MediaEngine(videoEl, file as any, au, {
      onState: applyEngineState,
      onSourceChange: (s) => {
        source = s;
        // never FORCE the source panel open here: an audio-row pick also
        // switches source, and popping this panel over the audio panel the
        // user is interacting with steals D-pad focus. The panel simply
        // stays open (badge updates in place) if the user is already in
        // it; the source button's label always shows the active source.
        if (overlays.source) showControls = true;
        // a source swap drops the previous source's tracks — reset subtitle selection
        activeSub = -1;
        hlsSub = -1;
        subCues = [];
        subText = "";
        if (s !== "hls") ensureSubtitles();
      pendingAudioPick = null; // a source swap invalidates any pending pick
      },
      onEnded: () => {
        showControls = true;
        engine?.finish(); // the end position saves no resume
        // "Play next in folder" (default on): the session file changes and
        // the reactive below rebuilds the engine on the next video. End of
        // queue (or the setting off) → the honest finished state.
        if (canAdvanceVideo()) {
          advanceVideo();
          return;
        }
        platform.toast("Finished — press Back to return to your library");
      },
    });
    engine.setAudioPreference(cfg?.audioLang || null);
    engine.setSpeed(speed); // the session's rate applies to the new file too
    sourceOptions = engine.sourceOptions().map((o) => ({ ...o }));
    engine.setSource(prefSource, undefined, true); // silent: don't pop the source overlay on entry
    // the metadata lookups (segments + info) wait for the first frame —
    // startMeta(): 6-10 small requests racing the stream's first bytes is
    // the "starting feels slower" cost, and by the first frame the
    // connection is already established
  }

  /**
   * The per-file metadata session: the segment lookup and the info load
   * share ONE AbortController, created lazily when the lookups fire and
   * aborted when the file is abandoned (a new file, or the player's
   * unmount) — in-flight requests die instead of contending with the
   * next stream. (The chain degrades an abort to "nothing to skip" —
   * pinned in test/segment-skip.test.mjs — so it never rejects.)
   */
  let metaCtrl: AbortController | null = null;
  /** startMeta fired for this file (the first-frame reactive and the
   *  error branch can both reach it — once is enough). */
  let metaStarted = false;

  /** The fetch both lookups get: the session's signal rides on every request. */
  function metaFetch(): typeof fetch {
    if (!metaCtrl) metaCtrl = new AbortController();
    const signal = metaCtrl.signal;
    return (url, opts) => fetch(url, { ...opts, signal });
  }

  function abortMeta(): void {
    metaCtrl?.abort();
    metaCtrl = null;
  }

  /**
   * Fire the file's metadata lookups — once per file, at the first frame
   * (behind an established stream) or on a stream error (a broken file
   * never delivers a first frame, but the info tab still wants its
   * data). Skip data landing a few seconds in is still inside the
   * engine's fresh-skip grace; the crossing reactive covers the rest.
   */
  function startMeta(): void {
    if (metaStarted) return;
    metaStarted = true;
    startSegLookup();
    loadInfo();
  }

  /**
   * The per-file segment lookup (async, NON-BLOCKING): file name → TMDb
   * (the key baked into the app — a TV has no viable keyboard for a key)
   * → TheIntroDB → the episode's intro/recap/credits windows. Playback
   * starts immediately; when the data lands, the engine applies the
   * fresh-start skip late (the playhead is still near the top), and the
   * Player's crossing reactive takes over from there. No episode marker,
   * no match, no data → nothing is fetched further and nothing is
   * skipped. A stale answer (the file changed mid-flight) is dropped —
   * the cache (IndexedDB) keeps re-plays free of network.
   */
  function startSegLookup(): void {
    if (!TMDB_KEY || TMDB_KEY === "PASTE_KEY_HERE") {
      segs = [];
      segConsumed = [];
      return; // no baked-in key — the feature is off (honestly, quietly)
    }
    const forId = file.id;
    const name = file.name;
    // non-empty merged answers are cached for a month (seglookup.ts);
    // re-playing the same file costs zero network
    lookupSegments(TMDB_KEY, name, metaFetch(), segCache) // the bound fetch carries the file's abort signal
      .then((s) => {
        if (forId !== file.id || !engine) return;
        segs = s;
        segConsumed = s.map(() => false);
        engine.setSegments(s);
      })
      .catch(() => {}); // the lookup degrades to "nothing to skip" itself
  }

  /**
   * The engine follows the session file. There is no resume prompt (L1:
   * pure auto-resume) — the engine's own auto-resume applies on every open
   * (a real saved position, near the start), and "start from beginning" is
   * a seek to 0 on the scrubber.
   */
  $: if (videoEl && file && file.id !== engineFileId) {
    initEngine();
    ensureSubtitles();
  }

  /** Back in FULL docks: lossless and reversible, so no confirmation — the
   *  media keeps playing in the mini dock and the background screen comes
   *  forward. Docked (mini/micro), the background screen owns Back entirely
   *  (it re-asserts the remote when we stop re-asserting below). */
  /** D-pad down from the transport row: the info panel. */
  function openInfo(): void {
    infoOpen = true;
    wake();
  }

  function closeInfo(): void {
    infoOpen = false;
    wake();
  }

  /** Load the info data for the current file — non-blocking (the panel
   *  re-renders on arrival); the req id drops a late response if the file
   *  changed in flight. Called from startMeta (the first-frame /
   *  stream-error point — once per file). */
  function loadInfo(): void {
    const req = ++infoReq;
    infoData = null;
    tmdbEpisodeTitle = null;
    if (episodeParse) {
      lookupEpisodeInfo({
        title: episodeParse.title,
        year: episodeParse.year,
        season: episodeParse.season,
        episode: episodeParse.episode,
        fetchImpl: metaFetch(),
        cache: infoCache,
      }).then((d) => {
        if (req !== infoReq) return;
        infoData = d;
        tmdbEpisodeTitle = d?.episodeTitle ?? null; // late title-view enrichment
      });
      return;
    }
    const mv = parseMovieName(file.name);
    if (!mv) return; // no movie title to query (numbers / scene junk)
    lookupMovieInfo({ name: mv.title, year: mv.year, fetchImpl: metaFetch(), cache: infoCache }).then((d) => {
      if (req !== infoReq) return;
      infoData = d;
    });
  }

  /** Info actions: restart is a SEEK TO 0 (L1 — no fresh-target
   *  re-derivation); up-next plays the queue's next file (the same path
   *  as auto-next). */
  function playFromBeginning(): void {
    engine?.seek(0);
    if (paused) engine?.togglePlayPause();
    closeInfo();
    wake();
  }

  function playUpNext(): void {
    closeInfo();
    advanceVideo();
  }

  function runInfoAction(id: PanelAction["id"]): void {
    if (id === "restart") playFromBeginning();
    else if (id === "upnext") playUpNext();
  }

  function onBack() {
    if (mode !== "full") return;
    // Back chain: open menu → info panel → skip pill → dock (mini)
    if (overlays.audio || overlays.subs || overlays.source || overlays.speed) {
      closeOverlays();
      return;
    }
    if (infoOpen) {
      closeInfo();
      return;
    }
    if (pill) {
      playSegThrough(pill.index); // Back = play through (the harmless default)
      return;
    }
    setVideoMode("mini");
  }

  /** Close (the ✕ in the dock): the only thing that stops the media. The
   *  position is saved first — reopening resumes where we left off. */
  function closeVideo() {
    engine?.saveResume();
    endVideoSession();
  }

  // The user's keymap (LG remote): red = playback source, green = audio
  // track, yellow = subtitles, blue = play/pause.
  function onColor(c: "blue" | "green" | "red" | "yellow") {
    if (c === "blue") engine?.togglePlayPause();
    if (c === "red") toggleOverlay("source");
    if (c === "green") toggleOverlay("audio");
    if (c === "yellow") {
      if (overlays.subs) toggleOverlay("subs");
      else {
        toggleOverlay("subs");
        ensureSubtitles();
      }
    }
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
    closeVideo();
  }

  // Controls stay up while the user is looking at something (paused, error,
  // or a panel open); otherwise they hide 4s after the last activity.
  // The spinner/pause-echo rules (A5/A6) come from the same pure decision.
  $: surface = surfaceVisibility({
    paused,
    buffering,
    error: !!error,
    menuOpen: overlays.audio || overlays.subs || overlays.source || overlays.speed,
    infoOpen,
  });
  $: pinned = surface.pinned;

  // FEATURE: segment skip — when the playhead enters a segment window
  // (intro / recap / end credits), the auto-skip switch ON skips straight
  // to the end (end credits END the episode). OFF: the contextual PILL
  // (the $: pill reactive above — full mode only, never over an open
  // panel) is the offer. A settled section (consumed) never fires again.
  // Works docked too — the auto-skip is a seek, the pill is what needs the
  // full screen. The check must be a reactive statement (a bare call would
  // run once at mount and freeze).
  $: if (segs.length && currentTime > 0 && !paused && !live) {
    const action = segAction(segs, currentTime, duration, segConsumed, !!cfg?.skipSegments, live);
    if (action && (action.kind === "skip" || action.kind === "credits")) {
      skipSegNow(action.index);
    }
  }

  // The original stream's buffer belongs to the webview — the app cannot
  // grow it (no HTML5 API) — but it must not sit silent when it keeps
  // stalling either: once per file, point at the smoother, engine-buffered
  // put.io stream. (Issue: "the current one suffers from interruptions.")
  $: if (shouldAdviseSmootherSource({ source, stalls, advised: stallAdvised })) {
    stallAdvised = true;
    platform.toast(
      "Original keeps stalling on this connection — the put.io MP4 stream is usually smoother (Source, green key)."
    );
  }

  function wake() {
    showControls = true;
    if (hideTimer) clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      if (!pinned) showControls = false;
    }, 4000);
  }

  // Aggressive auto-hide: once playback actually starts (metadata loaded,
  // not paused/buffering), schedule the first hide. One-shot — afterwards
  // only pointer movement / D-pad / control actions (all → wake()) matter.
  $: if (engine && duration > 0 && !paused && !buffering && !startedPlaying) {
    startedPlaying = true;
    wake();
    startMeta(); // the deferred lookups: behind the first frame, not at source load
  }

  // ---------------- audio panel helpers ----------------

  /** The row actually on (merged-model aware; falls back to the legacy list). */
  $: activeAudioRow =
    audioPanelRows.find((r) => r.key === audioActiveKey) || null;
  $: audioButtonLabel = activeAudioRow
    ? activeAudioRow.label
    : audioTracks[audioTrack] && audioTracks[audioTrack].label
    ? audioTracks[audioTrack].label
    : audioTracks.length
    ? audioTracks[0].label
    : "—";

  /** What a not-on row can offer: native rows need no hint; metadata-only
   *  rows point at the put.io stream when it has the language, else they
   *  say the truth (the TV can't decode the codec). */
  // ---------------- subtitles ----------------

  let subsLoading = false;

  /** Panel toggling with sibling-closing: opening one panel never leaves
   *  another open — two stacked .center-panels break D-pad focus and make
   *  the top panel's rows unreachable. */
  function toggleOverlay(which: "audio" | "subs" | "source" | "speed") {
    const wasOpen = overlays[which];
    overlays.audio = false;
    overlays.subs = false;
    overlays.source = false;
    overlays.speed = false;
    if (!wasOpen) overlays[which] = true;
  }

  async function ensureSubtitles() {
    if (subtitles.length || subsLoading) return;
    const au = currentAuth();
    if (!au) return;
    subsLoading = true;
    try {
      const { getSubtitles } = await import("../../putio/api");
      // The union: the language the user set in THIS app first, then the
      // put.io web account's list — the query must request the app's
      // preference or the selection below can never find it.
      const res = await getSubtitles(au, file.id, unionSubtitleLanguages(preferredSubLang, subtitleLanguages));
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

  /** Subtitle size, picked directly on the player (issue: "an option to
   *  select subtitle size directly on the player"). Persisted like every
   *  other setting; both rendering paths react to the config — the DOM
   *  overlay via subFontSize, the HLS ::cue via the --cue-size variable on
   *  the video element. */
  function pickSubScale(v: number) {
    config.update((c) => ({ ...c, subScale: v }));
    saveConfig().catch(() => undefined);
    closeOverlays(); // a selection was made — close the dialogue
    platform.toast(
      "Subtitle size: " + (SUB_SCALE_OPTIONS.find((o) => o.v === v)?.label || String(v))
    );
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
      // Every active cue, stacked: a bilingual subtitle ships each line as an
      // overlapping pair (romaji + translation), so one cue per timestamp would
      // leave a whole language invisible.
      const act = cuesAt(subCues, currentTime);
      subText = act.length ? act.map((c) => c.text).filter(Boolean).join("\n") : "";
    }
  }

  /** Close every pick panel. A made selection dismisses its dialogue
   *  (issue: "once I make a selection … close the dialogue"); the Back key
   *  and the scrim use the same single close-list. */
  function closeOverlays() {
    overlays.audio = false;
    overlays.subs = false;
    overlays.source = false;
    overlays.speed = false;
  }

  function onSubPick(i: number) {
    closeOverlays(); // a selection was made — close the panel (issue #2)
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

  function onAudioPick(row: AudioPanelRow) {
    autoHlsTried = false;
    pendingAudioPick = row.key;
    engine?.selectAudioRow(row);
    closeOverlays(); // a selection was made — the result still arrives as a toast
  }

  function onSourcePick(kind: SourceKind) {
    if (kind === source) return; // re-picking the active source is not a selection
    const t = engine?.video.currentTime || 0;
    engine?.setSource(kind, t);
    closeOverlays();
    platform.toast(`Source: ${kind === "original" ? "original file" : kind === "mp4" ? "put.io MP4" : "HLS"}`);
  }

  /** A picked rate: state + engine (setSpeed keeps pitch), close the menu. */
  function pickSpeed(r: number): void {
    speed = r;
    engine?.setSpeed(r);
    closeOverlays();
  }

  /** Menu row label: the rate as a multiple (1 → "1×"). */
  function speedName(r: number): string {
    return `${r}×`;
  }

  /** Menu row hint: only the extremes get one (the middle is self-evident). */
  function speedHint(r: number): string {
    if (r < 1) return "slower";
    if (r > 1) return "faster";
    return "normal";
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
    window.addEventListener("focus", kick);
    document.addEventListener("visibilitychange", onVis);
    unsub = auth.subscribe((v) => (a = v));
    a = get(auth);

    // keep config-derived values live (the store loads asynchronously)
    cfgSub = config.subscribe((v) => {
    cfg = v;
    // setting changed (Settings screen) — the engine re-applies it when
    // the current source's preference hasn't been applied yet, and keeps
    // it for the next source/HLS load
    engine?.setAudioPreference(v.audioLang || null);
  });

    wireRemote();
    // Remote ownership follows the mode: in FULL the Player owns the remote
    // (as it always has). When we dock we simply stop re-asserting — the
    // background screen re-asserts its own handlers from its subscription to
    // the same session store and takes over Back/D-pad/OK. The dock's buttons
    // join the spatial graph like the music strip's, and the background's
    // "activate the focused control" OK drives them.
    videoSub = videoStore.subscribe((v) => {
      if (v && v.mode === "full") wireRemote();
    });
  });

  /** The Player's remote contract (full mode). Extracted so the mode
   *  subscription can re-assert it when the user restores to full. */
  function wireRemote() {
    remote.setHandlers({
      onBack,
      onColor,
      onPlayPause,
      onFastForward,
      onRewind,
      onStop,
      onNavigate: (dir) => {
        wake();
        const a = remote.activeEl;
        if (a && a.isConnected) {
          const ctl = a.getAttribute("data-ctl");
          // ←/→ on the focused bar = seek (not a spatial move)
          if ((dir === "left" || dir === "right") && ctl === "scrub") {
            onScrub(dir);
            return true;
          }
          // ←/→ on the icon/transport ROW is row-local (CONSUMED): the
          // adjacent key, the scrub bar at the row's live end, a no-op at
          // the dead ends — the spatial engine's wide-bar geometry gets
          // it wrong (row-nav.ts; test/row-nav.test.mjs)
          if ((dir === "left" || dir === "right") && isRowKey(ctl)) {
            const target = rowStep(ctl, dir);
            if (target) {
              const el = ctlEl(target);
              if (el) remote.focusEl(el);
            }
            return true;
          }
          // The vertical corridor (plan §2.9: transport → up → scrubber →
          // down → transport) is CONSUMED, not spatial: the transport sits
          // bottom-left (x≈154–340) while the bar's center is mid-screen
          // (x≈640) — outside the engine's ±95% column band, so "up from
          // transport" would find nothing, and "down from the bar" would
          // pick the wrong button by column distance.
          if (dir === "up" && (ctl === "rewind" || ctl === "play" || ctl === "forward")) {
            remote.focusEl(ctlEl("scrub"));
            return true;
          }
          if (dir === "down" && ctl === "scrub") {
            remote.focusEl(ctlEl("play"));
            return true;
          }
          // down from the transport row = the info panel
          if (dir === "down" && (ctl === "rewind" || ctl === "play" || ctl === "forward")) {
            openInfo();
            return true;
          }
        }
      },
      onOK: () => {
        // Same contract as the Library: a spatially focused control wins
        // (cbtns, pick-rows, panel buttons); only with nothing focused does
        // OK do the screen default — toggle play/pause.
        const active = remote.activeEl;
        const action = playerOkAction(!!active && active.isConnected);
        if (action === "activate-focused") {
          remote.clickActive();
        } else {
          engine?.togglePlayPause();
          wake();
        }
      },
    });
  }

  /** The skip for a segment (auto, or the offer's button): the section is
   *  settled either way. End credits (end = null) END the episode — the
   *  normal end-of-video flow (auto-next when enabled, else the finished
   *  state); any other segment seeks to its end. The skipped position saves
   *  no resume — re-opening into the section is the exact thing the skip
   *  exists to avoid. */
  function skipSegNow(idx: number): void {
    const seg = segs[idx];
    if (!seg) return;
    segConsumed = segConsumed.slice();
    segConsumed[idx] = true; // settles the pill too (consumed → pillState null)
    if (seg.end === null) {
      if (engine) {
        engine.finish();
        engine.pause();
      }
      if (canAdvanceVideo()) {
        platform.toast("Credits skipped");
        advanceVideo();
        return;
      }
      platform.toast("Credits skipped — press Back to return to your library");
      return;
    }
    platform.toast(`Skipped ${seg.type}`);
    engine?.seek(seg.end);
  }

  /** The pill's "play through" (Back): settle this section — no re-offer. */
  function playSegThrough(idx: number): void {
    if (idx >= 0 && idx < segs.length) {
      segConsumed = segConsumed.slice();
      segConsumed[idx] = true;
    }
  }

  onDestroy(() => {
    document.body.classList.remove("player-mode");
    window.removeEventListener("focus", kick);
    document.removeEventListener("visibilitychange", onVis);
    unsub?.();
    cfgSub?.();
    videoSub?.();
    // NO remote.clearHandlers() here: the unmount means the session ended,
    // and the background screen already re-asserted its handlers from its
    // subscription to the session store — clearing now would wipe them.
    if (hideTimer) clearTimeout(hideTimer);
    abortMeta(); // in-flight lookups die with the player
    engine?.destroy();
    engine = null;
    for (const s of subtitles) if (s.blobURL) URL.revokeObjectURL(s.blobURL);
    subtitles = [];
  });

  /** D-pad ←/→ while the SCRUBBER is focused: a real ±10s seek (the tested
   *  scrubSeek rule — clamped to [0, dur], live-safe). Consumed in
   *  onNavigate (return true), so the spatial engine doesn't also move. */
  function onScrub(dir: "left" | "right"): void {
    const t = scrubSeek(currentTime, duration, dir === "right" ? 1 : -1, 10);
    if (t !== currentTime && engine) engine.seek(t);
    wake();
  }

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
  $: barPct = scrubThumbPct(currentTime, duration);
  // Buffer bar: how far ahead data is buffered (0 for live — scrubThumbPct
  // already returns 0 for an ∞ duration). Plain reactive value: Svelte
  // style bindings only track identifiers, never bare calls.
  $: bufferPct = scrubThumbPct(bufferEnd, duration);
  // The bubble sits on the INSET track (20px off both hit-area ends), so
  // its position is the same fraction of (100% − 40px) plus the 20px inset.
  $: bubbleLeft = trackLeftCss(barPct);
  // Segment overlays on the bar: where each skippable section sits (segSpans)
  $: segBars = segSpans(segs, duration);

  let barEl: HTMLDivElement;
  // modal panels (BUG 2: side-click dismiss needs the panel rect)
  let errPanelEl: HTMLDivElement;
  let sourcePanelEl: HTMLDivElement;
  let audioPanelEl: HTMLDivElement;
  let subsPanelEl: HTMLDivElement;
  let speedPanelEl: HTMLDivElement;
  let infoPanelEl: HTMLDivElement;
  let pillEl: HTMLDivElement;
  function onBarClick(e: MouseEvent) {
    if (!barEl || !duration) return;
    const r = barEl.getBoundingClientRect();
    // the visible track keeps 20px off both hit-area ends — map against
    // the TRACK (barTrackFraction, shared with the hover preview) so the
    // thumb and the click land on the same spot
    const f = barTrackFraction(e.clientX, r.left, r.width);
    engine?.seek(f * duration);
  }

  // Pointer preview (Magic Remote / mouse): while the pointer is on the bar,
  // the bubble shows the time at the POINTER position — a preview of the
  // seek, and the bar's hover indicator. It is a different indicator from
  // D-pad focus (ring + grown thumb + bubble at the PLAYHEAD showing the
  // current time). null = the pointer is not on the bar.
  let scrubHover: { pct: number; time: number } | null = null;

  // The preview bubble sits on the same inset track as the playhead bubble
  // (the geometry is shared: trackLeftCss).
  $: hoverLeft = trackLeftCss(scrubHover ? scrubHover.pct : 0);

  function onBarMove(e: MouseEvent) {
    if (!barEl || !duration) return; // live: no track, nothing to preview
    const r = barEl.getBoundingClientRect();
    const f = barTrackFraction(e.clientX, r.left, r.width);
    scrubHover = { pct: f * 100, time: f * duration };
  }

  function onBarLeave() {
    scrubHover = null;
  }

  // BUG 2: clicking the dim area around any modal dismisses it with no action.
  // Panels stopPropagation, so a click that lands here is genuinely outside.
  function onPanelScrimClick(e: MouseEvent, panelEl: HTMLElement | null) {
    if (!clickIsOutsideClickTarget(e, panelEl)) return;
    closeOverlays();
  }

  // ---------------- 5-way remote focus wiring ----------------
  // Every interactive control in this screen carries data-focus in the markup,
  // but the engine only sees elements handed to it — without this wiring the
  // D-pad found zero candidates here (dead arrows, dead OK) while pointer
  // clicks worked. Surfaces inside {#if} recreate their DOM on each open, so
  // each is re-scanned whenever it exists (registerAll is idempotent per node;
  // the engine garbage-collects detached nodes in candidates()).

  let controlsEl: HTMLDivElement;
  let playerRootEl: HTMLDivElement;

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

  // Each panel's bind:this ref is the post-commit signal: it is set when the
  // panel is created and cleared (undefined) when it is removed — both AFTER
  // the DOM swap, which is when restoreIfStale can see the old buttons as
  // detached. (A restore driven by the overlay STATE flags runs in the
  // reactive phase, before the removal commits, and sees them still attached.)
  // The base transport gets the SAME re-scan treatment the panels and the
  // dock use: {#if mode === "full"} tears .controls down on every dock and
  // recreates it on restore, and the engine GCs detached nodes from its
  // candidate set — a one-shot registration (a "done" flag that survives
  // the teardown) leaves the D-pad with zero candidates after a
  // full→mini→full round trip (found on the TV: restoring the player
  // silently killed the arrows). Gated on controlsEl alone, registerAll is
  // idempotent per node and the focus placement below is exactly the
  // (re)entry behavior.
  $: {
    if (controlsEl) {
      remote.registerAll(controlsEl);
      // FULL: the video covers the background screen, so any focus still
      // sitting on it is invisible — the player takes the remote outright
      // (play button: the single D-pad target the user can act on).
      // Docked: the background is live, so only restore if focus is stale.
      if (mode === "full") remote.focusEl(ctlEl("play"));
      else restoreIfStale(ctlEl("play"));
    }
  }

  const wasOpen: Record<"source" | "audio" | "subs" | "speed" | "info" | "err", boolean> = {
    source: false,
    audio: false,
    subs: false,
    speed: false,
    info: false,
    err: false,
  };

  /**
   * Shared focus lifecycle for every panel. The bind:this ref is the
   * post-commit signal (set on create, cleared on remove — both AFTER the DOM
   * swap, which is when restoreIfStale can see the old buttons as detached):
   * open → register the panel's rows and focus the natural target; close →
   * restore focus to the control that opened it.
   *   "row"   pick panels: the currently-selected row (pickerDefaultIndex)
   *   "first" modals: the first button
   *   "safe"  the leave guard: the non-primary button (Back is already the
   *           leave path; OK should confirm the safe default)
   */
  function panelFocus(
    el: HTMLDivElement | undefined,
    key: "source" | "audio" | "subs" | "speed" | "info" | "err",
    restoreCtl: string,
    mode: "row" | "first"
  ): void {
    if (!el) {
      if (wasOpen[key]) {
        restoreIfStale(ctlEl(restoreCtl));
        wasOpen[key] = false;
      }
      return;
    }
    const rows = remote.registerAll(el);
    if (!focusInPanel(el)) {
      const idx =
        mode === "row" ? pickerDefaultIndex(rows.map((r) => rowFocusState(r))) : 0;
      if (idx >= 0 && rows[idx]) remote.focusEl(rows[idx]);
    }
    wasOpen[key] = true;
  }

  $: panelFocus(sourcePanelEl, "source", "source", "row");
  $: panelFocus(audioPanelEl, "audio", "audio", "row");
  $: panelFocus(subsPanelEl, "subs", "subs", "row");
  $: panelFocus(speedPanelEl, "speed", "speed", "row");
  // the info panel is NOT scope-trapped (arrows leave it spatially, up to
  // the transport) — but it follows the same open/close focus lifecycle:
  // open → the first action; close → restore the transport
  $: panelFocus(infoPanelEl, "info", "play", "first");
  $: panelFocus(errPanelEl, "err", "play", "first");
  // track lists can change or arrive while a panel is open — the new rows are
  // committed to the DOM after this flush's reactive phase, so re-scan on the
  // next frame (registerAll is idempotent; the engine GCs the old rows)
  $: if (audioPanelEl && audioPanelRows.length) requestAnimationFrame(() => remote.registerAll(audioPanelEl));
  $: if (subsPanelEl && subtitles.length) requestAnimationFrame(() => remote.registerAll(subsPanelEl));
  // the skip button's focus lifecycle — it appears/disappears with the
  // section window. APPEAR: register, then FOCUS — the moment the intro is
  // detected, OK alone = the instant skip (that is the point). The guard:
  // a panel open at that instant owns focus, so the button registers but
  // does not steal from it. DISAPPEAR: if the button still holds focus
  // (the window ended with nothing pressed), hand the remote back to the
  // transport — via restoreIfStale, which never steals focus the user has
  // already moved elsewhere.
  let pillHadFocus = false;
  $: if (pillEl) {
    tick().then(() => {
      remote.registerAll(pillEl);
      if (!anyPanelOpen) {
        remote.focusEl(pillEl);
        pillHadFocus = true;
      } else {
        pillHadFocus = false; // a panel owns focus — the button is visible, passive
      }
    });
  }
  $: if (!pillEl && pillHadFocus) {
    pillHadFocus = false;
    tick().then(() => restoreIfStale(ctlEl("play")));
  }

  // D-pad focus trap: while any panel is open, arrows stay inside the
  // topmost one (later template branch = higher z). FULL mode scopes the
  // graph to the player ROOT — the video covers the (still-mounted)
  // background screen, so its tiles must not be D-pad candidates (a walk
  // off the chrome would drop focus into the invisible library). Docked
  // (mini/micro) passes null: the docked surface and the background are
  // both live, so the whole screen is one graph again. Reads the bind
  // refs, so it re-runs post-commit on open/close and on mode change.
  $: remote.setFocusScope(
    speedPanelEl ||
      subsPanelEl ||
      audioPanelEl ||
      sourcePanelEl ||
      errPanelEl ||
      (mode === "full" ? playerRootEl : null)
  );
</script>

<div bind:this={playerRootEl} class="player" class:full={mode === "full"} class:docked={mode !== "full"} class:micro={mode === "micro"} class:dimmed={dimmed && mode === "micro"} on:mousemove={wake}>
  <video
    bind:this={videoEl}
    class="video"
    class:active={engine}
    playsinline
    preload="auto"
    style="--cue-size: {subFontSize}px"
    on:click={() => {
      engine?.togglePlayPause();
      wake();
    }}
  ></video>


  {#if mode === "full" && activeSub >= 0 && source !== "hls" && subText}
    <div class="subs-cues" class:show={!!subText} style="font-size:{subFontSize}px">{subText}</div>
  {/if}

  {#if mode === "full"}
  <!-- ================= the chrome (TV redesign): title row / scrub row / transport row ================= -->
  <div class="controls" bind:this={controlsEl} class:visible={showControls || pinned} class:dim={paused ? "" : "dim"}>
    <!-- title row: the file's identity left, the trailing icon buttons right (ABOVE the bar) -->
    <div class="title-row">
      <div class="title-block">
        <div class="title-line">
          <span class="title">{tv.title}</span>
          {#each tv.badges as b, bi}
            <span class="badge" class:accent={b.accent}>{b.label}</span>
          {/each}
        </div>
        {#if tv.subtitle}
          <div class="subtitle">{tv.subtitle}</div>
        {/if}
      </div>
      <span class="spacer"></span>
      <button class="icbtn" data-focus data-ctl="source" on:click={() => toggleOverlay("source")} class:sel={overlays.source}>
        <svg viewBox="0 0 24 24" fill="#f2f5f9" aria-hidden="true">
          <rect x="4" y="7.6" width="12" height="2.6" rx="1.3"/>
          <polygon points="15,5.4 20,8.9 15,12.4"/>
          <rect x="8" y="13.8" width="12" height="2.6" rx="1.3"/>
          <polygon points="9,11.6 4,15.1 9,18.6"/>
        </svg>
        <span class="tip">Source · <span class="val">{source === "original" ? "original" : source}</span></span>
      </button>
      <button class="icbtn" data-focus data-ctl="audio" on:click={() => toggleOverlay("audio")} class:sel={overlays.audio}>
        <svg viewBox="0 0 24 24" fill="#f2f5f9" aria-hidden="true">
          <path d="M4 9.4v5.2h3.2L12.4 19V5L7.2 9.4H4z"/>
          <path d="M15.5 9.3a4.2 4.2 0 0 1 0 5.4" fill="none" stroke="#f2f5f9" stroke-width="2" stroke-linecap="round"/>
          <path d="M18.2 7.2a8 8 0 0 1 0 9.6" fill="none" stroke="#f2f5f9" stroke-width="2" stroke-linecap="round"/>
        </svg>
        <span class="tip">Audio · <span class="val">{audioButtonLabel}</span></span>
      </button>
      <button
        class="icbtn"
        data-focus
        data-ctl="subs"
        on:click={() => { if (overlays.subs) toggleOverlay("subs"); else { toggleOverlay("subs"); ensureSubtitles(); } }}
        class:sel={overlays.subs}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="#f2f5f9" stroke-width="2" aria-hidden="true">
          <rect x="3" y="6" width="18" height="12" rx="3"/>
          <text x="12" y="15.4" font-size="8" font-weight="700" text-anchor="middle" fill="#f2f5f9" stroke="none" font-family="inherit">CC</text>
        </svg>
        <span class="tip">CC · <span class="val">{source === "hls" ? (hlsSub === -1 ? "off" : hlsSubTracks[hlsSub]?.label || "on") : (activeSub === -1 ? "off" : subtitles[activeSub]?.language || "off")}</span></span>
      </button>
      {#if !live}
      <button class="icbtn" data-focus data-ctl="speed" on:click={() => toggleOverlay("speed")} class:sel={overlays.speed}>
        <span class="rate">{speedLabel}</span>
        <span class="tip">Speed · <span class="val">{speedLabel}</span></span>
      </button>
      {/if}
    </div>

    <!-- scrub row: the focusable scrubber (D-pad ←/±10s while focused) -->
    <div class="scrub-row">
      <span class="time">{fmtTime(currentTime)}</span>
      <div class="bar" data-focus data-ctl="scrub" bind:this={barEl} on:click={onBarClick} on:mousemove={onBarMove} on:mouseleave={onBarLeave}>
        <div class="bar-track">
          <div class="bar-buffer" style="width: {bufferPct}%"></div>
          {#each segBars as span (span.left + "-" + span.width)}
          <div class="bar-seg" style="left: {span.left}%; width: {span.width}%"></div>
          {/each}
          <div class="bar-fill" style="width: {barPct}%"></div>
          <div class="thumb" style="left: {barPct}%"></div>
        </div>
        <div class="bubble" style="left: {scrubHover ? hoverLeft : bubbleLeft}">{fmtTime(scrubHover ? scrubHover.time : currentTime)}</div>
      </div>
      <span class="time">{live ? "LIVE" : fmtTime(duration)}</span>
    </div>

    <!-- transport row: transport only -->
    <div class="transport-row">
      <button class="tbtn" data-focus data-ctl="rewind" on:click={onRewind}>
        <svg viewBox="0 0 24 24" fill="#f2f5f9" aria-hidden="true">
          <path d="M12 4a8 8 0 1 0 8 8" fill="none" stroke="#f2f5f9" stroke-width="2.2"/>
          <polygon points="12.8,1.2 12.8,6.8 8.2,4"/>
          <text x="12" y="15.6" font-size="8.5" font-weight="700" text-anchor="middle" font-family="inherit">10</text>
        </svg>
      </button>
      <button class="tbtn play" data-focus data-ctl="play" on:click={() => { engine?.togglePlayPause(); wake(); }}>
        {#if paused}
        <svg viewBox="0 0 24 24" fill="#f2f5f9" aria-hidden="true">
          <polygon points="8,5.2 18.8,12 8,18.8"/>
        </svg>
        {:else}
        <svg viewBox="0 0 24 24" fill="#f2f5f9" aria-hidden="true">
          <rect x="7" y="5.2" width="3.6" height="13.6" rx="1.2"/>
          <rect x="13.4" y="5.2" width="3.6" height="13.6" rx="1.2"/>
        </svg>
        {/if}
      </button>
      <button class="tbtn" data-focus data-ctl="forward" on:click={onFastForward}>
        <svg viewBox="0 0 24 24" fill="#f2f5f9" aria-hidden="true">
          <path d="M12 4a8 8 0 1 1-8 8" fill="none" stroke="#f2f5f9" stroke-width="2.2"/>
          <polygon points="11.2,1.2 11.2,6.8 15.8,4"/>
          <text x="12" y="15.6" font-size="8" font-weight="700" text-anchor="middle" font-family="inherit">30</text>
        </svg>
      </button>
    </div>
  </div>

  <!-- the contextual skip button: a button ABOVE the title row (the first
       row of the chrome), RIGHT-ALIGNED — its right edge sits on the
       speed button's right edge (the title row's rightmost icon). The
       player's button material, larger than the transport, with text. It
       stays when the chrome auto-hides (NOT gated on showControls).
       FOCUSED the moment it lands (OK alone = the instant skip); OK =
       skip; Back = play through; leaving the window settles it. -->
  {#if pill}
  <div class="pill" bind:this={pillEl} data-focus data-ctl="skip" on:click={() => skipSegNow(pill.index)}>
    <svg viewBox="0 0 24 24" fill="#f2f5f9" aria-hidden="true">
      <polygon points="5,5 5,19 15.5,12"/>
      <rect x="18" y="5" width="3" height="14" rx="1.5"/>
    </svg>
    <span class="pill-label">{pill.label}</span>
  </div>
  {/if}

  <!-- the buffering spinner (A6: never while paused) — bottom-center,
       ~120px above the transport row; not a focus target. -->
  {#if surface.spinner}
  <div class="buf" aria-hidden="true">
    <div class="spinner"></div>
  </div>
  {/if}

  <!-- the center pause-echo (A5: never on error) — a pointer-only 96px
       play button, dead center; the transport play is the D-pad target. -->
  {#if surface.pauseEcho}
  <div class="pause-echo" on:click={() => { engine?.togglePlayPause(); wake(); }} role="img" aria-label="Paused — press to play">
    <svg viewBox="0 0 24 24" fill="#f2f5f9" aria-hidden="true">
      <polygon points="8,5.2 18.8,12 8,18.8"/>
    </svg>
  </div>
  {/if}

  <!-- ================= the info panel (D-pad down from the transport row) ================= -->
  {#if infoOpen}
  <div class="info" bind:this={infoPanelEl}>
    {#if infoData?.thumbUrl}
      <img class="info-thumb" src={infoData.thumbUrl} alt="" />
    {:else}
      <div class="info-thumb" class:movie={!episodeParse} aria-hidden="true"></div>
    {/if}
    <div class="info-text">
      {#if infoPanel.synopsis}
        <div class="info-syn">{infoPanel.synopsis}</div>
      {/if}
      {#if infoPanel.details.length}
        <div class="info-details">
          {#if infoData?.rating != null}
            <svg class="d-star" viewBox="0 0 24 24" fill="#f2f5f9" aria-hidden="true">
              <path d="M12 2.6l2.85 5.8 6.4.93-4.63 4.5 1.1 6.37L12 17.2l-5.72 3-1.1-6.37-4.63-4.5 6.4-.93z"/>
            </svg>
          {/if}
          {#each infoPanel.details as part, pi (part)}
            {#if pi > 0}<span class="sep">·</span>{/if}
            <span>{part}</span>
          {/each}
        </div>
      {/if}
      <div class="info-actions">
        {#each infoPanel.actions as act, ai (act.id)}
          <button class="abtn" data-focus on:click={() => runInfoAction(act.id)}>
            {#if act.id === "restart"}
              <svg viewBox="0 0 24 24" fill="#f2f5f9" aria-hidden="true">
                <rect x="4" y="5" width="3" height="14" rx="1.5"/>
                <polygon points="20,5 20,19 9.5,12"/>
              </svg>
              {act.label}
            {:else}
              <svg viewBox="0 0 24 24" fill="#f2f5f9" aria-hidden="true">
                <polygon points="5,5 5,19 15.5,12"/>
                <rect x="18" y="5" width="3" height="14" rx="1.5"/>
              </svg>
              <span>{act.label.split(" · ")[0]}</span>
              <span class="val2">{act.label.split(" · ")[1]}</span>
            {/if}
          </button>
        {/each}
      </div>
    </div>
  </div>
  {/if}

  <!-- ================= overlays ================= -->

  <!-- a pick menu open: a click that lands anywhere else misses every
       control, so it dismisses the menu — the catcher is transparent
       (no dim, no visible surface), above the chrome (z 20), below the
       menu (z 30). Color keys / D-pad are key events: unaffected. -->
  {#if overlays.source || overlays.audio || overlays.subs || overlays.speed}
  <div class="menu-scrim" on:click={closeOverlays}></div>
  {/if}

  {#if error}
    <div class="center-panel" on:click={(e) => onPanelScrimClick(e, errPanelEl)}>
      <div class="panel err-panel" bind:this={errPanelEl} on:click={(e) => e.stopPropagation()}>
        <p class="err-title">Playback problem</p>
        <p class="muted">{error}</p>
        <div class="row" style="margin-top: 20px">
          <button class="btn primary" data-focus on:click={() => { error = null; engine?.setSource(source); }}>
            Retry
          </button>
          <button class="btn ghost" data-focus on:click={closeVideo}>Back to library</button>
        </div>
      </div>
    </div>
  {/if}

  {#if overlays.source}
    <div class="menu source" bind:this={sourcePanelEl}>
      <p class="menu-title">Playback source</p>
      {#each sourceOptions as opt (opt.kind)}
        <button
          class="row"
          class:sel={source === opt.kind}
          class:disabled={!opt.available}
          data-focus
          data-focus-disabled={!opt.available ? "true" : ""}
          on:click={() => opt.available && onSourcePick(opt.kind)}
        >
          <span class="label">{#if source === opt.kind}<span class="dot"></span>{/if}{opt.label}</span>
          <span class="hint" class:ok={source === opt.kind}>
            {source === opt.kind ? "now playing" : opt.available ? opt.hint : opt.hint || "unavailable"}
          </span>
        </button>
      {/each}
    </div>
  {/if}

  {#if overlays.audio}
    <div class="menu audio" bind:this={audioPanelEl}>
      <p class="menu-title">Audio track</p>
      {#if audioPanelRows.length === 0}
        <p class="muted pad">No audio track information for this file.</p>
      {:else}
        <p class="muted small pad menu-sub">
          {audioPanelRows.length === 1
            ? `1 audio track in this file${audioPanelRows[0].codec ? ` (${audioPanelRows[0].codec.toUpperCase()})` : ""}`
            : `${audioPanelRows.length} audio tracks in this file`}
        </p>
        {#each audioPanelRows as row (row.key)}
          <button
            class="row"
            class:sel={audioActiveKey === row.key}
            data-focus
            data-focus-disabled={audioSwitching ? "true" : ""}
            on:click={() => !audioSwitching && onAudioPick(row)}
          >
            <span class="label">{#if audioActiveKey === row.key}<span class="dot"></span>{/if}{row.label}</span>
            <span class="hint" class:ok={audioActiveKey === row.key}>
              {panelRowHint(row, {
                active: audioActiveKey === row.key,
                switching: audioSwitching && pendingAudioPick === row.key,
              })}
            </span>
          </button>
        {/each}
      {/if}
    </div>
  {/if}

  {#if overlays.subs}
    <div class="menu subs" bind:this={subsPanelEl}>
      <p class="menu-title">Subtitles</p>
      {#if source === "hls"}
        <button class="row" class:sel={hlsSub === -1} data-focus on:click={() => onSubPick(-1)}>
          <span class="label">{#if hlsSub === -1}<span class="dot"></span>{/if}Off</span>
          <span class="hint" class:ok={hlsSub === -1}>{hlsSub === -1 ? "on" : ""}</span>
        </button>
        {#each hlsSubTracks as t, i (t.id)}
          <button class="row" class:sel={hlsSub === i} data-focus on:click={() => onSubPick(i)}>
            <span class="label">{#if hlsSub === i}<span class="dot"></span>{/if}{t.label}</span>
            <span class="hint" class:ok={hlsSub === i}>{hlsSub === i ? "on" : ""}</span>
          </button>
        {/each}
        {#if hlsSubTracks.length === 0}
          <p class="muted pad">No subtitle tracks in this stream.</p>
        {/if}
      {:else}
        <button class="row" class:sel={activeSub === -1} data-focus on:click={() => onSubPick(-1)}>
          <span class="label">{#if activeSub === -1}<span class="dot"></span>{/if}Off</span>
          <span class="hint" class:ok={activeSub === -1}>{activeSub === -1 ? "on" : ""}</span>
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
            <button class="row" class:sel={activeSub === i} data-focus on:click={() => onSubPick(i)}>
              <span class="label">{#if activeSub === i}<span class="dot"></span>{/if}{subLabel(sub)}</span>
              <span class="hint" class:ok={activeSub === i}>{activeSub === i ? "on" : ""}</span>
            </button>
          {/each}
        {/if}
      {/if}
      <p class="muted small pad menu-sub" style="margin-top: 16px">Text size</p>
      {#each SUB_SCALE_OPTIONS as o (o.v)}
        <button class="row" class:sel={subScale === o.v} data-focus on:click={() => pickSubScale(o.v)}>
          <span class="label">{#if subScale === o.v}<span class="dot"></span>{/if}{o.label}</span>
          <span class="hint" class:ok={subScale === o.v}>{subScale === o.v ? "on" : ""}</span>
        </button>
      {/each}
    </div>
  {/if}

  {#if overlays.speed}
    <div class="menu speed" bind:this={speedPanelEl}>
      <p class="menu-title">Playback speed</p>
      {#each SPEED_OPTIONS as r (r)}
        <button class="row" class:sel={speed === r} data-focus on:click={() => pickSpeed(r)}>
          <span class="label">{#if speed === r}<span class="dot"></span>{/if}{speedName(r)}</span>
          <span class="hint">{speed === r ? "now" : speedHint(r)}</span>
        </button>
      {/each}
    </div>
  {/if}

  <!-- color legend: physical keys on the remote -->
  <div class="color-legend legend-player" class:visible={showControls}>
    <div class="cl"><span class="dot c4"></span>Source</div>
    <div class="cl"><span class="dot c2"></span>Audio</div>
    <div class="cl"><span class="dot c3"></span>Subs</div>
    <div class="cl"><span class="dot c1"></span>Play</div>
  </div>
  {/if}

  {#if mode !== "full"}
  <!-- ================= the dock (mini / micro) ================= -->
  <div class="dock" id="vdock" bind:this={dockEl}>
    <button class="dock-btn" bind:this={dockPrev} data-focus aria-label="Previous video" on:click={() => stepVideo(-1)}>«</button>
    <button class="dock-btn play" data-focus aria-label={paused ? "Play" : "Pause"} on:click={() => engine?.togglePlayPause()}>{paused ? "▶" : "❚❚"}</button>
    <button class="dock-btn" bind:this={dockNext} data-focus aria-label="Next video" on:click={() => stepVideo(1)}>»</button>
    {#if mode === "mini"}
      <button class="dock-btn" data-focus aria-label="Restore to full" on:click={() => setVideoMode("full")}>⛶</button>
      <button class="dock-btn" data-focus aria-label="Make it micro" on:click={() => setVideoMode("micro")}>◱</button>
    {:else}
      <button class="dock-btn" data-focus aria-label="Restore to mini" on:click={() => setVideoMode("mini")}>▭</button>
    {/if}
    <button class="dock-btn close" data-focus aria-label="Close player" on:click={closeVideo}>✕</button>
  </div>
  {/if}
</div>

<style>
  /* The frame's geometry (position, insets, size, background, z-index) is
     owned by theme.css (.player ladder) — a scoped rule here would tie at
     (0,2,0) and win by source order (the top-left/blank-screen bug). */
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
    /* follows the subtitle size picked on the player (--cue-size is set on
       the video element from subScale; the 30px fallback is the default) */
    font-size: var(--cue-size, 30px);
    text-shadow: 0 2px 4px rgba(0, 0, 0, 0.9), 0 0 18px rgba(0, 0, 0, 0.6);
  }
  /* NOTE: the cue overlay is ".subs-cues", NOT ".subs" — a bare ".subs"
     also matches the floating menu's ".menu subs" panel and silently
     stole its positioning (centered) AND set its opacity to 0 (the menu
     rendered invisible on the TV). Keep them distinct. */
  .subs-cues {
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
  .subs-cues.show {
    opacity: 1;
  }
  .subs-cues:not(.show) {
    opacity: 0;
  }
  /* One bottom-anchored surface, three rows (the mockup is the reference).
     All text ≥24px (TV scale); icons are SVG — no glyph spans. */
  .controls {
    position: absolute;
    left: 0;
    right: 0;
    bottom: 0;
    padding: 40px 72px 64px;
    background: linear-gradient(transparent, rgba(0, 0, 0, 0.55) 34%, rgba(0, 0, 0, 0.82) 100%);
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
  .title-row {
    display: flex;
    align-items: center;
  }
  .title-block {
    min-width: 0;
  }
  .title-line {
    display: flex;
    align-items: center;
  }
  .title-line > :not(:first-child) {
    margin-left: 18px;
  }
  .title {
    font-size: 48px;
    font-weight: 700;
    letter-spacing: -0.01em;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .badge {
    padding: 5px 16px;
    border-radius: 999px;
    font-size: 24px;
    font-weight: 600;
    letter-spacing: 0.04em;
    background: var(--surface-2);
    color: var(--text-2);
  }
  .badge.accent {
    background: var(--accent-dim-solid);
    color: var(--accent-2);
  }
  .subtitle {
    font-size: 26px;
    color: var(--text-2);
    margin-top: 6px;
  }
  .spacer {
    flex: 1;
  }
  /* trailing controls: icon-only circles; the name+value tip is visible
     ONLY while the icon is focused (it floats above the icon) */
  .icbtn {
    width: 64px;
    height: 64px;
    border-radius: 50%;
    background: rgba(255, 255, 255, 0.1);
    display: flex;
    align-items: center;
    justify-content: center;
    position: relative;
    border: 0;
    cursor: pointer;
  }
  .icbtn + .icbtn {
    margin-left: 20px;
  }
  .icbtn svg {
    width: 28px;
    height: 28px;
  }
  .icbtn .rate {
    font-size: 24px;
    font-weight: 700;
    letter-spacing: -0.01em;
    color: var(--text);
  }
  .icbtn .tip {
    position: absolute;
    bottom: 76px;
    left: 50%;
    transform: translateX(-50%);
    background: var(--surface-2);
    border: 1px solid var(--line-strong);
    border-radius: 10px;
    padding: 8px 16px;
    white-space: nowrap;
    font-size: 24px;
    color: var(--text);
    box-shadow: var(--elev-md);
    opacity: 0;
    pointer-events: none;
    transition: opacity var(--t-slow);
  }
  .icbtn .tip .val {
    color: var(--accent-2);
  }
  /* FOCUS-STATE RULES: :global() is REQUIRED — the Svelte 4 compiler drops
     any selector referencing an attribute absent from the markup, and the
     remote engine sets data-state at runtime (never in the markup). The
     wrapped classes are player-unique, so nothing leaks to other screens. */
  :global(.icbtn[data-state="active"]) {
    box-shadow: var(--focus-shadow);
    transform: scale(1.06);
    background: rgba(255, 255, 255, 0.16);
  }
  :global(.icbtn[data-state="active"] .tip),
  :global(.icbtn.sel .tip) {
    opacity: 1;
  }
  .icbtn.sel {
    background: var(--accent-dim-solid);
    box-shadow: inset 0 0 0 2px var(--accent);
  }
  /* scrub row — 80px hit area; the track keeps 20px off the hit-area ends
     so the focus outline (at the hit-area edge) never touches the line */
  .scrub-row {
    display: flex;
    align-items: center;
  }
  .time {
    font-variant-numeric: tabular-nums;
    font-size: 28px;
    color: var(--text-2);
    min-width: 100px;
    text-align: center;
  }
  .scrub-row .time:first-child {
    margin-right: 36px;
  }
  .scrub-row .time:last-child {
    margin-left: 36px;
  }
  .bar {
    position: relative;
    flex: 1;
    height: 80px;
    border-radius: 40px;
    cursor: pointer;
    /* the theme's [data-focus] reserves a 3px focus border — the bar's
       focus is the inset ring instead, and the track must sit 20px from
       the bar's VISUAL edge, not from inside a border */
    border: 0;
  }
  .bar-track {
    position: absolute;
    top: 50%;
    left: 20px;
    right: 20px;
    transform: translateY(-50%);
    height: 6px;
    border-radius: 3px;
    background: rgba(255, 255, 255, 0.28);
  }
  .bar-buffer {
    position: absolute;
    left: 0;
    top: 0;
    height: 100%;
    background: rgba(255, 255, 255, 0.5);
    border-radius: 3px;
    transition: width 200ms linear;
  }
  .bar-seg {
    /* the skippable segments: the warn yellow (the subs-key hue, --warn)
       at the same low alpha as the old tint — a hue distinct from the blue
       progress fill, so the region reads as its own thing on the track.
       Below the fill: played sections stay marked, the fill never fights them */
    position: absolute;
    top: 0;
    height: 100%;
    border-radius: 3px;
    background: rgba(245, 184, 79, 0.30);
  }
  .bar-fill {
    position: absolute;
    left: 0;
    top: 0;
    height: 100%;
    background: var(--accent);
    border-radius: 3px;
    transition: width 200ms linear;
  }
  .thumb {
    position: absolute;
    top: 50%;
    width: 16px;
    height: 16px;
    transform: translate(-50%, -50%);
    border-radius: 50%;
    background: var(--scrub-thumb);
    box-shadow: var(--scrub-thumb-shadow);
  }
  .bubble {
    position: absolute;
    bottom: 94px;
    transform: translateX(-50%);
    background: var(--surface-2);
    border: 1px solid var(--line-strong);
    border-radius: 10px;
    padding: 10px 18px;
    font-size: 24px;
    font-weight: 600;
    color: var(--text);
    font-variant-numeric: tabular-nums;
    box-shadow: var(--elev-md);
    display: none;
    pointer-events: none;
  }
  /* the FOCUSED bar: the outline hugs the 80px hit-area edge (2px inset
     shadow) — the line ends sit 20px away from it, on both sides */
  :global(.bar[data-state="active"]) {
    /* the theme's generic focus scales 1.05 — an 80px bar jumping 4px is
       a flinch, not a focus; the ring + the thumb growth ARE the focus */
    transform: none;
    box-shadow: inset 0 0 0 2px var(--accent-ring);
  }
  :global(.bar[data-state="active"] .thumb) {
    width: 24px;
    height: 24px;
    box-shadow: var(--focus-shadow);
  }
  :global(.bar[data-state="active"] .bubble) {
    display: block;
  }
  /* the POINTER on the bar (Magic Remote): the bubble IS the hover
     indicator — it previews the pointer position (its left/time come
     from scrubHover in the markup). Deliberately no ring or shadow here:
     those are the D-pad focus's indicators. */
  :global(.bar:hover .bubble) {
    display: block;
  }
  /* transport row: transport only */
  .transport-row {
    display: flex;
    align-items: center;
  }
  .tbtn {
    width: 64px;
    height: 64px;
    border-radius: 50%;
    background: rgba(255, 255, 255, 0.1);
    display: flex;
    align-items: center;
    justify-content: center;
    position: relative;
    border: 0;
    cursor: pointer;
  }
  .tbtn svg {
    width: 28px;
    height: 28px;
  }
  .tbtn.play {
    width: 72px;
    height: 72px;
  }
  .tbtn.play svg {
    width: 32px;
    height: 32px;
  }
  .tbtn + .tbtn {
    margin-left: 20px;
  }
  :global(.tbtn[data-state="active"]) {
    box-shadow: var(--focus-shadow);
    transform: scale(1.06);
    background: rgba(255, 255, 255, 0.16);
  }
  /* the info panel: full-width minus the chrome gutters, 24px above the
     chrome. It says what the title view CAN'T — synopsis + details +
     actions (no series/episode repeat; identity stays in the title view).
     NOT scope-trapped: arrows leave it spatially (up → the transport). */
  .info {
    position: absolute;
    z-index: 50;
    left: 72px;
    right: 72px;
    bottom: 419px;
    background: var(--bg-raised);
    border: 1px solid var(--line-strong);
    border-radius: var(--r-xl);
    box-shadow: var(--elev-lg);
    padding: 32px 40px;
    display: flex;
    align-items: center;
  }
  .info-thumb {
    width: 384px;
    height: 216px;
    flex: none;
    border-radius: var(--r-md);
    border: 1px solid var(--line-strong);
    background: var(--ph-anime-glow), var(--ph-anime);
    object-fit: contain; /* native aspect ratio — a poster must not stretch into the 16:9 box */
  }
  .info-thumb.movie {
    background: var(--ph-movie-glow), var(--ph-movie);
  }
  .info-text {
    margin-left: 36px;
    min-width: 0;
  }
  .info-syn {
    font-size: 26px;
    color: var(--text-2);
    line-height: 1.5;
    display: -webkit-box;
    -webkit-line-clamp: 4;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .info-details {
    display: flex;
    align-items: center;
    margin-top: 18px;
    font-size: 24px;
    color: var(--text-3);
  }
  .d-star {
    width: 22px;
    height: 22px;
    margin-right: 8px;
    flex: none;
  }
  .sep {
    padding: 0 12px;
    color: rgba(255, 255, 255, 0.35);
  }
  .info-actions {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-top: 22px;
  }
  .abtn {
    display: flex;
    align-items: center;
    height: 60px;
    padding: 0 24px;
    border-radius: 999px;
    background: var(--surface-2);
    font-size: 24px;
    font-weight: 600;
    color: var(--text);
    /* focus is the glow, not the theme's 3px hard border */
    border: 0;
  }
  .abtn svg {
    width: 22px;
    height: 22px;
    margin-right: 12px;
    flex: none;
  }
  .abtn .val2 {
    margin-left: 10px;
    color: var(--text-2);
    font-weight: 400;
  }
  :global(.abtn[data-state="active"]) {
    box-shadow: var(--focus-shadow);
    background: var(--accent-dim-solid);
  }
  /* the contextual skip BUTTON (L2): the player's own button material
     (same family as .icbtn/.tbtn — translucent white disc, the focus
     triad glow + scale + brighter fill), but a LARGER pill, because it
     carries icon + text. Its OWN surface — stays when the chrome
     auto-hides (NOT gated on showControls). ABOVE the title row, the
     first row of the chrome, right edge on the speed button's edge: the
     title row's top edge sits ~355 from the bottom (the tall case: title
     48 + subtitle 26 + margin) → + 22 gap → bottom 377; right 72 = the
     controls' right padding (where the row's icons end). */
  .pill {
    position: absolute;
    right: 72px;
    bottom: 377px;
    z-index: 25;
    display: flex;
    align-items: center;
    height: 80px;
    padding: 0 28px;
    border-radius: 999px;
    background: rgba(255, 255, 255, 0.1);
    box-shadow: var(--elev-md);
    cursor: pointer;
    /* focus is the glow, not the theme's 3px hard border */
    border: 0;
  }
  .pill svg {
    width: 32px;
    height: 32px;
    margin-right: 12px;
    flex: none;
  }
  .pill-label {
    font-size: 30px;
    font-weight: 600;
    color: var(--text);
    white-space: nowrap;
  }
  :global(.pill[data-state="active"]) {
    /* the triad, mirroring .tbtn — a right-anchored button scales from
       its own center, so no position transform to keep */
    transform: scale(1.06);
    background: rgba(255, 255, 255, 0.16);
    box-shadow: var(--focus-shadow);
  }
  /* buffering (A6): 36px spinner, bottom-center, ~120px above the
     transport row; above the chrome band, not a focus target */
  .buf {
    position: absolute;
    left: 50%;
    bottom: 256px;
    transform: translateX(-50%);
    z-index: 25;
    pointer-events: none;
  }
  .buf .spinner {
    width: 36px;
    height: 36px;
    border-width: 3px;
  }
  /* paused (A5): 96px circular play button, dead center, pointer-only
     (the transport play is the single D-pad target); soft glow */
  .pause-echo {
    position: absolute;
    left: 50%;
    top: 50%;
    transform: translate(-50%, -50%);
    z-index: 15;
    width: 96px;
    height: 96px;
    border-radius: 50%;
    background: rgba(8, 10, 14, 0.55);
    box-shadow: var(--elev-lg), 0 0 40px rgba(77, 163, 255, 0.18);
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
  }
  .pause-echo svg {
    width: 40px;
    height: 40px;
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
  .err-panel {
    width: 620px;
    padding: 28px 32px;
    max-height: 800px;
    overflow-y: auto;
  }
  .err-title {
    font-size: var(--fs-h2);
    font-weight: 700;
    margin-bottom: 18px;
    color: var(--danger);
  }
  /* NON-MODAL floating menus: no scrim, no dim. They float above the
     chrome (right 72px = over the trailing icon group; 24px above its
     top), the opener icon stays .sel, arrows are trapped inside. */
  /* the pick menus are click-modal: a transparent full-surface catcher
     (above the chrome, below the menu) closes them on any side-click */
  .menu-scrim {
    position: absolute;
    top: 0;
    right: 0;
    bottom: 0;
    left: 0;
    z-index: 25;
    background: transparent;
  }

  .menu {
    position: absolute;
    right: 72px;
    bottom: 419px;
    z-index: 30;
    background: var(--surface-2);
    border: 1px solid var(--line-strong);
    border-radius: 16px;
    box-shadow: var(--elev-md);
    padding: 24px;
    /* The subs menu can outgrow the headroom above the chrome (N track
       rows + the text-size section: ~970px with 2 tracks, 661px of
       1080p headroom) — without a cap its rows render above the top of
       the screen, focused row included. Cap at the headroom (443 = 24px
       top margin + 419px anchor) and scroll: the remote engine already
       scrollIntoView's the focused element, so the focused row is always
       visible without a scroll key. */
    max-height: calc(100vh - 443px);
    overflow-y: auto;
  }
  .menu::-webkit-scrollbar {
    display: none;
  }
  .menu.source {
    width: 640px;
  }
  .menu.audio {
    width: 560px;
  }
  .menu.subs {
    width: 560px;
  }
  .menu.speed {
    width: 480px;
  }
  .menu-title {
    font-size: 32px;
    font-weight: 700;
    margin-bottom: 18px;
  }
  /* menu rows (scoped: .row is also the error modal's flex layout helper) */
  .menu .row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    width: 100%;
    padding: 18px 20px;
    margin-bottom: 10px;
    border-radius: 12px;
    background: rgba(255, 255, 255, 0.06);
    border: 2px solid transparent;
    font-size: 28px;
    text-align: left;
  }
  .menu .row:last-child {
    margin-bottom: 0;
  }
  :global(.menu .row[data-state="active"]) {
    border-color: var(--accent);
    background: rgba(255, 255, 255, 0.1);
  }
  .menu .row.sel {
    border-color: var(--accent);
    background: var(--accent-dim-solid);
  }
  .menu .row.disabled {
    opacity: 0.4;
  }
  .menu .row .label {
    display: flex;
    align-items: center;
    font-size: 28px;
    font-weight: 600;
  }
  .menu .row .label .dot {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    background: var(--accent);
    margin-right: 14px;
  }
  .menu .row .hint {
    color: var(--text-3);
    font-size: 24px;
  }
  .menu .row .hint.ok {
    color: var(--accent-2);
    font-weight: 700;
  }
  .menu-sub {
    font-size: 24px;
  }
  .pad {
    padding: 8px 4px 16px;
  }
  .small {
    font-size: 24px; /* TV scale: menu helper text never below 24px */
  }
  .muted {
    color: var(--text-2);
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
