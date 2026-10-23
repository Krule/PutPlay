// ASS (SSA v4+) style parsing for the subtitle overlay.
//
// Pure functions: no DOM, no fetch — unit-testable, safe for a worker later.
// Colours are packed &HAABBGGRR& (alpha, blue, green, red); the 6-digit form
// &HBBGGRR& implies alpha 0. Alpha: 0 = opaque … 255 = fully transparent.
// The [V4+ Styles] OutlineColour is \3c — it colours BOTH the outline and the
// shadow (libass behaviour), so no line needs a separate shadow colour by
// default; \3c overrides both, \1a/\3a override the fills' alphas.

import { evalMotion } from "./motion";
import type { ClipRect, MotionSpec, MoveSpec, TBlock } from "./motion";

// --- primitives ------------------------------------------------------------

/** Normalize an ASS hex argument ("&H00FFFF", "H00FFFF", "00FFFF" → "00FFFF"). Real files
 *  commonly omit the trailing & in the style table, so all forms are accepted. */
function assHex(raw: string | undefined): string | null {
  const m = /^&?H?([0-9A-Fa-f]{2,8})&?$/.exec((raw ?? "").trim());
  return m ? m[1] : null;
}

function hexToRgb(h: string): [number, number, number] {
  // red is always the last byte, green the middle one; the 8-digit form
  // merely prepends an alpha byte
  return [parseInt(h.slice(-2), 16), parseInt(h.slice(-4, -2), 16), parseInt(h.slice(-6, -4), 16)];
}

/** Parse an ASS colour (&HAABBGGRR& or &HBBGGRR&, trailing & optional) into [r, g, b];
 *  null if not an ASS colour. */
export function parseAssColor(spec: string | undefined): [number, number, number] | null {
  const h = assHex(spec);
  if (!h || (h.length !== 6 && h.length !== 8)) return null;
  return hexToRgb(h);
}

/** Parse an ASS alpha (&HNN&): 0 = opaque … 255 = fully transparent; null if not one. */
export function parseAssAlpha(spec: string | undefined): number | null {
  const h = assHex(spec);
  return h && h.length === 2 ? parseInt(h, 16) : null;
}

// --- style table ------------------------------------------------------------

export interface AssStyle {
  name: string;
  fontname: string;
  fontsize: number;
  primary: [number, number, number];
  secondary: [number, number, number];
  outlineColor: [number, number, number];
  backColor: [number, number, number];
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strikethrough: boolean;
  scaleX: number;
  scaleY: number;
  spacing: number;
  angle: number;
  borderStyle: number;
  outlineW: number;
  shadow: number;
  alignment: number;
  marginL: number;
  marginR: number;
  marginV: number;
}

export interface AssScriptInfo {
  playResX: number;
  playResY: number;
  wrapStyle: number;
  scaledBorderAndShadow: boolean;
}

export interface AssStyleTable {
  info: AssScriptInfo;
  styles: AssStyle[];
}

const ASS_DEFAULT_INFO: AssScriptInfo = {
  playResX: 384,
  playResY: 288,
  wrapStyle: 0,
  scaledBorderAndShadow: false,
};

function assBoolean(v: string): boolean {
  return parseInt(v, 10) !== 0; // ASS: -1 and 1 are both true, 0 is false
}

function assColor(v: string, fallback: [number, number, number]): [number, number, number] {
  return parseAssColor(v) ?? fallback;
}

/** Split a Style: value into fields per the Format: order; Fontname may itself contain commas. */
function splitStyleLine(value: string, formatLen: number): string[] | null {
  const parts = value.split(",");
  const extra = parts.length - formatLen;
  if (extra < 0) return null;
  if (extra === 0) return parts;
  // the commas belong to Fontname (the only free-text field) — re-merge them
  return [...parts.slice(0, 1), parts.slice(1, 1 + extra).join(","), ...parts.slice(1 + extra)];
}

/** ASS permits \n, \r\n, and \r line endings (real MKV CodecPrivate uses
 *  \r\n). Normalize once so every line consumer (section headers, key: value
 *  lines, Dialogue:) sees clean \n-separated lines. */
function assLines(text: string): string[] {
  return text.replace(/\r\n?/g, "\n").split("\n");
}

/** Lines of the [name] section (line-based: values may themselves contain brackets). */
function assSectionLines(text: string, name: string): string[] {
  const out: string[] = [];
  let inSection = false;
  for (const line of assLines(text)) {
    const m = /^\[([^\]]+)\]\s*$/.exec(line);
    if (m) {
      inSection = m[1] === name;
      continue;
    }
    if (inSection) out.push(line);
  }
  return out;
}

