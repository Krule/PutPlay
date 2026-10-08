import type { Auth } from "./api";
import { hlsURL, mp4StreamURL, streamURL } from "./api";
import Hls from "hls.js";

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
  live: boolean;
}

type HlsLike = InstanceType<typeof Hls>;

/**
 * Drives one <video> element: source selection with fallback chain,
 * audio-track switching (native + hls.js), state for the control overlay.
 */
export class MediaEngine {
  video: HTMLVideoElement;
  source: SourceKind = "original";
  private file: { id: number; is_mp4_available?: boolean; start_from?: number };
  private auth: Auth;
  private hls: HlsLike | null = null;
  private unsub: (() => void)[] = [];
  private resumeTimer: number | null = null;
  private lastSaved = 0;
  private onState: (s: Partial<MediaState>) => void;
  private onSourceChange: (s: SourceKind) => void;
  private onEnded: () => void;
  private lastErrorAt = 0;

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
    if (!silent) this.onSourceChange(kind);
    this.onState({ error: null, buffering: true });
    const v = this.v();
    const t = startAt ?? (v.currentTime || 0);
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
    const v = this.v();
    try {
      await v.play();
    } catch {
      /* autoplay blocked — user pressed play anyway */
    }
  }
  pause(): void {
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
  setVolume(v: number): void {
    this.v().volume = Math.max(0, Math.min(1, v));
  }

  get duration(): number {
    return this.v().duration || 0;
  }

  /** Resume from put.io start_from if >30s and near the beginning. */
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
    if (from && from > 30 && (v.currentTime || 0) < 60) {
      v.currentTime = Math.max(0, from - 5);
      return from;
    }
    return null;
  }

  /** Persist playback position every ~30s and on pause/unload. */
  saveResume(): void {
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
        maxBufferLength: 30,
        manifestLoadingTimeOut: 15000,
        manifestLoadingMaxRetry: 3,
        fragLoadingTimeOut: 20000,
        liveSyncDuration: 10,
      });
      this.hls = hls as HlsLike;
      hls.loadSource(url);
      hls.attachMedia(v);
      (hls as any).on(Hls.Events.MANIFEST_PARSED, () => {
        v.play().catch(() => undefined);
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

  /* ---------------- audio tracks ---------------- */

  private bindTrackEvents(): void {
    const v = this.v();
    const at = (v as WebOSHTMLVideoElement).audioTracks;
    if (at && typeof at.addEventListener === "function") {
      this.trackChangeHandler = () => this.syncNativeTracks();
      try {
        at.addEventListener("change", this.trackChangeHandler);
      } catch {
        /* older webview */
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
    if (!at || at.length === 0) {
      this.onState({ audioTracks: [], audioTrack: 0 });
      return;
    }
    const tracks: AudioTrackInfo[] = [];
    for (let i = 0; i < at.length; i++) {
      const t = at[i];
      const label =
        t.label ||
        (t.language ? t.language.toUpperCase() : null) ||
        `Track ${i + 1}`;
      tracks.push({ id: i, label, lang: t.language });
    }
    let idx = 0;
    for (let i = 0; i < at.length; i++) {
      if (at[i].enabled) {
        idx = i;
        break;
      }
    }
    this.onState({ audioTracks: tracks, audioTrack: idx });
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
    this.onState({ audioTracks: tracks, audioTrack: hls.audioTrack ?? 0 });
  }

  setAudioTrack(index: number): void {
    if (this.source === "hls" && this.hls) {
      const hls = this.hls as any;
      if (hls.audioTracks && index < hls.audioTracks.length) {
        hls.audioTrack = index;
        this.onState({ audioTrack: index });
      }
      return;
    }
    const at = (this.v() as any).audioTracks;
    if (!at || index >= at.length) return;
    for (let i = 0; i < at.length; i++) {
      at[i].enabled = i === index;
    }
    this.onState({ audioTrack: index });
  }

  /* ---------------- video events ---------------- */

  private boundEvents: [EventTarget, string, EventListener][] = [];
  private onTime = (e: Event) => {
    const v = this.v();
    const s: Partial<MediaState> = {
      currentTime: v.currentTime,
      duration: v.duration || 0,
      paused: v.paused,
      buffering: v.buffered && v.buffered.length
        ? v.currentTime < v.buffered.end(v.buffered.length - 1) - 2
          : v.paused
          ? false
          : false,
    };
    // auto-resume save
    if (!v.paused && v.currentTime - this.lastSaved > 30) this.saveResume();
    this.onState(s);
  };
  private onMeta = () => {
    const v = this.v() as any;
    const s: Partial<MediaState> = {
      duration: v.duration || 0,
      live: v.seeking === false && v.duration === Infinity,
    };
    this.onState(s);
    this.syncTracks();
    this.applyResume().then((from) => {
      if (from) platformToast(`Resumed from ${Math.floor(from / 60)}:${String(from % 60).padStart(2, "0")}`);
    });
  };
  private onWait = () => this.onState({ buffering: true });
  private onPlaying = () => this.onState({ buffering: false, error: null });
  private onError = () => {
    const v = this.v();
    if (v.error && Date.now() - this.lastErrorAt > 3000) {
      this.lastErrorAt = Date.now();
      this.onState({ buffering: false, error: "Playback error" });
      const chain = this.fallbackChain(this.source);
      if (chain.length) {
        const next = chain[0];
        if (next !== this.source) {
          this.onState({ error: `Retrying with ${next}` });
          this.setSource(next, v.currentTime || 0);
        }
      }
    }
  };
  private onEndedFn = () => {
    this.onEnded();
  };
  private onVolume = () => {};

  private bindEvents(): void {
    const v = this.video as any;
    const pairs: [EventTarget, string, EventListener][] = [
      [v, "timeupdate", this.onTime],
      [v, "loadedmetadata", this.onMeta],
      [v, "waiting", this.onWait],
      [v, "playing", this.onPlaying],
      [v, "error", this.onError],
      [v, "ended", this.onEndedFn],
    ];
    for (const [t, n, f] of pairs) {
      t.addEventListener(n, f);
      this.boundEvents.push([t, n, f]);
    }
  }
  private unbindEvents(): void {
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
    for (const u of this.unsub) u();
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
