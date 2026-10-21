import type { Auth } from "./api";
import { hlsURL, mp4StreamURL, streamURL, getFile } from "./api";
import { applyAudioTrack, planAudioSwitch, enabledIndexOf, AUDIO_SWITCH_DANCE_ATTEMPT } from "./audio-switch";
import { matchLang } from "./config";
import {
  mergeAudioRows,
  activeRowKey,
  audioStreamsFromMediaInfo,
  pickHlsAudioTrackIndex,
  type AudioPanelRow,
  type MetaAudioStream,
  type NativeAudioTrack,
} from "./track-merge";
import { parseHlsAudioRenditions, type HlsAudioRendition } from "./hls-manifest";
import { freshSkip, type Seg } from "./segments";
import { autoResumeTarget } from "./resume";
import { probeHeader, type Chapter, type AssTrackInfo } from "./probe";
import { fetchCues } from "./cues";
import { routeRawAss, type RawAssRoute } from "./ass-route";
import { multiRangeReader } from "./multirange";
import type { AssStyleTable } from "./substyle";
import Hls from "hls.js";

/** The segment lookup is async: when it lands AFTER the metadata, the
 *  fresh skip still applies only while the playhead is this close to the
 *  start of the content — further along, the user is already in the
 *  episode, and yanking them back is the bigger sin. */
const FRESH_LATE_GRACE = 5;

export type SourceKind = "original" | "mp4" | "hls";

export interface SourceOption {
  kind: SourceKind;
  label: string;
  available: boolean;
  hint?: string;
}

export interface AudioTrackInfo {
  id: number;
  label: string;
  lang?: string;
}

export interface SubtitleTrackInfo {
  id: number;
  label: string;
  lang?: string;
  /** HLS only: the WebVTT rendition's URL — the overlay fetches and parses
   *  it itself (m00906: one rendering pipeline for every source). */
  url?: string;
}

export interface MediaState {
  source: SourceKind;
  duration: number;
  currentTime: number;
  paused: boolean;
  buffered: number;
  buffering: boolean;
  error: string | null;
  audioTracks: AudioTrackInfo[];
  audioTrack: number;
  /** The webview vetoed the last native audio-track switch (known MKV quirk). */
  audioSwitchFailed?: boolean;
  /** Why the last pick could not land (undecodable codec, no rendition, …). */
  audioFailReason?: string;
  /** The configured audio preference named a language this file has no
   *  track for — an honest announcement (the old behavior was silence).
   *  One message per file open. */
  audioPrefMiss?: string;
  /** One-shot: a fresh start skipped past the leading segments (their
   *  types, "intro + recap") — the Player turns this into the toast. */
  skippedSeg?: string;
  /** Mid-playback stalls on the CURRENT source (waiting events after the
   *  first frame). Reset to 0 on every source load. The Player turns this
   *  into the once-per-file smoother-stream advisory (putio/stall). */
  stalls?: number;
  /** An audio switch (incl. the reload-dance escalation) is in flight. */
  audioSwitching?: boolean;
  /** Who asked for the last pick — the user, or the configured preference. */
  audioPickKind?: "user" | "preference";
  /** The index the last pick targeted (terminal patches). */
  audioPickIndex?: number;
  /** Merged panel model: one row per audio stream in the FILE (native +
   *  media_info + HLS renditions). The panel renders these, not audioTracks. */
  audioPanelRows: AudioPanelRow[];
  /** key of the row that is actually on (null = none matched). */
  audioActiveKey: string | null;
  /** HLS only: WebVTT renditions surfaced on the video's textTracks (MKV embedded subs). */
  subtitleTracks: SubtitleTrackInfo[];
  /** Embedded ASS style tables from the ORIGINAL stream's MKV header
   *  (bounded probe, best-effort). The subtitle overlay renders per style
   *  (colour/outline/position); empty = the plain unstyled overlay. */
  subStyleTables?: AssStyleTable[];
  /** ASS subtitle tracks the container declares (num/name/lang + CodecPrivate)
   *  — maps put.io's converted entries onto the Matroska track numbers the
   *  row-routed raw-ASS upgrade (probeRawAss) fetches. */
  subAssTracks?: AssTrackInfo[];
  /** Chapters from the same header probe (start/end seconds, title). */
  subChapters?: Chapter[];
  live: boolean;
}

type HlsLike = InstanceType<typeof Hls>;

/**
 * Drives one <video> element: source selection with fallback chain,
 * audio-track switching (native + hls.js), state for the control overlay.
 */
