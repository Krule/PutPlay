/**
 * Minimal webOS platform bridge.
 *
 * Back key strategy (webOS 3.0+ / Blink webview):
 *  - appinfo.json sets `disableBackHistoryAPI: true`, so the platform passes
 *    the remote's Back key through to the page as a real keydown (keyCode 461).
 *    remote.ts is the single owner of that key and routes it to the active
 *    screen's handler.
 *  - As a belt-and-braces fallback (e.g. an environment that ignores the
 *    appinfo flag), we ALSO push history states and listen for `popstate` —
 *    when the flag is in effect the stack never drains, so the platform's
 *    default "exit" behaviour never triggers on its own.
 *
 * Everything degrades gracefully in a plain desktop browser.
 */

// Bundled webOSTV.js (real TV webviews don't auto-inject it; the simulator does).
import "webostvjs/webOSTV";

type Handler = () => void;

const onWindow = (ev: string, fn: (e: any) => void) => window.addEventListener(ev, fn);

function isWebOS(): boolean {
  return typeof (globalThis as any).luna !== "undefined";
}

/** True when running in a webOS webview (TV or simulator). */
export function isWebOSLike(): boolean {
  return isWebOS();
}

/** The injected or bundled webOSTV.js object (window.webOSTVjs or window.webOS). */
function tvjs(): any {
  try {
    return (
      (globalThis as any).webOSTVjs || (globalThis as any).webOS || null
    );
  } catch {
    return null;
  }
}

/** Official platform back: exit prompt on webOS 6+, Home launcher on 5-. */
function platformBack(): void {
  try {
    const w = tvjs();
    if (w && typeof w.platformBack === "function") {
      w.platformBack();
      return;
    }
    // webOS.js (older) surface
    if ((globalThis as any).webOS && (globalThis as any).webOS.platform) {
      (globalThis as any).webOS.platform.platformBack();
    }
  } catch {
    /* not on webOS — ignore */
  }
}

function lunaCall(service: string, method: string, params: any, timeout = 5000): Promise<any> {
  return new Promise((resolve) => {
    const luna = (globalThis as any).luna;
    if (!luna || !luna.service || typeof luna.service.createConnection !== "function") {
      resolve(null);
      return;
    }
    let done = false;
    const finish = (r: any) => {
      if (done) return;
      done = true;
      resolve(r);
    };
    const id = luna.service.createConnection({
      service,
      method,
      parameters: params,
      onresult: finish,
      onerror: () => finish(null),
    });
    setTimeout(() => {
      if (!done) {
        try {
          luna.service.closeConnection(id);
        } catch {}
        finish(null);
      }
    }, timeout);
  });
}

class Platform {
  private backHandlers = new Set<Handler>();
  private visibilityHandlers = new Set<Handler>();
  private createHandler: Handler | null = null;
  private lastBackAt = 0;

  init(): void {
    // Lifecycle
    this.createHandler = () => {
      if (isWebOS()) {
        try {
          const w = tvjs();
          if (w && w.platform && typeof w.platform.extendStandalone === "function") {
            w.platform.extendStandalone();
          }
        } catch {}
      }
    };
    this.createHandler();

    // Back key — belt-and-braces: keydown 461 (when disableBackHistoryAPI is
    // honoured) and popstate (when the platform still drives history). Both
    // feed the same handler; a debounce swallows the double in the case an
    // environment does both.
    const backFn = () => {
      // debounce: ignore a second back within 350ms (keydown + popstate pair)
      const now = Date.now();
      if (now - this.lastBackAt < 350) return;
      this.lastBackAt = now;
      this.backHandlers.forEach((h) => h());
    };

    // keydown path is owned by remote.ts (screen-level handlers). When a
    // screen doesn't consume back, remote dispatches to the app; the app
    // then calls this for exit. We keep a light keydown hook here ONLY for
    // environments where remote is not wired — but to avoid double-handling
    // we rely on remote and expose the popstate fallback below.
    onWindow("popstate", () => backFn());

    // Visibility → suspend (pause playback when the TV suspends us)
    const vis = (hidden: boolean) => {
      if (hidden) this.visibilityHandlers.forEach((h) => h());
    };
    document.addEventListener("visibilitychange", () => vis(document.hidden));
    try {
      const w = tvjs();
      if (w && w.session) {
        w.session.addEventListener("suspend", () => vis(true));
      }
    } catch {}
  }