function parseScriptInfo(text: string): AssScriptInfo {
  const info: AssScriptInfo = { ...ASS_DEFAULT_INFO };
  for (const line of assSectionLines(text, "Script Info")) {
    const kv = /^([^:]+):\s*(.*)$/.exec(line);
    if (!kv) continue;
    if (kv[1] === "PlayResX") info.playResX = parseInt(kv[2], 10) || info.playResX;
    else if (kv[1] === "PlayResY") info.playResY = parseInt(kv[2], 10) || info.playResY;
    else if (kv[1] === "WrapStyle") info.wrapStyle = parseInt(kv[2], 10) || 0;
    else if (kv[1] === "ScaledBorderAndShadow") info.scaledBorderAndShadow = /yes|true/i.test(kv[2]);
  }
  return info;
}

function parseStyleLine(value: string, format: string[]): AssStyle | null {
  const fields = splitStyleLine(value, format.length);
  if (!fields) return null;
  const i = (name: string) => format.indexOf(name);
  const f = (name: string) => (i(name) >= 0 ? fields[i(name)] : undefined);
  const s: AssStyle = {
    name: f("Name") ?? "",
    fontname: f("Fontname") ?? "",
    fontsize: parseFloat(f("Fontsize") ?? "24") || 24,
    primary: assColor(f("PrimaryColour") ?? "", [255, 255, 255]),
    secondary: assColor(f("SecondaryColour") ?? "", [0, 0, 255]),
    outlineColor: assColor(f("OutlineColour") ?? "", [0, 0, 0]),
    backColor: assColor(f("BackColour") ?? "", [0, 0, 0]),
    bold: assBoolean(f("Bold") ?? "0"),
    italic: assBoolean(f("Italic") ?? "0"),
    underline: assBoolean(f("Underline") ?? "0"),
    strikethrough: assBoolean(f("StrikeOut") ?? "0"),
    scaleX: parseFloat(f("ScaleX") ?? "100") || 100,
    scaleY: parseFloat(f("ScaleY") ?? "100") || 100,
    spacing: parseFloat(f("Spacing") ?? "0") || 0,
    angle: parseFloat(f("Angle") ?? "0") || 0,
    borderStyle: parseInt(f("BorderStyle") ?? "1", 10) || 1,
    outlineW: parseFloat(f("Outline") ?? "0") || 0,
    shadow: parseFloat(f("Shadow") ?? "0") || 0,
    alignment: parseInt(f("Alignment") ?? "2", 10) || 2,
    marginL: parseInt(f("MarginL") ?? "0", 10) || 0,
    marginR: parseInt(f("MarginR") ?? "0", 10) || 0,
    marginV: parseInt(f("MarginV") ?? "0", 10) || 0,
  };
  return s.name ? s : null;
}

/**
 * Parse an ASS file's [Script Info] + [V4+ Styles] into a style table.
 * Returns null when the text has no [V4+ Styles] section (e.g. plain SRT/VTT).
 */
export function parseAssStyles(text: string): AssStyleTable | null {
  const lines = assSectionLines(text, "V4+ Styles");
  const formatLine = lines.find((l) => l.startsWith("Format:"));
  if (!formatLine) return null;
  const format = formatLine.slice(7).split(",").map((s) => s.trim());
  const styles: AssStyle[] = [];
  for (const line of lines) {
    if (!line.startsWith("Style:")) continue;
    const s = parseStyleLine(line.slice(6).trim(), format);
    if (s) styles.push(s);
  }
  return styles.length ? { info: parseScriptInfo(text), styles } : null;
}

// --- Dialogue lines ---------------------------------------------------------

export interface AssCueSegment {
  text: string;
  italic?: boolean;
  bold?: boolean;
  color?: [number, number, number];
  /** 0 = opaque … 255 = fully transparent (raw ASS alpha) */
  alpha?: number;
  outlineW?: number;
  /** cumulative \blur state at this segment (raw ASS units) */
  blur?: number;
  shadowColor?: [number, number, number];
  shadowAlpha?: number;
}

export interface AssCue {
  start: number;
  end: number;
  text: string;
  layer: number;
  styleName: string;
  /** resolved alignment: inline \an, else the style's, else bottom-centre */
  align: number;
  /** \pos(x,y) in PlayRes units */
  pos?: { x: number; y: number };
  /** inline \fs override in PlayRes units */
  fontSize?: number;
  /** per-segment styling; present whenever the line carried override tags */
  segments?: AssCueSegment[];
  /** motion tags (\fad \clip \t \move \pos \blur), libass semantics */
  motion?: MotionSpec;
}

/** ASS timestamp h:mm:ss.cc (centiseconds) → seconds; -1 on garbage. */
function assTimeToSeconds(t: string): number {
  const m = /^(\d+):(\d{1,2}):(\d{1,2})[.,](\d{1,2})$/.exec(t.trim());
  if (!m) return -1;
  const cents = parseInt(m[4].padEnd(2, "0"), 10); // a 1-digit fraction means 0.1 s
  return parseInt(m[1], 10) * 3600 + parseInt(m[2], 10) * 60 + parseInt(m[3], 10) + cents / 100;
}