export class MediaEngine {
  video: HTMLVideoElement;
  /** Embedded ASS style tables (MKV header probe; [] = none/failed). */
  subStyleTables: AssStyleTable[] = [];
  /** ASS subtitle track table (MKV header probe; [] = none/failed). */
  subAssTracks: AssTrackInfo[] = [];
  /** MKV chapters from the header probe (start/end seconds, title). */
  subChapters: Chapter[] = [];
  /** Segment payload start (header probe) — CueClusterPosition + segStart = file offset. */
  segStart: number = -1;
  /** TimestampScale (header probe; 1 000 000 = ms per unit, the common case). */
  scale: number = 1_000_000;
  /** Cues element file offset (header probe; null = none → row 3). */
  cuesFileOffset: number | null = null;
  source: SourceKind = "original";
  private file: { id: number; is_mp4_available?: boolean; start_from?: number; size?: number };
  private auth: Auth;
  private hls: HlsLike | null = null;
  private unsub: (() => void)[] = [];
  private cleaning = false;
  private resumeTimer: number | null = null;
  private lastSaved = 0;
  private onState: (s: Partial<MediaState>) => void;
  private onSourceChange: (s: SourceKind) => void;
  private onEnded: () => void;
  private lastErrorAt = 0;
  /** Panel-model inputs (see track-merge.ts): what the TV exposes, what the
   *  file contains (put.io media_info), and what the put.io stream offers. */
  private nativeTracks: NativeAudioTrack[] = [];
  private metaAudio: MetaAudioStream[] = [];
  private hlsRenditions: HlsAudioRendition[] = [];
  /** True while an audio switch escalation is running (no re-entrant picks). */
  private switchingAudio = false;
  /** true while the reload dance owns the element (its src strip fires an
   * element error that onError must not treat as a dead stream) */
  private dancing = false;
  /** a pause the USER asked for (blue key) — the engine never auto-resumes
   * this one. Cleared by play() and by a fresh source load. */
  private userPaused = false;
  /** Mid-playback stall count for the CURRENT source (reset per load).
   *  The native buffer can't be grown from HTML5 — the count is what lets
   *  the app say so honestly. */
  private stalls = 0;
  /** The current source delivered its first frame (a waiting event before
   *  this is a normal load, not a stall). Reset per source load. */
  private everPlayed = false;
  /** The playhead's position on the PREVIOUS tick — the ratchet baseline
   *  (onTime clears a stuck buffering when the time advances past it).
   *  Reset per source load to the load target: a resume that lands at a
   *  saved position is not "advancing". */
  private lastTickTime = 0;
  /** set when a failed dance already triggered the same-source restore —
   * the restore is one chance, not a loop (if IT dies, the normal
   * fallback chain takes over) */
  private recoveredAfterDance = false;
  /** The episode's segments from TheIntroDB (the Player feeds them as the
   *  lookup resolves). null = nothing known — the fresh-start skip is
   *  inert. Survives source switches: same episode, same shape. */
  private segs: Seg[] | null = null;
  /** The video has ended — naturally, or the credits were skipped. The
   *  current position is no longer worth resuming (a skip lands INSIDE the
   *  credits; re-opening into them is the exact thing the skip avoids). */
  private finished = false;
  /** configured preferred audio language (the Player mirrors the setting). */
  private prefLang: string | null = null;
  /** the preference has been applied for THIS source (once per source load). */
  private prefApplied = false;
  // The metadata fetch (media_info) is still in flight — a preference that
  // reaches its first real track list now must WAIT for the file's real
  // titles/codes before matching (the webview's own labels can't be
  // trusted: EAAAO on the C1 exposes neither codes nor titles).
  private prefDefer = false;
  private metaSettled = false;
  /** who asked for the escalation in flight (terminal patches). */
  private pickKind: "user" | "preference" = "user";
  /** The language the user last picked (native or HLS row) — any entry
   *  into the put.io stream preselects this language (MANIFEST_PARSED). */
  private lastAudioLang: string | null = null;
  private pendingSeek: number | null = null;
  /** Auto-resume applied at most once per engine (onMeta may fire again). */
  private resumeApplied = false;

  constructor(
    video: HTMLVideoElement,
    file: { id: number; is_mp4_available?: boolean; start_from?: number },
    auth: Auth,
    opts: {
      onState?: (s: Partial<MediaState>) => void;
      onSourceChange?: (s: SourceKind) => void;
      onEnded?: () => void;
    } = {}
  ) {
    this.video = video;
    this.file = file;
    this.auth = auth;
    this.onState = opts.onState || (() => {});
    this.onSourceChange = opts.onSourceChange || (() => {});
    this.onEnded = opts.onEnded || (() => {});

    this.bindEvents();
    this.unsub.push(() => this.unbindEvents());
    // The file's real audio streams (put.io media_info) are the panel's
    // source of truth; for multi-audio files the HLS manifest is prefetched
    // so the "via put.io stream" rows are real. Both are non-fatal — the
    // panel degrades to the native list when either is unavailable.
    this.metaSettled = false;
    this.prefDefer = false;
    void this.fetchMediaInfo();
    void this.fetchSubtitleHeader();
  }

  private v = (): WebOSHTMLVideoElement => this.video as WebOSHTMLVideoElement;

  sourceOptions(): SourceOption[] {
    const mp4ok = !!this.file.is_mp4_available;
    return [
      {
        kind: "original",
        label: "Original",
        available: true,
        hint: "as uploaded (mkv/mp4)",
      },
      {
        kind: "mp4",
        label: "put.io MP4",
        available: mp4ok,
        hint: mp4ok ? "transcoded, fast start" : "not available (converting)",
      },
      {
        kind: "hls",
        label: "HLS",
        available: true,
        hint: "adaptive, good for live",
      },
    ];
  }

  setSource(kind: SourceKind, startAt?: number, silent = false): void {
    this.teardownHls();
    this.source = kind;
    this.stalls = 0; // a new source load is a fresh stall record
    this.everPlayed = false;
    if (!silent) this.onSourceChange(kind);
    this.onState({ error: null, buffering: true, source: kind, stalls: 0 });
    const v = this.v();
    const t = startAt ?? (v.currentTime || 0);
    this.lastTickTime = t || 0; // the ratchet baseline is the LOAD target, not the old position
    // remember where we were so the swap doesn't reset to the start
    this.pendingSeek = t || undefined;
    this.recoveredAfterDance = false; // a fresh load is a fresh chance
    this.prefApplied = false; // a new source load re-arms the preference
    this.userPaused = false; // a new source load is a fresh playback intent
    this.finished = false; // a fresh load is a fresh end-state
    if (kind === "mp4") v.src = mp4StreamURL(this.auth, this.file.id);
    else if (kind === "original") v.src = streamURL(this.auth, this.file.id);
    else if (kind === "hls") this.attachHls(t);
    if (kind !== "hls") v.load();
    v.play().catch(() => undefined);
    this.bindTrackEvents();
  }

  /** Fallback chain: current source → mp4 (if available) → hls → original. */
  private fallbackChain(from: SourceKind): SourceKind[] {
    const chain: SourceKind[] = [];
    const order: SourceKind[] = ["original", "mp4", "hls"];
    const started = order.indexOf(from);
    for (let i = started + 1; i < order.length; i++) {
      const k = order[i];
      if (k === "mp4" && !this.file.is_mp4_available) continue;
      chain.push(k);
    }
    // if we've tried everything, loop back to original as last resort
    if (!chain.length) chain.push("original");
    return chain;
  }

