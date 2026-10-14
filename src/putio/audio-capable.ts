/**
 * Audio classification + the TV's decode-capability record.
 *
 * The webOS webview's decoder is a superset of desktop Chromium (the media
 * element runs on the TV's hardware pipeline), and the supported set varies
 * by model generation and webOS update. There is therefore NO static
 * "decodes X" matrix in this codebase — the runtime is the source of truth.
 * A real play attempt that dies with MEDIA_ERR_SRC_NOT_SUPPORTED records a
 * veto for that family; everything untried stays open (unknown ≠ unsupported).
 */

/** The structural input we care about (PutFile satisfies it). */
export interface AudioLike {
  content_type?: string;
  name?: string;
}

/** Extensions the folder listing may carry for audio, when the content type
 *  is missing or a lie (put.io reports application/octet-stream for some
 *  uploads). Only formats a TV pipeline plausibly decodes — we don't
 *  advertise WMA/WavPack/DSD; those get the honest unsupported state. */
const AUDIO_EXT = /\.(mp3|m4a|flac|ogg|oga|opus|wav|aac|aiff|aif)$/i;

function extOf(name: string): string {
  const i = name.lastIndexOf(".");
  return i > 0 && i < name.length - 1 ? name.slice(i + 1).toLowerCase() : "";
}

/** True when the file is music (as opposed to video/image/archive). */
export function isAudioFile(f: AudioLike): boolean {
  const ct = (f.content_type || "").toLowerCase();
  // a declared type outranks the name: a video or a folder is never music,
  // whatever the filename claims
  if (ct === "application/x-directory" || ct.startsWith("video/")) return false;
  if (ct.startsWith("audio/")) return true;
  return AUDIO_EXT.test(f.name || "");
}

/** The capability family for a file: the extension (the decoder answers to
 *  what the container says it is), falling back to the content-type subtype. */
export function audioFamily(f: AudioLike): string {
  const ext = extOf(f.name || "");
  if (ext) return ext;
  const ct = (f.content_type || "").toLowerCase();
  return ct.includes("/") ? ct.split("/").pop()! : "unknown";
}

/* ---------------- the decode-capability record ----------------
 *
 * Per-TV truth (NOT per-account): it survives sign-out and is written by the
 * play attempt that proved it. Family → verdict.
 */
export type CapRecord = Record<string, "yes" | "no">;

/** Fold one probe result into the record (returns a new record). */
export function applyProbe(rec: CapRecord, family: string, ok: boolean): CapRecord {
  return { ...rec, [family]: ok ? "yes" : "no" };
}

/** Only a RECORDED veto makes a family unsupported. Unknown stays open. */
export function isFamilyUnsupported(rec: CapRecord, family: string): boolean {
  return rec[family] === "no";
}
