/**
 * Minimal webOS platform bridge.
 *
 * Uses the native `luna` API (always present in the webOS webview) plus the
 * optional webOSTVjs global. Every call degrades gracefully when running in a
 * plain desktop browser (npm-run dev preview), so the same bundle is testable
 * both in the simulator and on a laptop.
 */

export type AppLifecycle = "create" | "visibilitychange" | "destroy" | "suspend" | "resume";

type Handler = () => void;

const onWindow = (ev: string, fn: (e: any) => void) => window.addEventListener(ev, fn);

function isWebOS(): boolean {
  return typeof (globalThis as any).luna !== "undefined";
}

function callPlatform(method: string, params?: any): boolean {
  try {
    const tvjs = (globalThis as any).webOSTVjs;
    if (tvjs && tvjs.platform && typeof tvjs.platform[method] === "function") {
      tvjs.platform[method](params);
      return true;
    }
    return false;
  } catch {
    return false;
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
  private toastHandler: ((msg: any) => void) | null = null;

  init(): void {
    // Lifecycle
    this.createHandler = () => {
      if (isWebOS()) {
        callPlatform("extendStandalone"); // best effort
        callPlatform("allowBackKey");
      }
    };
    this.createHandler();

    // Back key
    const backFn = () => {
      this.backHandlers.forEach((h) => h());
    };
    try {
      const tvjs = (globalThis as any).webOSTVjs;
      if (tvjs && tvjs.platform) {
        tvjs.platform.addEventListener("back", backFn);
      }
    } catch {}
    // Fallbacks (desktop preview / sim without webOSTVjs)
    onWindow("keydown", (e: KeyboardEvent) => {
      const k = e.key;
      if (k === "Escape" || (isWebOS() && k === "Backspace" && (e as any).which === 461) || k.charCodeAt(0) === 461) {
        e.preventDefault();
        backFn();
      }
    });

    // Visibility → suspend/resume (pause playback when TV suspends us)
    const vis = (hidden: boolean) => {
      if (hidden) this.visibilityHandlers.forEach((h) => h());
    };
    document.addEventListener("visibilitychange", () => vis(document.hidden));
    try {
      const tvjs = (globalThis as any).webOSTVjs;
      if (tvjs && tvjs.session) {
        tvjs.session.addEventListener("suspend", () => vis(true));
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

  copyToClipboard(text: string): Promise<void> {
    const native = lunaCall("luna://com.webos.service.clipboard", "copy", { text });
    if (isWebOS()) return native.then(() => {});
    return navigator.clipboard?.writeText(text).catch(() => {});
  }

  /** Best-effort: ask the OS to open a URL (used by app.put.io/link fallback). */
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
    if (isWebOS()) callPlatform("quit");
  }
}

export const platform = new Platform();

/* ---------------- persistent key/value storage ---------------- */

export const store = {
  async get<T = string>(key: string, fallback: T): Promise<T> {
    if (isWebOS()) {
      try {
        const tvjs = (globalThis as any).webOSTVjs;
        if (tvjs && tvjs.appData && tvjs.appData.isStorageSupported) {
          const v = await new Promise<string | undefined>((res) =>
            tvjs.appData.get(key, (d: any) => res(d ? String(d) : undefined))
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
        const tvjs = (globalThis as any).webOSTVjs;
        if (tvjs && tvjs.appData && tvjs.appData.isStorageSupported) {
          await new Promise<void>((res) => tvjs.appData.set(key, s, () => res()));
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
        const tvjs = (globalThis as any).webOSTVjs;
        if (tvjs && tvjs.appData && tvjs.appData.isStorageSupported) {
          await new Promise<void>((res) => tvjs.appData.delete(key, () => res()));
          return;
        }
      } catch {}
    }
    try {
      localStorage.removeItem(key);
    } catch {}
  },
};