  async play(): Promise<void> {
    this.userPaused = false;
    const v = this.v();
    try {
      await v.play();
    } catch {
      /* autoplay blocked — user pressed play anyway */
    }
  }
  pause(): void {
    this.userPaused = true;
    this.v().pause();
  }
  seek(t: number): void {
    const v = this.v();
    v.currentTime = t;
    // for hls, force reload if seek far
  }
  togglePlayPause(): void {
    const v = this.v();
    if (v.paused) this.play();
    else this.pause();
  }
  skip(delta: number): void {
    const v = this.v();
    v.currentTime = Math.max(0, Math.min(v.duration || v.currentTime + delta, v.currentTime + delta));
  }
  /** The playback rate (0.5–2). The Player owns the state (icon + menu) and
   *  re-applies it per file; the engine only sets the element. The Player
   *  offers it for seekable files only (VOD). Pitch is preserved — this is
   *  a TV player, not a chipmunk. */
  setSpeed(rate: number): void {
    const v = this.v();
    v.playbackRate = rate;
    (v as any).playbackPreservesPitch = true;
  }

  get duration(): number {
    return this.v().duration || 0;
  }

  /**
   * Auto-resume (L1: pure — no prompt, no choice): a file that opens with a
   * real saved position (> RESUME_MIN) while the playhead is still near the
   * start lands at saved-lead. The rule lives in resume.ts (shared,
   * tested); the engine only fetches the position and applies the seek.
   */
  async applyResume(): Promise<number | null> {
    const v = this.v();
    let from = this.file.start_from;
    if (!from) {
      try {
        const { getStartFrom } = await import("./api");
        from = await getStartFrom(this.auth, this.file.id);
      } catch {
        from = 0;
      }
    }
    const target = autoResumeTarget(from, v.currentTime || 0);
    if (target) {
      v.currentTime = target.time;
      return from;
    }
    return null;
  }

  /** Persist playback position every ~30s and on pause/unload. */
  saveResume(): void {
    if (this.finished) return; // ended / outro skipped — no position to resume
    const v = this.v();
    const t = v.currentTime;
    if (!t || v.duration < 120) return; // skip live / very short
    if (v.duration && t > v.duration - 30) return; // near end
    const { setStartFrom } = apiRef;
    setStartFrom(this.auth, this.file.id, t).catch(() => undefined);
    this.lastSaved = t;
  }

  /* ---------------- hls.js ---------------- */