/** Inline override state; tags in a {…} block apply to the text after it. */
interface OvrState {
  italic?: boolean;
  bold?: boolean;
  color?: [number, number, number];
  alpha?: number;
  outlineW?: number;
  outlineColor?: [number, number, number];
  shadow?: number;
  shadowColor?: [number, number, number];
  shadowAlpha?: number;
  align?: number;
  pos?: { x: number; y: number };
  fontSize?: number;
  /** the first \pos/\move in text order owns the position (libass EVENT_POSITIONED) */
  positioned?: boolean;
  /** motion tags accumulated in text order */
  motion?: MotionSpec;
}

function styleBaseState(style: AssStyle | null): OvrState {
  if (!style) return {};
  return {
    italic: style.italic,
    bold: style.bold,
    color: style.primary,
    alpha: 0,
    outlineW: style.outlineW,
    outlineColor: style.outlineColor,
    shadow: style.shadow,
    shadowColor: style.outlineColor, // \3c colours outline AND shadow
    shadowAlpha: 0,
  };
}

// --- inline override tags ---------------------------------------------------

/** A parsed override tag: name (numeric class prefix included, e.g. "1a") and
 *  argument — the balanced (…) contents, a &H…& value (both & kept), or the
 *  bare token up to the next backslash (empty string when there is none). */
interface OvrTag {
  name: string;
  arg: string;
}

/**
 * Tokenize an override block (the inside of {…}) into tags.
 *
 * A regex cannot do this: \t's argument may contain nested tags
 * (\t(773,4485,\clip(210,15,430,44))), and VSFilter treats everything from
 * the first backslash inside the parens as part of that argument — so the
 * parens must be walked with a depth counter.
 */
function tokenizeOvrBlock(block: string): OvrTag[] {
  const tags: OvrTag[] = [];
  let i = 0;
  while (i < block.length) {
    if (block[i] !== "\\") { i++; continue; }
    const m = /^\\([0-9]*[a-zA-Z]+)/.exec(block.slice(i));
    if (!m) { i++; continue; } // a stray backslash — skip
    const name = m[1];
    let j = i + m[0].length;
    let arg = "";
    if (block[j] === "(") {
      let depth = 1;
      const start = ++j;
      while (j < block.length && depth > 0) {
        if (block[j] === "(") depth++;
        else if (block[j] === ")") depth--;
        j++;
      }
      // j is one past the matching ) — or at the end (unbalanced block)
      arg = block.slice(start, depth === 0 ? j - 1 : j);
    } else if (block[j] === "&") {
      const close = block.indexOf("&", j + 1);
      if (close < 0) j = block.length;
      else { arg = block.slice(j, close + 1); j = close + 1; }
    } else {
      let k = j;
      while (k < block.length && block[k] !== "\\") k++;
      arg = block.slice(j, k);
      j = k;
    }
    tags.push({ name, arg });
    i = j;
  }
  return tags;
}

