// ASS (SSA v4+) style parsing for the subtitle overlay.
//
// Pure functions: no DOM, no fetch — unit-testable, safe for a worker later.
// Colours are packed &HAABBGGRR& (alpha, blue, green, red); the 6-digit form
// &HBBGGRR& implies alpha 0. Alpha: 0 = opaque … 255 = fully transparent.
// The [V4+ Styles] OutlineColour is \3c — it colours BOTH the outline and the
// shadow (libass behaviour), so no line needs a separate shadow colour by
// default; \3c overrides both, \1a/\3a override the fills' alphas.

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

// tag name: optional numeric class prefix + letters; arg: (…), &HHEX&, or bare number
const OVR_TAG_RE = /\\([0-9]*[a-zA-Z]+)(\([^)]*\)|&H[0-9A-Fa-f]+&|-?\d+(?:\.\d+)?(?:[,-]\d+(?:\.\d+)?)?)?/g;

function argNumber(raw: string | undefined): number {
  const n = parseFloat((raw ?? "").replace(/[()]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

function applyOvrTag(state: OvrState, name: string, rawArg: string | undefined): void {
  switch (name) {
    case "i": state.italic = argNumber(rawArg) !== 0; break;
    case "b": state.bold = argNumber(rawArg) !== 0; break;
    case "fs": state.fontSize = argNumber(rawArg); break;
    case "an": state.align = Math.round(argNumber(rawArg)); break;
    case "bord": state.outlineW = argNumber(rawArg); break;
    case "shad": state.shadow = argNumber(rawArg); break;
    case "pos": {
      const [x, y] = (rawArg ?? "").replace(/[()]/g, "").split(",").map((p) => parseFloat(p));
      if (Number.isFinite(x) && Number.isFinite(y)) state.pos = { x, y };
      break;
    }
    case "c":
    case "1c": { const c = parseAssColor(rawArg); if (c) state.color = c; break; }
    case "3c": { const c = parseAssColor(rawArg); if (c) { state.outlineColor = c; state.shadowColor = c; } break; }
    case "1a": { const n = parseAssAlpha(rawArg); if (n !== null) state.alpha = n; break; }
    case "3a": { const n = parseAssAlpha(rawArg); if (n !== null) state.shadowAlpha = n; break; }
    // motion/effect tags (\fad \blur \clip \t \move \frx \fry \fax \fscx \fsp …)
    // affect neither text nor colour — intentionally ignored.
  }
}

function applyOvrBlock(state: OvrState, block: string): void {
  OVR_TAG_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = OVR_TAG_RE.exec(block))) applyOvrTag(state, m[1], m[2]);
}

function segmentFromState(rawText: string, s: OvrState): AssCueSegment {
  return {
    text: rawText.replace(/\\N/g, "\n"),
    ...(s.italic !== undefined ? { italic: s.italic } : {}),
    ...(s.bold !== undefined ? { bold: s.bold } : {}),
    ...(s.color !== undefined ? { color: s.color } : {}),
    ...(s.alpha !== undefined ? { alpha: s.alpha } : {}),
    ...(s.outlineW !== undefined ? { outlineW: s.outlineW } : {}),
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
function parseDialogueLine(line: string, styleByName: Map<string, AssStyle>): AssCue | null {
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
  const cues: AssCue[] = [];
  for (const line of assLines(text)) {
    if (!line.startsWith("Dialogue:")) continue;
    const cue = parseDialogueLine(line, styleByName);
    if (cue) cues.push(cue);
  }
  return cues;
}

// --- rendered lines --------------------------------------------------------

/** A cue as far as the renderer cares: both AssCue (parsed) and SubtitleCue
 *  (put.io SRT/VTT) fit this shape. */
interface AnyCue {
  start: number;
  end: number;
  text: string;
  layer?: number;
  styleName?: string;
  align?: number;
  pos?: { x: number; y: number };
  fontSize?: number;
  segments?: AssCueSegment[];
}

export interface RenderedSegment {
  text: string;
  italic: boolean;
  bold: boolean;
  color: string;
  /** 0…1 — 1 = fully opaque */
  opacity: number;
}

export interface RenderedLine {
  text: string;
  /** 1-9, numpad layout (2 = bottom-centre, 8 = top-centre) */
  align: number;
  color: string;
  opacity: number;
  fontFamily: string;
  fontSizePx: number;
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
  _t: number,
  table: AssStyleTable | null,
  box: { w: number; h: number },
  scale: number
): RenderedLine[] {
  const info = table?.info;
  const playResX = info?.playResX || 384;
  const playResY = info?.playResY || 288;
  const boxScale = box.h / playResY;
  const ordered = [...cues].sort(
    (a, b) => (a.layer ?? 0) - (b.layer ?? 0) || a.start - b.start
  );
  const lines: RenderedLine[] = [];
  for (const cue of ordered) {
    const style = findStyle(table, cue);
    const segs = cue.segments ?? [];
    const first = segs[0];
    const color = first?.color ?? style?.primary ?? [255, 255, 255];
    const outlineColor = first?.shadowColor ?? style?.outlineColor ?? [0, 0, 0];
    // \3c colours BOTH outline and shadow (libass) — until a \3a-only case
    // splits them, both render from the same value
    const outlineCss = cssColor(outlineColor, first?.shadowAlpha);
    const fontSize = (cue.fontSize ?? style?.fontsize ?? 24) * boxScale * scale;
    const line: RenderedLine = {
      text: cue.text,
      align: cue.align ?? style?.alignment ?? 2,
      color: cssColor(color, first?.alpha),
      opacity: cssOpacity(first?.alpha),
      fontFamily: style?.fontname || "sans-serif",
      fontSizePx: Math.max(1, Math.round(fontSize * 10) / 10),
      outlinePx: (first?.outlineW ?? style?.outlineW ?? 0) * boxScale,
      outlineColor: outlineCss,
      shadowPx: (style?.shadow ?? 0) * boxScale,
      shadowColor: outlineCss,
      yOffsetPx: 0, // applyCollisionOffsets fills it in below
      segments: segs.map((sg) => ({
        text: sg.text,
        italic: sg.italic ?? false,
        bold: sg.bold ?? false,
        color: cssColor(sg.color ?? color, sg.alpha ?? first?.alpha),
        opacity: cssOpacity(sg.alpha ?? first?.alpha),
      })),
    };
    if (cue.pos) {
      line.pos = {
        xPx: Math.round((cue.pos.x / playResX) * box.w),
        yPx: Math.round((cue.pos.y / playResY) * box.h),
      };
    }
    lines.push(line);
  }
  applyCollisionOffsets(lines, ordered);
  return lines;
}

/** One rendered line's vertical footprint: font size × line-height × lines. */
function estLineHeightPx(l: RenderedLine): number {
  const lineCount = 1 + (l.text.match(/\n/g) || []).length;
  return Math.round(l.fontSizePx * 1.4 * lineCount * 10) / 10;
}

function cuesOverlapTimes(a: AnyCue, b: AnyCue): boolean {
  return a.start < b.end && b.start < a.end;
}

/** Cells 1-3 are bottom-anchored: a collision pushes lines UP. */
function cellIsBottom(align: number): boolean {
  return align >= 1 && align <= 3;
}

/**
 * A line is pushed by the full footprint of every earlier line in the same
 * anchor cell that overlaps it in time. `cues` is 1:1 with `lines` (both
 * follow the layer/start/file order) — that order is the stacking order,
 * which is what MPV shows.
 */
function applyCollisionOffsets(lines: RenderedLine[], cues: AnyCue[]): void {
  lines.forEach((line, i) => {
    if (line.pos) return; // v1: \pos lines keep their exact spot
    let total = 0;
    for (let j = 0; j < i; j++) {
      const earlier = lines[j];
      if (earlier.pos || earlier.align !== line.align) continue;
      if (cuesOverlapTimes(cues[j], cues[i])) total += estLineHeightPx(earlier);
    }
    line.yOffsetPx = total === 0 ? 0 : cellIsBottom(line.align) ? -total : total;
  });
}
