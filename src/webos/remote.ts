/**
 * Spatial (5-way) navigation engine for the webOS remote.
 *
 * Registers focusable elements, moves a single "active" focus on arrow keys
 * using nearest-target geometry, and fires OK/enter, back, and color keys.
 * Works in the simulator, on the TV, and in a desktop browser (keyboard).
 */

export type Dir = "up" | "down" | "left" | "right";

export interface RemoteHandlers {
  onOK?: () => void;
  onBack?: () => void;
  onColor?: (color: "blue" | "green" | "red" | "yellow") => void;
  onPlayPause?: () => void;
  onStop?: () => void;
  onRewind?: () => void;
  onFastForward?: () => void;
  onSearch?: () => void;
  onFocusChange?: (el: HTMLElement) => void;
  onNavigate?: (dir: Dir) => void;
}

const FOCUSABLE_ATTR = "data-focus";

const KEYMAP: Record<number, string> = {
  37: "left",
  38: "up",
  39: "right",
  40: "down",
  13: "ok", // Enter / OK
  14: "ok", // Enter (alt)
  461: "back", // webOS Back (0x1CD)
  27: "back", // Escape (desktop preview)
  8: "back", // Backspace fallback on some sims
  // webOS standard color keys: 403 red, 404 green, 405 yellow, 406 blue
  403: "red",
  404: "green",
  405: "yellow",
  406: "blue",
  415: "play",
  19: "play", // Pause key also fires play/pause toggle
  413: "stop",
  412: "rewind",
  417: "fastforward",
  167: "search",
  16: "pageup",
  35: "pageup", // Home (page up)
  18: "pagedown",
  34: "pagedown", // End (page down)
};

const DOM_ARROW: Record<string, Dir> = {
  ArrowLeft: "left",
  ArrowUp: "up",
  ArrowRight: "right",
  ArrowDown: "down",
};

export class Remote {
  private active: HTMLElement | null = null;
  private handlers: RemoteHandlers;
  private registered = new Set<HTMLElement>();

  constructor(handlers: RemoteHandlers = {}) {
    this.handlers = handlers;
    window.addEventListener("keydown", (e) => this.onKey(e));
  }

  /** Replace the active handler set (call from each screen on mount). */
  setHandlers(h: RemoteHandlers): void {
    this.handlers = h;
  }

  /* ---------- registration ---------- */

  register(el: HTMLElement): void {
    if (!el.hasAttribute(FOCUSABLE_ATTR)) el.setAttribute(FOCUSABLE_ATTR, "");
    el.tabIndex = 0;
    this.registered.add(el);
    el.addEventListener("click", () => this.activate(el, true));
    if (el.getAttribute("data-focus-disabled") === "true") el.dataset.state = "disabled";
    if (this.active === el) this.setActive(el, false);
  }

  unregister(el: HTMLElement): void {
    this.registered.delete(el);
    el.removeAttribute(FOCUSABLE_ATTR);
    if (this.active === el) this.active = null;
  }

  setDisabled(el: HTMLElement, disabled: boolean): void {
    if (disabled) {
      el.setAttribute("data-focus-disabled", "true");
      el.dataset.state = "disabled";
      if (this.active === el) this.active = null;
    } else {
      el.removeAttribute("data-focus-disabled");
      if (this.active !== el) this.clearStates();
    }
  }

  private clearStates(): void {
    for (const el of this.registered) {
      if (el.dataset.state === "visited") el.dataset.state = "";
      if (el.dataset.state === "" && !el.hasAttribute("data-focus-disabled")) {
        el.removeAttribute("data-state");
      }
    }
  }

  /* ---------- focus movement ---------- */

  private candidates(): HTMLElement[] {
    return Array.from(this.registered).filter(
      (el) =>
        el.getAttribute("data-focus-disabled") !== "true" &&
        el.offsetParent !== null &&
        el.getBoundingClientRect().width > 0
    );
  }

  setActive(el: HTMLElement, fromNav = true): void {
    const prev = this.active;
    if (prev && prev !== el) {
      prev.dataset.state = "visited";
    }
    this.active = el;
    this.clearStates();
    el.dataset.state = "active";
    el.focus({ preventScroll: true });
    // bring into view if needed (scrollable containers)
    el.scrollIntoView({ block: "nearest", inline: "nearest" });
    if (fromNav || prev !== el) this.handlers.onFocusChange?.(el);
  }