function argNumber(raw: string | undefined): number {
  const n = parseFloat((raw ?? "").replace(/[()]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

/** libass argtoi32: the leading number as int32, 0 on garbage. */
function assInt32(raw: string): number {
  const n = Number(raw.trim());
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

/** libass argtod/mystrtod: the leading number as double, 0 on garbage. */
function assFloat(raw: string): number {
  const n = Number.parseFloat(raw.trim());
  return Number.isFinite(n) ? n : 0;
}

/** \pos(x,y): two doubles (libass argtod); null on anything else. */
function parsePos(inner: string): { x: number; y: number } | null {
  const parts = inner.split(",").map((s) => s.trim());
  if (parts.length !== 2) return null;
  const x = parseFloat(parts[0]);
  const y = parseFloat(parts[1]);
  return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
}

/** \move(x1,y1,x2,y2[,t1,t2]): coords doubles, times int32, t1>t2 swapped
 *  (all libass). 4 args = whole cue (t1 = t2 = 0). */
function parseMove(inner: string): MoveSpec | null {
  const parts = inner.split(",").map((s) => s.trim());
  if (parts.length !== 4 && parts.length !== 6) return null;
  const n = parts.map((p) => parseFloat(p));
  if (n.some((v) => !Number.isFinite(v))) return null;
  let t1 = parts.length === 6 ? assInt32(parts[4]) : 0;
  let t2 = parts.length === 6 ? assInt32(parts[5]) : 0;
  if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
  return { x1: n[0], y1: n[1], x2: n[2], y2: n[3], t1, t2 };
}

/** \clip(x0,y0,x1,y1): four int32 (libass argtoi32); null on anything else
 *  (1-2 args are the vector-clip drawing mode — v1 gap). */
function parseClipRect(inner: string): ClipRect | null {
  const parts = inner.split(",").map((s) => s.trim());
  if (parts.length !== 4) return null;
  return [assInt32(parts[0]), assInt32(parts[1]), assInt32(parts[2]), assInt32(parts[3])];
}

function pushMotion(state: OvrState): MotionSpec {
  if (!state.motion) state.motion = { ts: [] };
  return state.motion;
}

/**
 * \pos / \move: libass hands the position to the FIRST of the two in text
 *  order (EVENT_POSITIONED) and ignores the rest; a malformed arg consumes
 *  no slot (libass sets the flag only on well-formed tags).
 */
function applyPosition(state: OvrState, kind: "pos" | "move", inner: string): void {
  if (state.positioned) return;
  if (kind === "pos") {
    const p = parsePos(inner);
    if (!p) return;
    state.positioned = true;
    state.pos = p;
    pushMotion(state).pos = p;
  } else {
    const mv = parseMove(inner);
    if (!mv) return;
    state.positioned = true;
    pushMotion(state).move = mv;
  }
}

/** \fad(i,o): first wins (libass PARSED_FADE); only the 2-arg form is
 *  honoured — 1-arg \fad and 7-arg \fade are no-ops here (v1 gap). */
function applyFad(state: OvrState, inner: string): void {
  if (state.motion?.fad) return;
  const parts = inner.split(",").map((s) => s.trim());
  if (parts.length !== 2) return;
  pushMotion(state).fad = { in: assInt32(parts[0]), out: assInt32(parts[1]) };
}

function applyOvrTag(state: OvrState, name: string, rawArg: string): void {
  switch (name) {
    case "i": state.italic = argNumber(rawArg) !== 0; break;
    case "b": state.bold = argNumber(rawArg) !== 0; break;
    case "fs": state.fontSize = argNumber(rawArg); break;
    case "an": state.align = Math.round(argNumber(rawArg)); break;
    case "bord": state.outlineW = argNumber(rawArg); break;
    case "shad": state.shadow = argNumber(rawArg); break;
    case "pos": applyPosition(state, "pos", rawArg); break;
    case "move": applyPosition(state, "move", rawArg); break;
    case "fad": applyFad(state, rawArg); break;
    case "clip": { const rect = parseClipRect(rawArg); if (rect) pushMotion(state).clip = rect; break; }
    case "blur": {
      const n = rawArg.trim() ? assFloat(rawArg) : 0; // bare \blur resets to 0
      pushMotion(state).blur = n < 0 ? 0 : n; // libass clamps to [0, BLUR_MAX_RADIUS]
      break;
    }
    case "t": applyTBlock(state, rawArg); break;
    case "c":
    case "1c": { const c = parseAssColor(rawArg); if (c) state.color = c; break; }
    case "3c": { const c = parseAssColor(rawArg); if (c) { state.outlineColor = c; state.shadowColor = c; } break; }
    case "1a": { const n = parseAssAlpha(rawArg); if (n !== null) state.alpha = n; break; }
    case "3a": { const n = parseAssAlpha(rawArg); if (n !== null) state.shadowAlpha = n; break; }
    // everything else (\fn \frx \fry \frz \fax \fscx \fsp \iclip \fade \k …)
    // is a v1 gap — ignored, as before.
  }
}

/**
 * \t(a1, a2, …, \tags) — animate tags over a window, libass VSFilter-compat
 * (empirically verified against libass 0.17.5, the MPV renderer): with cnt
 * numeric args — 0: whole cue linear; 1: the number is the accel exponent
 * over the whole cue; 2: t1,t2; 3: t1,t2,accel; >3: no-op (the whole \t is
 * skipped). t2 = 0 means "cue end". The final argument is the lumped tag
 * argument (VSFilter: everything from the backslash to the closing paren —
 * a number right before the backslash stays its own argument) and may hold
 * several tags; v1 honours its \clip target (a nested \pos is a plain
 * first-wins \pos — libass never tweens \pos). A \t with no tag argument is
 * a no-op.
 */
function applyTBlock(state: OvrState, inner: string): void {
  const args = splitTagArgs(inner);
  const tagArg = args[args.length - 1] ?? "";
  if (!tagArg.startsWith("\\")) return;
  const nums = args.slice(0, -1).map(assInt32);
  if (nums.length > 3) return; // libass skips the whole \t
  const block: TBlock = { t1: 0, t2: 0, accel: 1 };
  if (nums.length === 3) { block.t1 = nums[0]; block.t2 = nums[1]; block.accel = assFloat(args[2]); }
  else if (nums.length === 2) { block.t1 = nums[0]; block.t2 = nums[1]; }
  else if (nums.length === 1) { block.accel = assFloat(args[0]); }
  // 0 numbers → whole cue, linear
  for (const tag of tokenizeOvrBlock(tagArg)) {
    if (tag.name === "clip") {
      const rect = parseClipRect(tag.arg);
      if (rect) block.clip = rect;
    } else if (tag.name === "pos") {
      applyPosition(state, "pos", tag.arg);
    }
  }
  pushMotion(state).ts.push(block);
}

/**
 * VSFilter argument split for \t: comma-separated numbers; a backslash
 * terminates the numeric run — the segment before it (if any) becomes its
 * own argument, then everything from the backslash to the end travels as
 * one final argument (the lumped tag argument).
 */
function splitTagArgs(inner: string): string[] {
  const args: string[] = [];
  let cur = "";
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (ch === ",") {
      if (cur.trim()) args.push(cur.trim());
      cur = "";
    } else if (ch === "\\") {
      if (cur.trim()) args.push(cur.trim());
      args.push(inner.slice(i));
      return args;
    } else {
      cur += ch;
    }
  }
  if (cur.trim()) args.push(cur.trim());
  return args;
}

function applyOvrBlock(state: OvrState, block: string): void {
  for (const tag of tokenizeOvrBlock(block)) applyOvrTag(state, tag.name, tag.arg);
}

function segmentFromState(rawText: string, s: OvrState): AssCueSegment {
  return {
    text: rawText.replace(/\\N/g, "\n"),
    ...(s.italic !== undefined ? { italic: s.italic } : {}),
    ...(s.bold !== undefined ? { bold: s.bold } : {}),
    ...(s.color !== undefined ? { color: s.color } : {}),
    ...(s.alpha !== undefined ? { alpha: s.alpha } : {}),
    ...(s.outlineW !== undefined ? { outlineW: s.outlineW } : {}),
    ...(s.motion?.blur !== undefined ? { blur: s.motion.blur } : {}),
    ...(s.shadowColor !== undefined ? { shadowColor: s.shadowColor } : {}),
    ...(s.shadowAlpha !== undefined ? { shadowAlpha: s.shadowAlpha } : {}),
  };
}

/** Split a Dialogue text field into styled segments by its {…} override blocks. */
function parseDialogueText(raw: string, base: OvrState): { segments: AssCueSegment[] | null; state: OvrState } {
  // split with a full-match capture: [text0, block0, text1, block1, …, textN]
  const parts = raw.split(/(\{[^{}]*\})/);
  const state: OvrState = { ...base };
  let hasTags = false;
  const segs: AssCueSegment[] = [];
  for (const chunk of parts) {
    // an ASS tag block always starts with a backslash — a plain {note} without
    // one is literal text and must survive (same rule as vttToCues)
    if (chunk.startsWith("{") && chunk.endsWith("}") && chunk.includes("\\")) {
      hasTags = true;
      applyOvrBlock(state, chunk.slice(1, -1));
      continue;
    }
    if (!chunk) continue;
    segs.push(segmentFromState(chunk, state));
  }
  return { segments: hasTags && segs.length ? segs : null, state };
}

/** Parse one Dialogue: line (including its "Dialogue:" prefix) into a cue;
 *  null on malformed lines. */
function parseDialogueLine(line: string, styleByName: Map<string, AssStyle>, info: AssScriptInfo): AssCue | null {
  const fields = line.slice(9).split(",");
  if (fields.length < 10) return null;
  // Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text…
  const start = assTimeToSeconds(fields[1]);
  const end = assTimeToSeconds(fields[2]);
  if (start < 0 || end <= start) return null;
  const rawText = fields.slice(9).join(","); // the text may contain commas
  const style = styleByName.get(fields[3]) ?? null;
  const { segments, state } = parseDialogueText(rawText, styleBaseState(style));
  const cue: AssCue = {
    start,
    end,
    text: segments ? segments.map((s) => s.text).join("") : rawText.replace(/\\N/g, "\n"),
    layer: parseInt(fields[0], 10) || 0,
    styleName: fields[3] ?? "",
    align: state.align ?? style?.alignment ?? 2,
  };
  if (state.pos) cue.pos = state.pos;
  if (state.fontSize !== undefined) cue.fontSize = state.fontSize;
  if (segments) cue.segments = segments;
  if (state.motion) {
    // libass: an animated clip without a static \clip animates from the full
    // PlayRes rectangle (the render context's initial clip state)
    const m = state.motion;
    if (!m.clip && m.ts.some((b) => b.clip)) m.clip = [0, 0, info.playResX, info.playResY];
    cue.motion = m;
  }
  return cue;
}

/**
 * Parse the Dialogue: lines of an ASS file into cues. The file's own
 * [V4+ Styles] (when present) supplies each cue's base style state and
 * default alignment, so the resulting cues are self-contained.
 */
export function parseAssCues(text: string): AssCue[] {
  const table = parseAssStyles(text);
  const styleByName = new Map((table?.styles ?? []).map((s) => [s.name, s]));
  const info = table?.info ?? ASS_DEFAULT_INFO;
  const cues: AssCue[] = [];
  for (const line of assLines(text)) {
    if (!line.startsWith("Dialogue:")) continue;
    const cue = parseDialogueLine(line, styleByName, info);
    if (cue) cues.push(cue);
  }
  return cues;
}

// --- rendered lines --------------------------------------------------------

/** A cue as far as the renderer cares: both AssCue (parsed) and SubtitleCue
 *  (put.io SRT/VTT) fit this shape. */
export interface AnyCue {
  start: number;
  end: number;
  text: string;
  layer?: number;
  styleName?: string;
  align?: number;
  pos?: { x: number; y: number };
  fontSize?: number;
  segments?: AssCueSegment[];
  motion?: MotionSpec;
}

export interface RenderedSegment {
  text: string;
  italic: boolean;
  bold: boolean;
  color: string;
  /** 0…1 — 1 = fully opaque */
  opacity: number;
  /** box-px \blur for this segment only (set when the line's blurs differ) */
  blurPx?: number;
  /**
   * This segment's own outline (box px + css colour), set only when it
   * differs from the line's — libass strokes each glyph with the outline
   * state at its point in the text. The stroke layer falls back to the
   * line's outline for a segment without its own.
   */
  outlinePx?: number;
  outlineColor?: string;
}

export interface RenderedLine {
  text: string;
  /** 1-9, numpad layout (2 = bottom-centre, 8 = top-centre) */
  align: number;
  color: string;
  opacity: number;
  fontFamily: string;
  fontSizePx: number;
  /**
   * libass-exact top-row anchor in box px (present when the cue resolved a
   * style — the ASS path): MarginV·boxScale minus the CSS line box's
   * (1.4-1)/2 em half-leading, so the baseline lands where libass puts it
   * (VALIGN_TOP: baseline = MarginV screen px + first-line ascent). Without
   * a style (the SRT path) this stays undefined and the 10%-of-height
   * heuristic anchor is used.
   */
  anchorTopPx?: number;
  outlinePx: number;
  outlineColor: string;
  shadowPx: number;
  shadowColor: string;
  /** \pos scaled to video-box pixels */
  pos?: { xPx: number; yPx: number };
  /**
   * Vertical nudge (px) so two cues that are live at the same instant in the
   * same anchor cell don't overwrite each other (libass / native-cue
   * behaviour — the MPV frame shows gold over white, never gold inside
   * white). Positive = down (top/middle cells), negative = up (bottom
   * cells). 0 for the first cue in a cell and for \pos lines (v1: explicit
   * positions are not stacked).
   */
  yOffsetPx: number;
  /** per-segment styling; empty when the whole line is uniform */
  segments: RenderedSegment[];
  /**
   * Per-frame motion state (present when the cue carries \fad/\clip/\move/\t):
   * opacityMul multiplies the line's opacity; clip is a CSS inset() in box px
   * (top/right/bottom/left); pos overrides the anchored placement in box px.
   */
  motionFrame?: {
    opacityMul: number;
    clip?: { top: number; right: number; bottom: number; left: number };
    pos?: { xPx: number; yPx: number };
  };
  /**
   * The line needs a stroke layer under the fill (libass draws each line as
   * outline-then-fill bitmaps): true when any part of it carries an outline
   * wider than a hairline. The stroke layer is the same text in the outline
   * colour, stroked at 2× the outline width (half hides under the fill),
   * blurred with the same \blur — see the Player's subs-stroke template.
   */
  hasStroke: boolean;
  /**
   * The line's uniform \blur in box px (0 = none). When the segments' blurs
   * differ, this is 0 and each segment carries its own `blurPx` instead.
   */
  blurPx: number;
  /**
   * Line-level bold/italic: the first segment's state when the cue carries
   * styling segments, else the style's. A segment-less line (no styling
   * overrides) is still stroked when the STYLE has an outline — the ring
   * must render its text in the same weight/face as the fill layer or the
   * punch misaligns, so the line carries the style's own flags.
   */
  bold: boolean;
  italic: boolean;
}

function alphaToOpacity(alpha: number): number {
  return +((255 - alpha) / 255).toFixed(3);
}

function cssColor(c: [number, number, number], alpha: number | undefined): string {
  if (alpha === undefined || alpha <= 0) return `rgb(${c[0]}, ${c[1]}, ${c[2]})`;
  const op = alphaToOpacity(alpha);
  return op >= 1 ? `rgb(${c[0]}, ${c[1]}, ${c[2]})` : `rgba(${c[0]}, ${c[1]}, ${c[2]}, ${op})`;
}

function cssOpacity(alpha: number | undefined): number {
  return alpha === undefined ? 1 : alphaToOpacity(alpha);
}

function findStyle(table: AssStyleTable | null, cue: AnyCue): AssStyle | null {
  if (!table) return null;
  if (cue.styleName) {
    const byName = table.styles.find((s) => s.name === cue.styleName);
    if (byName) return byName;
  }
  // SRT path: put.io lost the Style: field — the cue's \an (if any) is all we
  // have, so map it to the first style with that alignment (documented loss).
  const align = cue.align ?? 2;
  return table.styles.find((s) => s.alignment === align) ?? null;
}

/**
 * Resolve active cues into per-line render descriptors. Pure: no DOM, no
 * fetch. Colours/positions come from the parsed instructions (style table +
 * Dialogue fields + inline overrides), never from assumptions.
 *
 * `scale` is the user's subtitle-size setting — it multiplies font size only;
 * outline/shadow track the video box (ScaledBorderAndShadow semantics).
 */
export function renderSubtitleLines(
  cues: AnyCue[],
  t: number,
  table: AssStyleTable | null,
  box: { w: number; h: number },
  scale: number,
  metrics?: SubMetrics
): RenderedLine[] {
  const info = table?.info;
  const playResX = info?.playResX || 384;
  const playResY = info?.playResY || 288;
  const boxScale = box.h / playResY;
  const ordered = [...cues].sort(
    (a, b) => (a.layer ?? 0) - (b.layer ?? 0) || a.start - b.start
  );
  const ctx = { box, boxScale, scale, playResX, playResY, t, metrics };
  const lines = ordered.map((cue) => buildLine(cue, findStyle(table, cue), ctx));
  applyCollisionOffsets(lines, ordered);
  return lines;
}

/**
 * Font-metric probe the renderer uses for the libass-exact anchor. The
 * half-leading (space above the glyphs inside the line box) is
 * font-specific; when a probe is supplied (the player, which has a DOM) the
 * anchor uses the measured value, else the 0.2·fontSize estimate.
 * libass places the baseline at MarginV + ascent, which puts the line box
 * top at MarginV·S − halfLeading — the ascent cancels.
 */
export interface SubMetrics {
  halfLeadingPx(fontFamily: string, fontSizePx: number): number;
}

interface RenderCtx {
  box: { w: number; h: number };
  boxScale: number;
  scale: number;
  playResX: number;
  playResY: number;
  t: number;
  metrics?: SubMetrics;
}

/**
 * libass's \blur R is a Gaussian RADIUS, not the standard deviation: the
 * kernel is pre-scaled by 2/sqrt(ln 256) (ass_render.c `blur_radius_scale`),
 * so the CSS blur() value — which takes the sigma — is R x 0.8493. Verified
 * against a libass 0.17.5 PPM render of the title card (2026-10-22).
 */
const BLUR_SIGMA = 2 / Math.sqrt(Math.log(256));

/** One cue → one rendered line at time `ctx.t`. */
function buildLine(cue: AnyCue, style: AssStyle | null, ctx: RenderCtx): RenderedLine {
  const { box, boxScale, scale, playResX, playResY, t } = ctx;
  const segs = cue.segments ?? [];
  const first = segs[0];
  const color = first?.color ?? style?.primary ?? [255, 255, 255];
  const outlineColor = first?.shadowColor ?? style?.outlineColor ?? [0, 0, 0];
  // \3c colours BOTH outline and shadow (libass) — until a \3a-only case
  // splits them, both render from the same value
  const outlineCss = cssColor(outlineColor, first?.shadowAlpha);
  const fontSize = (cue.fontSize ?? style?.fontsize ?? 24) * boxScale * scale;
  // per-frame motion state: fades, the clip window, and \move positions are
  // evaluated at `t` — a static cue renders identically at every t
  const frame = cue.motion
    ? evalMotion(cue.motion, (t - cue.start) * 1000, (cue.end - cue.start) * 1000)
    : null;
  // per-segment \blur from the parser's cumulative state (libass blurs each
  // glyph with the state at its point in the text); the value is a CSS
  // blur() sigma (BLUR_SIGMA), and when every segment shares one value a
  // single layer-level filter covers it
  const segBlurPx = segs.map((sg) => (sg.blur ?? 0) * boxScale * BLUR_SIGMA);
  const baseBlurPx = segBlurPx.length ? segBlurPx[0] : 0;
  const uniformBlur = segBlurPx.every((b) => b === baseBlurPx);
  const toBoxPx = (x: number, y: number) => ({
    xPx: Math.round((x / playResX) * box.w),
    yPx: Math.round((y / playResY) * box.h),
  });
  const line: RenderedLine = {
    text: cue.text,
    align: cue.align ?? style?.alignment ?? 2,
    color: cssColor(color, first?.alpha),
    // element opacity stays 1 — visibility lives in the (per-segment) colour
    // alpha, where it belongs: a line whose first segment is transparent
    // may still carry an opaque one (the title card's hollow "Diaries")
    opacity: 1,
    fontFamily: style?.fontname || "sans-serif",
    fontSizePx: Math.max(1, Math.round(fontSize * 10) / 10),
    ...(style
      ? {
          anchorTopPx:
            Math.round(
              (
                style.marginV * boxScale -
                (ctx.metrics?.halfLeadingPx(style.fontname, fontSize) ??
                  0.2 * fontSize)
              ) * 10
            ) / 10,
        }
      : {}),
    outlinePx: (first?.outlineW ?? style?.outlineW ?? 0) * boxScale,
    outlineColor: outlineCss,
    shadowPx: (style?.shadow ?? 0) * boxScale,
    shadowColor: outlineCss,
    yOffsetPx: 0, // applyCollisionOffsets fills it in below
    segments: segs.map((sg, i) => ({
      text: sg.text,
      italic: sg.italic ?? false,
      bold: sg.bold ?? false,
      color: cssColor(sg.color ?? color, sg.alpha ?? first?.alpha),
      opacity: cssOpacity(sg.alpha ?? first?.alpha),
      ...(uniformBlur ? {} : { blurPx: segBlurPx[i] }),
    })),
    hasStroke: segs.length
      ? segs.some((sg) => (sg.outlineW ?? style?.outlineW ?? 0) * boxScale > 0.5)
      : (style?.outlineW ?? 0) * boxScale > 0.5,
    blurPx: uniformBlur ? baseBlurPx : 0,
    bold: segs.length ? !!segs[0].bold : !!style?.bold,
    italic: segs.length ? !!segs[0].italic : !!style?.italic,
  };
  // Per-segment outline: when a segment's effective outline (its \bord/
  // \3c/\3a state) diverges from the line's, it carries its own — the
  // stroke layer falls back to the line's outline for the rest
  cue.segments?.forEach((sg, i) => {
    const rendered = line.segments[i];
    if (!rendered) return;
    const effPx = (sg.outlineW ?? style?.outlineW ?? 0) * ctx.boxScale;
    const effColor = cssColor(
      sg.shadowColor ?? style?.outlineColor ?? [0, 0, 0],
      sg.shadowAlpha
    );
    if (effPx > 0.5 && (effPx !== line.outlinePx || effColor !== line.outlineColor)) {
      rendered.outlinePx = effPx;
      rendered.outlineColor = effColor;
    }
  });
  if (frame) {
    const mf: NonNullable<RenderedLine["motionFrame"]> = { opacityMul: frame.opacityMul };
    if (frame.clip) mf.clip = clipToBoxPx(frame.clip, box, playResX, playResY);
    line.motionFrame = mf;
    // frame.pos covers \move AND static \pos (evaluator: move ? moveAt :
    // motion.pos); mf.pos is the documented per-frame datum, line.pos drives
    // the template's absolute placement (same anchor convention as a static
    // \pos)
    if (frame.pos) {
      mf.pos = toBoxPx(frame.pos.x, frame.pos.y);
      line.pos = mf.pos;
    }
  } else if (cue.pos) {
    line.pos = toBoxPx(cue.pos.x, cue.pos.y);
  }
  return line;
}

/** One rendered line's vertical footprint: font size × line-height × lines. */
function estLineHeightPx(l: RenderedLine): number {
  const lineCount = 1 + (l.text.match(/\n/g) || []).length;
  return Math.round(l.fontSizePx * 1.4 * lineCount * 10) / 10;
}

/** PlayRes clip rect [x0,y0,x1,y1] → CSS inset() order in box px. */
function clipToBoxPx(
  clip: ClipRect,
  box: { w: number; h: number },
  playResX: number,
  playResY: number
): { top: number; right: number; bottom: number; left: number } {
  return {
    top: (clip[1] / playResY) * box.h,
    right: ((playResX - clip[2]) / playResX) * box.w,
    bottom: ((playResY - clip[3]) / playResY) * box.h,
    left: (clip[0] / playResX) * box.w,
  };
}

function cuesOverlapTimes(a: AnyCue, b: AnyCue): boolean {
  return a.start < b.end && b.start < a.end;
}

/** Cells 1-3 are bottom-anchored: a collision pushes lines UP. */
function cellIsBottom(align: number): boolean {
  return align >= 1 && align <= 3;
}

/**
 * libass clears its collision detection on \t, \pos, \move and \org — such
 * cues must overlap exactly as authored (the title card's two lines stack on
 * each other on purpose). A line is position-free when any of those is live.
 */
function isPositionFree(cue: AnyCue): boolean {
  const m = cue.motion;
  if (!m) return false;
  return m.ts.length > 0 || m.pos !== undefined || m.move !== undefined;
}

/**
 * A line is pushed by the full footprint of every earlier line in the same
 * anchor cell that overlaps it in time. `cues` is 1:1 with `lines` (both
 * follow the layer/start/file order) — that order is the stacking order,
 * which is what MPV shows.
 */
function applyCollisionOffsets(lines: RenderedLine[], cues: AnyCue[]): void {
  lines.forEach((line, i) => {
    if (line.pos || isPositionFree(cues[i])) return; // exact spot or libass-exempt
    let total = 0;
    for (let j = 0; j < i; j++) {
      const earlier = lines[j];
      if (earlier.pos || isPositionFree(cues[j]) || earlier.align !== line.align) continue;
      if (cuesOverlapTimes(cues[j], cues[i])) total += estLineHeightPx(earlier);
    }
    line.yOffsetPx = total === 0 ? 0 : cellIsBottom(line.align) ? -total : total;
  });
}
