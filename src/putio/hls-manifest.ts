// Parse audio renditions out of an HLS master playlist (the put.io
// `media.m3u8` packages the file's audio streams as separate
// EXT-X-MEDIA:TYPE=AUDIO renditions — one URI per language).
//
// Pure text-in/rows-out so it is unit-testable in node and stays clear of the
// Chrome 79 gate (no ES2020+ syntax; the TV's webview runs this bundle).

export interface HlsAudioRendition {
  name: string | null;
  lang: string | null;
  isDefault: boolean;
  uri: string | null;
}

/** Split a tag's attribute list on commas, honoring quoted values. */
function splitAttributes(spec: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < spec.length; i++) {
    const ch = spec.charAt(i);
    if (ch === '"') {
      inQuotes = !inQuotes;
      cur += ch;
    } else if (ch === "," && !inQuotes) {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  if (cur.length) out.push(cur);
  return out;
}

/** `"English"` → `English`; `en` → `en`; empty → null. */
function unquote(v: string): string | null {
  let s = v.trim();
  if (!s) return null;
  if (s.charAt(0) === '"' && s.charAt(s.length - 1) === '"' && s.length >= 2) s = s.slice(1, -1);
  return s || null;
}

export function parseHlsAudioRenditions(manifest: string | null | undefined): HlsAudioRendition[] {
  if (!manifest) return [];
  const rows: HlsAudioRendition[] = [];
  const lines = manifest.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.indexOf("#EXT-X-MEDIA:") !== 0) continue;
    const attrs: Record<string, string | null> = {};
    for (const part of splitAttributes(line.slice("#EXT-X-MEDIA:".length))) {
      const eq = part.indexOf("=");
      if (eq < 0) continue;
      attrs[part.slice(0, eq).trim().toUpperCase()] = unquote(part.slice(eq + 1));
    }
    if ((attrs.TYPE || "").toUpperCase() !== "AUDIO") continue;
    rows.push({
      name: attrs.NAME || null,
      lang: attrs.LANGUAGE || null,
      isDefault: (attrs.DEFAULT || "").toUpperCase() === "YES",
      uri: attrs.URI || null,
    });
  }
  return rows;
}
