/**
 * Subtitle helpers: fetch put.io subtitles and convert to WebVTT (the only
 * format the webOS webview renders). put.io serves SRT/ASS.
 */

export function srtToVtt(srt: string): string {
  // normalize line endings + strip BOM
  const text = srt.replace(/^\ufeff/, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const blocks = text.split(/\n{2,}/);
  const cues: string[] = [];
  for (let block of blocks) {
    block = block.trim();
    if (!block) continue;
    const lines = block.split("\n");
    // find the timestamp line (contains -->)
    let ti = -1;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes("-->")) {
        ti = i;
        break;
      }
    }
    if (ti === -1) continue;
    const ts = lines[ti].replace(/(\d+):(\d+):(\d+)[,.](\d+)/, (m, h, mm, ss, f) => {
      const ff = f.length >= 2 ? f.padEnd(3, "0").slice(0, 3) : f.padStart(3, "0");
      return `${parseInt(h, 10)}:${mm}:${ss}.${ff}`;
    });
    const body = lines
      .slice(ti + 1)
      .join("\n")
      .replace(/<[^>]+>/g, (tag) => {
        // crude srt tags → vtt
        const t = tag.toLowerCase();
        if (t.includes("c")) return "";
        if (t.includes("i") && t.startsWith("<i")) return "<i>";
        if (t.includes("b") && t.startsWith("<b")) return "<b>";
        if (t.includes("u") && t.startsWith("<u")) return "<u>";
        return "</i></b></u>";
      });
    cues.push(`${ts}\n${body}`.trimEnd());
  }
  if (!cues.length) return "WEBVTT\n";
  return "WEBVTT\n\n" + cues.join("\n\n") + "\n";
}

/** ASS/SSA → drop events to an empty VTT (ASS styling isn't renderable; we'd rather none than broken). */
export function assToVtt(_ass: string): string {
  return "WEBVTT\n";
}

export function subtitleToVtt(content: string, format: string): string {
  switch (format.toLowerCase()) {
    case "srt":
    case "sub":
      return srtToVtt(content);
    case "vtt":
      return content;
    case "ass":
    case "ssa":
      return assToVtt(content);
    default:
      // best effort: if it already has a WEBVTT header keep it, else treat as srt
      return content.trimStart().startsWith("WEBVTT") ? content : srtToVtt(content);
  }
}

export interface LoadedSubtitle {
  id: string;
  language: string;
  languageCode: string;
  name: string;
  url: string;
  format: string;
  blobURL?: string; // created after conversion
}

/**
 * Fetch a put.io subtitle file and produce a WebVTT blob URL the <track> can load.
 */
export async function loadSubtitle(
  contentUrl: string,
  format: string
): Promise<string | null> {
  try {
    const res = await fetch(contentUrl);
    if (!res.ok) return null;
    const text = await res.text();
    const vtt = subtitleToVtt(text, format);
    const blob = new Blob([vtt], { type: "text/vtt" });
    return URL.createObjectURL(blob);
  } catch {
    return null;
  }
}