  move(dir: Dir): boolean {
    const cur = this.active;
    const cands = this.candidates();
    if (cands.length === 0) return false;
    if (!cur || cur.getAttribute("data-focus-disabled") === "true") {
      // no current focus: pick the nearest to the incoming edge
      const c = pickNearestToEdge(cands, dir);
      if (c) this.setActive(c);
      return true;
    }
    const cr = cur.getBoundingClientRect();
    const dx = cr.left + cr.width / 2;
    const dy = cr.top + cr.height / 2;

    const target = cands.find((el) => {
      const r = el.getBoundingClientRect();
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      switch (dir) {
        case "left":
          return cx < dx - 4 && cy > cr.top - r.height * 0.95 && cy < cr.bottom + r.height * 0.95;
        case "right":
          return cx > dx + 4 && cy > cr.top - r.height * 0.95 && cy < cr.bottom + r.height * 0.95;
        case "up":
          return cy < dy - 4 && cx > cr.left - cr.width * 0.95 && cx < cr.right + cr.width * 0.95;
        case "down":
          return cy > dy + 4 && cx > cr.left - cr.width * 0.95 && cx < cr.right + cr.width * 0.95;
      }
    });
    if (!target) return false;

    // score by perpendicular distance + primary distance
    const scored = cands
      .filter((el) => {
        const r = el.getBoundingClientRect();
        const cx = r.left + r.width / 2;
        const cy = r.top + r.height / 2;
        switch (dir) {
          case "left":
          case "right":
            return (dir === "left" ? cx < dx - 4 : cx > dx + 4) && cy > cr.top - r.height * 0.95 && cy < cr.bottom + r.height * 0.95;
          case "up":
          case "down":
            return (dir === "up" ? cy < dy - 4 : cy > dy + 4) && cx > cr.left - cr.width * 0.95 && cx < cr.right + cr.width * 0.95;
        }
      })
      .map((el) => {
        const r = el.getBoundingClientRect();
        const cx = r.left + r.width / 2;
        const cy = r.top + r.height / 2;
        const primary = dir === "left" ? dx - cx : dir === "right" ? cx - dx : dir === "up" ? dy - cy : cy - dy;
        const perp = dir === "left" || dir === "right" ? Math.abs(cy - dy) : Math.abs(cx - dx);
        const norm = (v: number) => v / Math.max(1, r.width, 60);
        return { el, score: norm(primary) + norm(perp) * 2 };
      })
      .sort((a, b) => a.score - b.score);
    if (scored[0]) {
      this.setActive(scored[0].el);
      return true;
    }
    return false;
  }

  /** Set initial focus to the first registered candidate. */
  focusFirst(): void {
    const cands = this.candidates();
    if (cands.length && (!this.active || this.active.getAttribute("data-focus-disabled") === "true")) {
      this.setActive(cands[0], false);
    }
  }

  focusEl(el: HTMLElement): void {
    if (this.registered.has(el) || el.hasAttribute(FOCUSABLE_ATTR)) {
      this.register(el);
      this.setActive(el, false);
    }
  }

  blur(): void {
    if (this.active) {
      this.active.dataset.state = "";
      this.active = null;
    }
  }

  activate(el: HTMLElement, fromClick: boolean): void {
    this.setActive(el, !fromClick);
    if (fromClick) {
      // A real mouse click is already flowing to the element's own action listener
      // (the tile/crumb/menu-item dispatches its event there). Don't re-click or it
      // double-fires. We only update focus/active state here.
      return;
    }
    // OK key (or programmatic): synthesize a click so the element's own listener runs.
    el.click();
  }

  /* ---------- key handling ---------- */

  private onKey(e: KeyboardEvent): void {
    const code = (e as any).keyCode as number;
    const action = KEYMAP[code] ?? DOM_ARROW[e.key];
    if (!action) return;

    // Ignore keys that belong to <video> native handling (none on webOS webview, but be safe)
    const tag = (document.activeElement?.tagName || "").toLowerCase();
    if (tag === "input" || tag === "textarea") return;

    switch (action) {
      case "left":
      case "up":
      case "right":
      case "down":
        e.preventDefault();
        this.handlers.onNavigate?.(action as Dir);
        this.move(action as Dir);
        break;
      case "ok":
        e.preventDefault();
        if (this.active) {
          this.activate(this.active, false);
        } else {
          this.handlers.onOK?.();
        }
        break;
      case "back":
        e.preventDefault();
        this.handlers.onBack?.();
        break;
      case "blue":
      case "green":
      case "red":
      case "yellow":
        e.preventDefault();
        this.handlers.onColor?.(action as "blue" | "green" | "red" | "yellow");
        break;
      case "play":
        this.handlers.onPlayPause?.();
        break;
      case "stop":
        this.handlers.onStop?.();
        break;
      case "rewind":
        this.handlers.onRewind?.();
        break;
      case "fastforward":
        this.handlers.onFastForward?.();
        break;
      case "search":
        this.handlers.onSearch?.();
        break;
      case "pageup":
      case "pagedown":
        e.preventDefault();
        (document.activeElement as HTMLElement | null)?.scrollBy?.({
          top: action === "pageup" ? -400 : 400,
          behavior: "smooth",
        });
        break;
    }
  }

  destroy(): void {
    this.registered.clear();
    this.active = null;
  }
}

function pickNearestToEdge(cands: HTMLElement[], dir: Dir): HTMLElement | null {
  if (cands.length === 1) return cands[0];
  const W = 1920;
  const H = 1080;
  const edgeX = dir === "left" ? 0 : dir === "right" ? W : W / 2;
  const edgeY = dir === "up" ? 0 : dir === "down" ? H : H / 2;
  return cands
    .map((el) => {
      const r = el.getBoundingClientRect();
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      const d = Math.hypot(cx - edgeX, cy - edgeY);
      return { el, d };
    })
    .sort((a, b) => a.d - b.d)[0]?.el ?? null;
}

let remote: Remote | null = null;
export function getRemote(): Remote {
  if (!remote) remote = new Remote();
  return remote;
}