  private attachHls(startAt: number): void {
    const v = this.v();
    const url = hlsURL(this.auth, this.file.id);
    if (Hls.isSupported()) {
      const hls = new Hls({
        enableWorker: false, // Chrome 79 webview: keep it simple
        // Deep buffer (issue: interruptions): a TV viewer sits still — trade
        // a few seconds of start latency for immunity to network dips.
        maxBufferLength: 60,
        maxMaxBufferLength: 90, // let the buffer actually grow past the 60s auto-cap
        manifestLoadingTimeOut: 15000,
        manifestLoadingMaxRetry: 3,
        fragLoadingTimeOut: 20000,
        liveSyncDuration: 10,
      });
      this.hls = hls as HlsLike;
      // The overlay owns subtitle rendering (m00906): keep hls.js's native
      // cue display OFF — with subtitleDisplay off, hls.js's track switcher
      // only ever sets textTracks to 'hidden', never 'showing' (the native
      // path rendered a different size/position and printed the {an8}
      // artifact literally). Pinned hls.js 1.0.11 exposes this as an instance
      // property (Hls.subtitleDisplay), not a config key.
      hls.subtitleDisplay = false;
      hls.loadSource(url);
      hls.attachMedia(v as HTMLMediaElement);
      (hls as any).on(Hls.Events.MANIFEST_PARSED, () => {
        v.play().catch(() => undefined);
        // restore the language the user had on — a source switch (or
        // entering HLS for a specific track) must not reset the audio to
        // the manifest's default rendition
        this.preselectHlsAudio();
        this.syncHlsTracks();
      });
      // The subtitle rendition list is published AFTER the manifest — re-sync
      // when it lands (and whenever hls.js rebuilds it).
      (hls as any).on(Hls.Events.SUBTITLE_TRACKS_UPDATED, () => {
        this.syncHlsTracks();
      });
      // hls.js fires MANIFEST_PARSED BEFORE it loads the alternate audio
      // playlists — the track list is only final on AUDIO_TRACKS_UPDATED,
      // so the preselect runs there too (otherwise the default rendition
      // stays on — caught by the e2e: eng segments after a Spanish pick)
      (hls as any).on(Hls.Events.AUDIO_TRACKS_UPDATED, () => {
        this.preselectHlsAudio();
        this.syncHlsTracks();
      });
      (hls as any).on(Hls.Events.ERROR, (_e: any, data: any) => {
        if (data && data.fatal) {
          if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
            // try the next fallback
            const next = this.fallbackChain("hls")[0];
            if (next && next !== "hls") {
              this.onState({ error: `HLS problem — switched to ${next}` });
              this.setSource(next, v.currentTime || startAt);
            } else {
              this.onState({ error: "Stream failed", buffering: false });
            }
          } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
            try {
              (hls as any).recoverMediaError();
            } catch {
              /* ignore */
            }
          }
        }
      });
    } else if (v.canPlayType("application/vnd.apple.mpegurl")) {
      v.src = url;
      v.play().catch(() => undefined);
    } else {
      this.onState({ error: "HLS not supported on this system" });
    }
  }

  private teardownHls(): void {
    if (this.hls) {
      try {
        this.hls.destroy();
      } catch {
        /* ignore */
      }
      this.hls = null;
    }
    this.unsub.push(() => this.unbindTrackEvents());
  }

  /* ---------------- audio panel model ---------------- */

  /** put.io media_info → the file's audio streams (codec/language/title). */
  private async fetchMediaInfo(): Promise<void> {
    try {
      const f = (await getFile(this.auth, this.file.id, { mediaInfo: true })) as any;
      if (this.cleaning) return;
      this.metaAudio = audioStreamsFromMediaInfo(f.media_info);
      if (this.metaAudio.length > 1) this.fetchHlsManifest();
      this.syncTracks();
    } catch {
      /* non-fatal: the panel degrades to the native list */
    } finally {
      this.metaSettled = true;
      // the deferred preference match (its first real list arrived before
      // the file's real titles did)
      if (this.prefDefer) this.applyAudioPreference();
    }
  }

  /** Prefetch the master playlist → per-language audio renditions. */
  private async fetchHlsManifest(): Promise<void> {
    try {
      const res = await fetch(hlsURL(this.auth, this.file.id));
      const text = await res.text();
      if (this.cleaning) return;
      this.hlsRenditions = parseHlsAudioRenditions(text);
      this.syncTracks();
    } catch {
      /* non-fatal: no "via put.io stream" rows */
    }
  }

  /** One Range request per call, on the file's original stream URL. Public
   *  because the row-2 scheduler (Player) drives its own fetches. */
  rangeReader(): (start: number, end: number) => Promise<Uint8Array> {
    const url = streamURL(this.auth, this.file.id);
    return async (start, end) => {
      const res = await fetch(url, { headers: { Range: `bytes=${start}-${end}` } });
      if (!res.ok) throw new Error(`range ${res.status}`);
      return new Uint8Array(await res.arrayBuffer());
    };
  }

  /** The multi-range flavour of rangeReader: many ranges per round trip
   *  (the row-1 batcher collapses ~500 reads into a handful of requests).
   *  Falls back to single-range reads when the CDN ignores the multi-range
   *  request, so it is always safe to hand to the demuxer. */
  private rangeReaderMulti(): (ranges: Array<[number, number]>) => Promise<Uint8Array[]> {
    return multiRangeReader(streamURL(this.auth, this.file.id), this.rangeReader());
  }

  /** Best-effort bounded probe of the ORIGINAL stream's MKV header:
   *  the embedded ASS style tables (and chapters) let the subtitle overlay
   *  render per style (colour/outline/position) instead of a flat blob.
   *  Non-fatal: on failure the overlay degrades to the plain render. */
  private async fetchSubtitleHeader(): Promise<void> {
    try {
      const result = await probeHeader(this.rangeReader());
      if (this.cleaning) return;
      this.subStyleTables = result.styleTables;
      this.subAssTracks = result.assTracks;
      this.subChapters = result.chapters;
      this.segStart = result.segStart;
      this.scale = result.scale;
      this.cuesFileOffset = result.cuesFileOffset;
      // TEMP-DIAG (remove after the on-device check)
      console.log(
        "[rawass] probe OK:",
        JSON.stringify({
          styleTables: this.subStyleTables.length,
          tracks: this.subAssTracks.map((t) => `${t.num}:${t.lang}`),
          segStart: this.segStart,
          scale: this.scale,
          cuesFileOffset: this.cuesFileOffset,
        }),
      );
      this.onState({ subStyleTables: this.subStyleTables, subAssTracks: this.subAssTracks, subChapters: this.subChapters });
    } catch (e) {
      console.error("[rawass] probe FAILED:", e); // TEMP-DIAG
      /* non-fatal: the overlay stays plain */
    }
  }

  /** Decide how this track's raw ASS should be fetched (docs/raw-ass-upgrade.md):
   *  row 1 = validated Cues → a few batched block ranges (the whole track at
   *  ~0.23% of the file, byte-exact); row 2 = validated cluster offsets but
   *  untrusted in-cluster offsets → the Player's lazy whole-cluster scheduler
   *  (playhead-paced); row 3 = no upgrade (put.io's converted file stands).
   *  Non-fatal: any failure returns null and the put.io file stands. */
  async probeRawAss(trackNum: number): Promise<RawAssRoute | null> {
    const track = this.subAssTracks.find((t) => t.num === trackNum);
    if (!track) {
      // TEMP-DIAG (remove after the on-device check)
      console.log("[rawass] probeRawAss:", trackNum, "track MISSING in", this.subAssTracks.length, "probed tracks");
      return null;
    }
    // row 2 needs the size for its 2 GiB cap; without it there is no upgrade path
    if (this.cuesFileOffset === null || !this.file.size) {
      // TEMP-DIAG (remove after the on-device check)
      console.log("[rawass] probeRawAss:", trackNum, "no upgrade: cuesFileOffset=", this.cuesFileOffset, "file.size=", this.file.size);
      return { row: 3, trackNum };
    }
    try {
      const reader = this.rangeReader();
      const cues = await fetchCues(reader, this.cuesFileOffset);
      // TEMP-DIAG (remove after the on-device check)
      console.log(
        "[rawass] probeRawAss:",
        trackNum,
        "cues fetched:",
        cues.filter((c) => c.track === trackNum).length,
        "for this track /",
        cues.length,
        "total",
      );
      if (this.cleaning) return null;
      const t0 = Date.now();
      const route = await routeRawAss({
        read: reader,
        readRanges: this.rangeReaderMulti(),
        segStart: this.segStart,
        scale: this.scale,
        cuesFileOffset: this.cuesFileOffset,
        fileSize: this.file.size,
        cues,
        trackNum,
        codecPrivate: track.priv,
      });
      // TEMP-DIAG (remove after the on-device check)
      console.log(
        "[rawass] probeRawAss:",
        trackNum,
        "route row",
        route.row,
        "in",
        Date.now() - t0,
        "ms — ass:",
        route.ass ? route.ass.length + " chars" : "-",
        "cues:",
        route.cues ?? "-",
        "plan:",
        route.plan ? route.plan.length : "-",
      );
      return route;
    } catch (e) {
      console.error("[rawass] probeRawAss FAILED:", trackNum, e); // TEMP-DIAG
      return null; // non-fatal: the put.io cues stand
    }
  }

  /** Recompute the merged rows and publish them + which row is actually on. */
  private publishRows(kind: "native" | "hls", activeIndex: number): void {
    const rows = mergeAudioRows(this.nativeTracks, this.metaAudio, this.hlsRenditions);
    this.onState({
      audioPanelRows: rows,
      audioActiveKey: activeRowKey(rows, kind, activeIndex),
    });
  }

  /* ---------------- audio tracks ---------------- */

  private bindTrackEvents(): void {
    const v = this.v();
    const at = (v as WebOSHTMLVideoElement).audioTracks;
    if (at && typeof at.addEventListener === "function") {
      this.trackChangeHandler = () => this.syncTracks();
      // LG's webview announces the initial population via `addtrack` (not
      // just `change`) — listening to change alone misses tracks on some
      // files (see the Stremio webOS patch); removetrack keeps rows honest
      // when the pipeline drops a track.
      for (const ev of ["change", "addtrack", "removetrack"]) {
        try {
          at.addEventListener(ev, this.trackChangeHandler);
        } catch {
          /* older webview */
        }
      }
    }
    this.syncTracks();
  }

  private trackChangeHandler: (() => void) | null = null;
  private unbindTrackEvents(): void {
    const v = this.v() as any;
    if (this.trackChangeHandler && v.audioTracks) {
      try {
        v.audioTracks.removeEventListener("change", this.trackChangeHandler);
      } catch {
        /* ignore */
      }
    }
    this.trackChangeHandler = null;
  }

  private syncTracks(): void {
    if (this.source === "hls" && this.hls) {
      this.syncHlsTracks();
    } else {
      this.syncNativeTracks();
    }
  }

  private syncNativeTracks(): void {
    const at = (this.v() as any).audioTracks;
    // progressive sources expose no reliable embedded subtitle tracks — the
    // Player renders put.io subs via its DOM overlay, so report none here.
    const subTracks: SubtitleTrackInfo[] = [];
    if (!at || at.length === 0) {
      this.nativeTracks = [];
      this.publishRows("native", 0);
      this.onState({ audioTracks: [], audioTrack: 0, subtitleTracks: subTracks });
      return;
    }
    const tracks: AudioTrackInfo[] = [];
    this.nativeTracks = [];
    for (let i = 0; i < at.length; i++) {
      const t = at[i];
      const label =
        t.label ||
        (t.language ? t.language.toUpperCase() : null) ||
        `Track ${i + 1}`;
      tracks.push({ id: i, label, lang: t.language });
      // raw values for the merge (the panel row re-derives its label)
      this.nativeTracks.push({ enabled: !!t.enabled, label: t.label || "", lang: t.language || null });
    }
    let idx = 0;
    for (let i = 0; i < at.length; i++) {
      if (at[i].enabled) {
        idx = i;
        break;
      }
    }
    this.publishRows("native", idx);
    this.onState({ audioTracks: tracks, audioTrack: idx, subtitleTracks: subTracks });
    // the configured preference applies to the first REAL list — the
    // empty-list branch above must not consume it (the first sync fires
    // before the pipeline exposes tracks)
    this.applyAudioPreference();
  }

  /** Apply the remembered audio language to the live hls.js track list.
   *  No-op until the list is populated (it arrives with the alternate
   *  audio playlists, after MANIFEST_PARSED). */
  private preselectHlsAudio(): void {
    const hls = this.hls as any;
    // an explicit pick (lastAudioLang) beats the configured preference
    const lang = this.lastAudioLang || this.prefLang;
    if (!hls || !lang) return;
    const tracks = hls.audioTracks || [];
    if (!tracks.length) return;
    const i = pickHlsAudioTrackIndex(tracks, lang);
    if (i >= 0 && i !== hls.audioTrack) hls.audioTrack = i;
  }

  private syncHlsTracks(): void {
    const hls = this.hls as any;
    if (!hls) return;
    const tracks: AudioTrackInfo[] = (hls.audioTracks || []).map(
      (t: any, i: number) => ({
        id: i,
        label: t.name || (t.lang ? t.lang.toUpperCase() : null) || `Audio ${i + 1}`,
        lang: t.lang,
      })
    );
    // The rendition list comes from hls.js, not the video's textTracks: the
    // tracks carry the label/lang AND the VTT URL the overlay fetches
    // (m00906); with subtitleDisplay off the textTracks stay empty anyway.
    const renditions: any[] = hls.subtitleTracks || [];
    const subTracks: SubtitleTrackInfo[] = renditions.map((t: any, i: number) => ({
      id: i,
      label: t.name || `Subs ${i + 1}`,
      lang: t.lang || undefined,
      url: t.url || undefined,
    }));
    this.onState({ audioTracks: tracks, audioTrack: hls.audioTrack ?? 0, subtitleTracks: subTracks });
    this.publishRows("hls", hls.audioTrack ?? 0);
  }

  /**
   * Row-based selection (the audio panel is rows, not raw indices):
   *  - a natively exposed row → the webview switch (with escalation)
   *  - a metadata-only row (hidden by the webview, e.g. DTS on webOS 6) →
   *    the put.io stream rendition for that language, if the manifest has
   *    one — position is preserved by setSource's pendingSeek
   *  - neither → an honest refusal with the reason
   */
  selectAudioRow(row: AudioPanelRow): void {
    if (this.switchingAudio) return; // one escalation at a time
    // remember the user's language for the whole session: any later
    // entry into the put.io stream preselects it (see MANIFEST_PARSED)
    if (row.lang) this.lastAudioLang = row.lang;
    if (this.source !== "hls" && row.nativeIndex >= 0) {
      this.setAudioTrack(row.nativeIndex);
    } else if (row.hlsIndex >= 0) {
      this.switchToHlsForTrack(row);
    } else {
      this.onState({
        audioSwitchFailed: true,
        audioFailReason: "The TV can't play this track and the put.io stream has no rendition for it.",
      });
    }
  }

  /** The "auto-hls" fallback (Settings): the native switch was refused
   *  even after the full escalation — enter the put.io stream directly for
   *  this row's language. Position is preserved; the language is
   *  preselected when the manifest lands (see switchToHlsForTrack). */
  enterHlsForRow(row: AudioPanelRow): void {
    if (this.switchingAudio) return;
    if (row.hlsIndex < 0) {
      this.onState({
        audioSwitchFailed: true,
        audioFailReason: "The put.io stream has no rendition for this track.",
      });
      return;
    }
    this.switchToHlsForTrack(row);
  }

  /** Leave for the put.io stream (position preserved). The picked language
   *  is preselected there once the manifest lands (see MANIFEST_PARSED). */
  private switchToHlsForTrack(row: AudioPanelRow): void {
    if (row.lang) this.lastAudioLang = row.lang;
    const t = this.v().currentTime || 0;
    this.setSource("hls", t);
  }

  /** Feed the episode's segments (the Player's lookup result). Drives the
   *  fresh-start skip — and, when the data arrives AFTER the metadata
   *  (the lookup is async), applies that skip late: the playhead is still
   *  near the top, the intro is long, landing it now is the same promise.
   *  A saved position wins — never. */
  setSegments(segs: Seg[]): void {
    this.segs = segs && segs.length ? segs : null;
    const v = this.v();
    const d = v.duration;
    if (this.finished || !d || !Number.isFinite(d)) return;
    if ((this.file.start_from || 0) > 0) return; // a resume wins
    const fs = freshSkip(this.segs, d, d === Infinity);
    if (fs.target > 0 && v.currentTime < fs.target - FRESH_LATE_GRACE) {
      try {
        v.currentTime = fs.target;
      } catch {
        /* not seekable yet */
      }
      this.onState({ skippedSeg: fs.label });
    }
  }

  /** The video is over (natural end, or the credits were skipped): no
   *  resume position is saved from here on. */
  finish(): void {
    this.finished = true;
  }

  /** Mirror the configured preferred audio language (Settings). Applied
   *  once per source load, to the first REAL (non-empty) track list — the
   *  first sync can fire before the pipeline exposes any tracks. */
  setAudioPreference(lang: string | null): void {
    this.prefLang = lang && lang.length ? lang : null;
    if (this.prefLang && !this.prefApplied && this.nativeTracks.length > 0) {
      this.applyAudioPreference();
    }
  }
  private applyAudioPreference(): void {
    if (this.prefApplied || !this.prefLang) return;
    if (this.nativeTracks.length === 0) return; // empty list: not "real" yet
    if (!this.metaSettled) {
      // The file's real facts (put.io media_info) are still in flight. Do
      // NOT consume the preference on a meta-less match attempt — retry
      // once when the metadata settles (fetchMediaInfo's finally).
      this.prefDefer = true;
      return;
    }
    this.prefApplied = true;
    this.prefDefer = false;
    // Match against the PANEL ROWS — what the user sees. A merged row
    // carries the file's real title and language (from media_info) even
    // when the webview exposes nothing for the track. Matching the raw
    // webview tracks alone silently missed (the reported C1 failure).
    const rows = mergeAudioRows(this.nativeTracks, this.metaAudio, this.hlsRenditions);
    const row = rows.find((r) => matchLang({ lang: r.lang, label: r.label }, this.prefLang!));
    if (!row) {
      const found = rows.map((r) => r.label).join(", ") || "no audio track";
      this.onState({
        audioPrefMiss: `No ${this.prefLang} audio track in this file (found: ${found})`
      });
      return; // honest: announce, don't escalate
    }
    if (row.nativeIndex < 0) {
      // hidden from the webview (undecodable codec) — nothing to escalate
      // to; the panel row explains the state
      return;
    }
    const v = this.v() as any;
    if (enabledIndexOf(v.audioTracks) === row.nativeIndex) {
      this.publishRows("native", row.nativeIndex);
      return; // already where the preference wants — no escalation
    }
    this.runNativeSwitch(row.nativeIndex, "preference");
  }

  setAudioTrack(index: number): void {
    if (this.source === "hls" && this.hls) {
      const hls = this.hls as any;
      if (hls.audioTracks && index < hls.audioTracks.length) {
        hls.audioTrack = index;
        this.publishRows("hls", index);
        this.onState({ audioTrack: index });
      }
      return;
    }
    const at = (this.v() as any).audioTracks;
    if (!at || index >= at.length) {
      this.onState({
        audioSwitchFailed: true,
        audioFailReason: "This source exposes no audio tracks to switch.",
      });
      return;
    }
    // already where we're going — no escalation for an idempotent pick
    if (enabledIndexOf(at) === index) {
      this.publishRows("native", index);
      return;
    }
    // explicit user pick OR the configured startup preference: bounded
    // escalation until the read-back confirms.
    this.runNativeSwitch(index);
  }

  /**
   * Native (webview) audio switching WITH ESCALATION. The webOS 6 webview
   * silently vetoes `enabled` writes for some MKV files once playback has
   * started — the read-back (applyAudioTrack) reveals it — so a pick runs
   * through the planner step by step until it lands:
   *   0 plain write → 1 paused write → 2 write + Luna selectTrack
   *   → 3 the reload dance: pause, strip src, load, re-set src, re-write
   *     enabled at the fresh loadedmetadata, seek back, resume. The full
   *     reload forces the native pipeline to re-evaluate which track it
   *     decodes (proven on webOS in kieranbrown/stremio-webos).
   * Success/failure is always the read-back — the Player toasts only on a
   * confirmed state.
   */
  private runNativeSwitch(index: number, kind: "user" | "preference" = "user"): void {
    if (this.switchingAudio) return; // one escalation at a time
    this.switchingAudio = true;
    this.pickKind = kind;
    this.onState({ audioSwitching: true });
    // the flag must clear on EVERY terminal path (confirm, fail, throw) —
    // leaving it true would silently lock out all later picks (caught by
    // the e2e round-trip: the second pick did nothing)
    // safety net for throw paths — the terminal branches below clear the
    // flag synchronously so it is released BY THE TIME the terminal state
    // is observable (clearing only here would race a pick made right after
    // the confirm/fail state: the .finally callback runs a few microtask
    // hops later than the onState above it)
    void this.runNativeSwitchSteps(index, 0).finally(() => {
      this.switchingAudio = false;
    });
  }

  private async runNativeSwitchSteps(
    index: number,
    attempt: number
  ): Promise<void> {
    const landed = await this.performNativeAttempt(index, attempt);
    const outcome = planAudioSwitch(attempt, landed, index);
    if (outcome.kind === "confirmed") {
      this.publishRows("native", outcome.index);
      // release the guard with the terminal state (see runNativeSwitch)
      this.switchingAudio = false;
      this.onState({
        audioTrack: outcome.index,
        audioSwitching: false,
        audioPickKind: this.pickKind,
        audioPickIndex: index,
      });
      return;
    }
    if (outcome.kind === "next") {
      await this.runNativeSwitchSteps(index, outcome.attempt);
      return;
    }
    this.switchingAudio = false;
    this.onState({
      audioTrack: landed >= 0 ? landed : index,
      audioSwitchFailed: true,
      audioFailReason: outcome.reason,
      audioSwitching: false,
      audioPickKind: this.pickKind,
      audioPickIndex: index,
    });
  }

  /** Run one escalation step; resolve with the READ-BACK index. */
  private performNativeAttempt(index: number, attempt: number): Promise<number> {
    const v = this.v() as any;
    const at = v.audioTracks;
    if (!at) return Promise.resolve(-1);
    if (attempt === 0) {
      // READ BACK: the webOS webview silently ignores `enabled` writes for
      // some MKV files — only the read-back can confirm the switch landed.
      return Promise.resolve(applyAudioTrack(at, index));
    }
    if (attempt === 1) {
      // mid-buffer writes are the flakiest; a paused write lands more often
      const wasPaused = v.paused;
      if (!wasPaused) v.pause();
      return this.wait(300).then(() => {
        const landed = applyAudioTrack(v.audioTracks, index);
        if (!wasPaused) v.play().catch(() => undefined);
        return landed;
      });
    }
    if (attempt === 2) {
      const now = applyAudioTrack(at, index);
      platform.lunaSelectTrack(index); // best-effort, see platform.ts
      return this.wait(250).then(() => enabledIndexOf((this.v() as any).audioTracks) ?? now);
    }
    // attempt 3 — the reload dance, the last escalation step (the planner
    // never schedules beyond it; anything past is a planner bug, so fail
    // safe rather than loop)
    if (attempt >= AUDIO_SWITCH_DANCE_ATTEMPT) return this.danceForTrack(index);
    return Promise.resolve(-1);
  }

  private wait(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }

  /**
   * The reload dance. A full src reload is the one thing that makes the
   * native pipeline re-evaluate the track selection, so: remember position
   * and pause state → strip src → load → re-set src → at the fresh
   * loadedmetadata, re-write the pick, re-attach the (new) track events,
   * seek back, resume. Resolves with the read-back index.
   */
  private danceForTrack(index: number): Promise<number> {
    const v = this.v() as any;
    return new Promise((resolve) => {
      const t = v.currentTime || 0;
      const wasPaused = v.paused;
      const src = v.src;
      if (!src) {
        resolve(-1);
        return;
      }
      this.dancing = true;
      let done = false;
      let settled = false; // true once the dance's own reload delivered metadata
      const finish = (landed: number) => {
        if (done) return;
        done = true;
        this.dancing = false;
        try {
          if (Math.abs((v.currentTime || 0) - t) > 1) v.currentTime = t;
          if (!wasPaused) v.play().catch(() => undefined);
        } catch {
          /* position is best-effort */
        }
        // The dance's reload DIED (bail/throw, no metadata, element still
        // erroring). Suppressing that error without recovering would leave
        // a dead player — and letting it through as-is would degrade a
        // stream that was ALIVE before the pick to the mp4 transcode.
        // Restore the SAME source once (a plain re-set, no strip); if that
        // also dies, onError's fallback chain takes over.
        if (!settled && v.error && !this.recoveredAfterDance) {
          this.recoveredAfterDance = true;
          this.onState({ buffering: true });
          this.setSource(this.source, v.currentTime || t);
        }
        resolve(landed);
      };
      const bail = setTimeout(() => finish(enabledIndexOf(v.audioTracks)), 5000);
      const onMeta = () => {
        settled = true;
        clearTimeout(bail);
        v.removeEventListener("loadedmetadata", onMeta);
        // fresh session → fresh audioTracks list: re-attach the listeners
        // (they live on the list object, which was replaced)
        this.bindTrackEvents();
        finish(applyAudioTrack(v.audioTracks, index));
      };
      v.addEventListener("loadedmetadata", onMeta);
      try {
        v.pause();
        v.removeAttribute("src");
        v.load();
        v.src = src;
      } catch {
        clearTimeout(bail);
        v.removeEventListener("loadedmetadata", onMeta);
        finish(-1);
      }
    });
  }

  /* ---------------- video events ---------------- */

  private boundEvents: [EventTarget, string, EventListener][] = [];
  private onTime = () => {
    const v = this.v();
    const bEnd = v.buffered && v.buffered.length ? v.buffered.end(v.buffered.length - 1) : 0;
    // THE RATCHET (one-way): a playhead that is visibly advancing is not
    // buffering. The stall events own the truth (waiting → true, playing
    // → false); this only CLEARS, in case a 'playing' event is ever
    // missed (a stuck spinner on the TV — the old design's geometry
    // recompute spun the spinner on every tight-buffer HLS stream).
    const advancing = !v.paused && !v.seeking && v.currentTime > this.lastTickTime;
    this.lastTickTime = v.currentTime;
    const s: Partial<MediaState> = {
      currentTime: v.currentTime,
      duration: v.duration || 0,
      paused: v.paused,
      buffered: bEnd, // buffer end (seconds) — the Player draws the buffer bar from this
    };
    if (advancing) s.buffering = false;
    // auto-resume save (gated in saveResume by the resume lock)
    if (!v.paused && v.currentTime - this.lastSaved > 30) this.saveResume();
    this.onState(s);
  };
  private onMeta = () => {
    const v = this.v() as any;
    const s: Partial<MediaState> = {
      duration: v.duration || 0,
      live: v.seeking === false && v.duration === Infinity,
    };
    // A seek remembered before metadata existed (a seek set before the new
    // metadata is silently dropped) is applied here, now that it can work.
    // (t==0 is a source switch at the start — there is nothing to restore.)
    if (this.pendingSeek != null) {
      const t = this.pendingSeek;
      this.pendingSeek = null;
      if (t > 2) {
        try { v.currentTime = t; } catch { /* range error — start over */ }
      }
    }
    this.onState(s);
    this.syncTracks();
    // Auto-resume (L1: pure — there is no prompt to race): exactly once
    // per engine, on the first metadata.
    if (!this.resumeApplied) {
      this.resumeApplied = true;
      this.applyResume().then((from) => {
        if (from) {
          platformToast(`Resumed from ${Math.floor(from / 60)}:${String(from % 60).padStart(2, "0")}`);
        } else {
          // Fresh start — no saved position: the leading segments (intro,
          // often the recap) are skipped (the one rule lives in segments.ts;
          // the Player toasts).
          const fs = freshSkip(this.segs, v.duration, v.duration === Infinity);
          if (fs.target > 0) {
            try { v.currentTime = fs.target; } catch { /* not seekable */ }
            this.onState({ skippedSeg: fs.label });
          }
        }
      });
    }
  };
  private onWait = () => {
    // A STALL is a waiting event DURING playback (after the first frame) —
    // the initial load's buffering is normal, and an in-flight switch/dance
    // buffers by design. Counted per source; the Player advises once.
    if (this.everPlayed && !this.dancing && !this.switchingAudio) {
      this.stalls += 1;
      this.onState({ stalls: this.stalls });
    }
    this.onState({ buffering: true });
  };
  private onPlaying = () => {
    this.everPlayed = true;
    this.onState({ buffering: false, error: null });
  };
  /** A pause nobody in the app requested: the element stopped on its own.
   *  On webOS this is what a system volume change can do — the audio
   *  pipeline re-negotiates and the webview pauses the element, leaving
   *  playback stuck on the pause icon (the old "turn the volume and it
   *  stops" behavior). Resume it. Never touch a pause the engine caused:
   *  the user's blue key (userPaused), a switch in flight (switchingAudio,
   *  whose paused-write step pauses deliberately), or the dance (dancing). */
  private onPause = () => {
    if (this.userPaused || this.dancing || this.switchingAudio) return;
    const v = this.v();
    if (v.ended || v.error) return;
    v.play().catch(() => undefined);
  };
  private onError = () => {
    // the reload dance strips src mid-flight — the element's error for THAT
    // is expected, not a dead stream. Treating it as fatal ran the fallback
    // chain (switch to the MP4 source) and killed playback of stubborn files.
    if (this.dancing) return;
    const v = this.v();
    if (v.error && Date.now() - this.lastErrorAt > 3000) {
      this.lastErrorAt = Date.now();
      // code 4 (MEDIA_ERR_SRC_NOT_SUPPORTED — a numeric literal: the
      // MediaError global doesn't exist in the node test harness) = the
      // webview cannot DECODE this source at all (the real case: 4K HEVC
      // Main 10 + Dolby Vision — fine on the real TV, which has the
      // hardware decoder; unplayable in the simulator's webview).
      // Say so: the fallback's own setSource clears the panel error before
      // the user can read a bare "Playback error".
      const code = (v.error as MediaError).code;
      const reason =
        code === 4
          ? "This webview can't decode this source (HEVC 10-bit / Dolby Vision is a common cause)"
          : "Playback error";
      this.onState({ buffering: false, error: reason });
      const chain = this.fallbackChain(this.source);
      if (chain.length) {
        const next = chain[0];
        if (next !== this.source) {
          this.onState({
            error: `${reason} — trying the put.io ${next === "mp4" ? "MP4" : next} instead.`,
          });
          this.setSource(next, v.currentTime || 0);
        }
      }
    }
  };
  private onEndedFn = () => {
    this.onEnded();
  };

  private bindEvents(): void {
    const v = this.video as any;
    const pairs: [EventTarget, string, EventListener][] = [
      [v, "timeupdate", this.onTime],
      [v, "loadedmetadata", this.onMeta],
      [v, "waiting", this.onWait],
      [v, "playing", this.onPlaying],
      [v, "pause", this.onPause],
      [v, "error", this.onError],
      [v, "ended", this.onEndedFn],
    ];
    for (const [t, n, f] of pairs) {
      t.addEventListener(n, f);
      this.boundEvents.push([t, n, f]);
    }
  }
  private unbindEvents(): void {
    if (this.cleaning) return; // re-entrancy guard: unbindEvents is its own unsub
    this.cleaning = true;
    for (const [t, n, f] of this.boundEvents) t.removeEventListener(n, f);
    this.boundEvents = [];
    this.unbindTrackEvents();
    if (this.resumeTimer) window.clearTimeout(this.resumeTimer);
    this.teardownHls();
    try {
      this.video.removeAttribute("src");
      (this.video as any).load?.();
    } catch {
      /* ignore */
    }
    // snapshot: teardownHls() appends to unsub mid-iteration; a live for..of
    // would re-enter unbindEvents via the closure the constructor pushed.
    const list = this.unsub.slice();
    this.unsub = [];
    for (const u of list) {
      try {
        u();
      } catch {
        /* ignore */
      }
    }
  }

  destroy(): void {
    this.saveResume();
    this.unbindEvents();
  }
}

// small indirection so the class file doesn't import api twice (avoid cycle surprises)
import * as apiRef from "./api";

import { platform } from "../webos/platform";
function platformToast(msg: string): void {
  platform.toast(msg);
}