  onBack(fn: Handler): void {
    this.backHandlers.add(fn);
  }
  offBack(fn: Handler): void {
    this.backHandlers.delete(fn);
  }
  onSuspend(fn: Handler): void {
    this.visibilityHandlers.add(fn);
  }
  offSuspend(fn: Handler): void {
    this.visibilityHandlers.delete(fn);
  }

  /** Push a history level (keeps the platform from exiting on Back). */
  pushBackLevel(): void {
    try {
      history.pushState({ t: Date.now() }, "");
    } catch {}
  }
  /** Ensure at least one history level exists. */
  ensureBackLevel(): void {
    try {
      if (history.length <= 1) history.replaceState({ t: Date.now() }, "");
      if (history.length <= 1) history.pushState({ t: Date.now() }, "");
    } catch {}
  }
  /** Official exit: prompt on webOS 6+, Home launcher on 5-. */
  back(): void {
    platformBack();
  }

  /** Show a toast. Returns a dispose fn. */
  toast(message: string, ms = 2400): () => void {
    let el = document.getElementById("putio-toast");
    if (!el) {
      el = document.createElement("div");
      el.id = "putio-toast";
      el.className = "toast";
      document.body.appendChild(el);
    }
    el.textContent = message;
    el.classList.remove("show");
    // force reflow so re-adding .show re-triggers transition
    void el.offsetWidth;
    el.classList.add("show");
    let disposed = false;
    const hide = () => {
      if (disposed) return;
      disposed = true;
      el.classList.remove("show");
    };
    setTimeout(hide, ms);
    return hide;
  }

  /** Best-effort Luna media selectTrack. The webview honours it for some
   *  pipelines; a webview <video> may not be a Luna media session at all —
   *  callers must treat it as a hint, never as the mechanism. */
  lunaSelectTrack(index: number): void {
    try {
      lunaCall("luna://com.webos.media", "selectTrack", { type: "audio", index }, 2000);
    } catch {
      /* no Luna on this system */
    }
  }

  copyToClipboard(text: string): Promise<void> {
    const native = lunaCall("luna://com.webos.service.clipboard", "copy", { text });
    if (isWebOS()) return native.then(() => {});
    return navigator.clipboard?.writeText(text).catch(() => {});
  }

  /** Best-effort: ask the OS to open a URL (used for app.put.io/link fallback). */
  openURL(url: string): void {
    if (isWebOS()) {
      lunaCall("luna://com.webos.service.tv", "launchApp", { id: "webAppStore" }, 3000);
      try {
        window.open(url, "_system");
      } catch {}
    } else {
      window.open(url, "_blank");
    }
  }

  quit(): void {
    platformBack();
  }
}

export const platform = new Platform();

/* ---------------- persistent key/value storage ---------------- */

export const store = {
  async get<T = string>(key: string, fallback: T): Promise<T> {
    if (isWebOS()) {
      try {
        const w = tvjs();
        if (w && w.appData && w.appData.isStorageSupported) {
          const v = await new Promise<string | undefined>((res) =>
            w.appData.get(key, (d: any) => res(d ? String(d) : undefined))
          );
          if (v === undefined) return fallback;
          try {
            return JSON.parse(v) as T;
          } catch {
            return v as unknown as T;
          }
        }
      } catch {}
    }
    try {
      const v = localStorage.getItem(key);
      if (v === null) return fallback;
      return JSON.parse(v) as T;
    } catch {
      return fallback;
    }
  },
  async set(key: string, value: unknown): Promise<void> {
    const s = JSON.stringify(value);
    if (isWebOS()) {
      try {
        const w = tvjs();
        if (w && w.appData && w.appData.isStorageSupported) {
          await new Promise<void>((res) => w.appData.set(key, s, () => res()));
          return;
        }
      } catch {}
    }
    try {
      localStorage.setItem(key, s);
    } catch {}
  },
  async remove(key: string): Promise<void> {
    if (isWebOS()) {
      try {
        const w = tvjs();
        if (w && w.appData && w.appData.isStorageSupported) {
          await new Promise<void>((res) => w.appData.delete(key, () => res()));
          return;
        }
      } catch {}
    }
    try {
      localStorage.removeItem(key);
    } catch {}
  },
};
