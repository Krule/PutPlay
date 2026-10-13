/**
 * Image probing (DOM). A blob URL plus the dimensions its bytes actually
 * decode to — probed off-screen with an Image() so a displayed <img>
 * renders at the right size on frame one (no 0-px flash, no layout jump).
 *
 * Shared by the comic reader (sheet layout) and the library's comic tiles
 * (the cover thumb, whose probe also fills the page cache's w/h so the
 * reader's first sheet is a complete cache hit).
 */
export function probeImage(url: string): Promise<{ url: string; w: number; h: number }> {
  return new Promise((resolve, reject) => {
    const probe = new Image();
    probe.onload = () => resolve({ url, w: probe.naturalWidth, h: probe.naturalHeight });
    probe.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("not a decodable image"));
    };
    probe.src = url;
  });
}
