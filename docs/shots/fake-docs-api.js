/* Browser init-script for the DOCS screenshots: a small fake put.io API
 * whose library is the open-content demo set (see CREDITS.md):
 *
 *   root:
 *     Paintings/            (folder: two Van Gogh JPGs — image viewer)
 *     Krazy Kat 1918-1924   (krazy-kat-1918-1924.cbz — the comic reader)
 *     Gallery               (gallery.zip — one image + a note: archive)
 *     Maple Leaf Rag (1925) (mp3 — the now-playing strip)
 *     Steamboat Willie 1928 (mp4 — THE playable video: public domain,
 *                            from archive.org; The General / Nosferatu are
 *                            PD film name-tiles, never played in the shots)
 *
 * Run:  python3 -m http.server 8642   (repo root)
 *       agent-browser open "http://localhost:8642/?seedtoken" \
 *         --init-script docs/shots/fake-docs-api.js
 */
(function () {
  var TOKEN = "fake-oauth-token";
  try {
    if (location.search.indexOf("seedtoken") !== -1)
      localStorage.setItem("putio.oauthToken", JSON.stringify(TOKEN));
  } catch (e) {}

  var GB = 1024 * 1024 * 1024;
  var accountInfo = {
    info: {
      account_active: true,
      account_status: "active",
      family_owner: "Demo Library",
      mail: "demo@example.com",
      disk: { avail: 6 * GB, size: 10 * GB, used: 4 * GB },
      download_token: "fake-dl-token",
      settings: { subtitle_languages: ["eng"] }
    },
    status: "ok"
  };

  var F = {
    // the demo files — human names, because this is the marketing library
    paintings: {
      id: 1,
      name: "Paintings",
      size: 0,
      content_type: "application/x-directory",
      parent_id: null,
      is_folder: 1,
      start_from: 0
    },
    kkCover: {
      id: 11,
      name: "The Starry Night (1889).jpg",
      size: 780240,
      content_type: "image/jpeg",
      parent_id: 1,
      is_folder: 0,
      start_from: 0
    },
    kkRhone: {
      id: 12,
      name: "Starry Night Over the Rhone (1888).jpg",
      size: 1360948,
      content_type: "image/jpeg",
      parent_id: 1,
      is_folder: 0,
      start_from: 0
    },
    comic: {
      id: 21,
      name: "Krazy Kat 1918-1924.cbz",
      size: 2592347,
      content_type: "application/octet-stream", // put.io knows no "cbz"
      parent_id: null,
      is_folder: 0,
      start_from: 0
    },
    gallery: {
      id: 22,
      name: "Gallery.zip",
      size: 1361770,
      content_type: "application/zip",
      parent_id: null,
      is_folder: 0,
      start_from: 0
    },
    rag: {
      id: 31,
      name: "Maple Leaf Rag (1925).mp3",
      size: 2989298,
      content_type: "audio/mpeg",
      parent_id: null,
      is_folder: 0,
      start_from: 0
    },
    sbw: {
      id: 41,
      name: "Steamboat Willie (1928).mp4",
      size: 3640150,
      content_type: "video/mp4",
      parent_id: null,
      is_folder: 0,
      is_mp4_available: true,
      start_from: 0
    },
    general: {
      id: 42,
      name: "The General (1926).mp4",
      size: 683000000,
      content_type: "video/mp4",
      parent_id: null,
      is_folder: 0,
      is_mp4_available: true,
      start_from: 0
    },
    nosferatu: {
      id: 43,
      name: "Nosferatu (1922).mp4",
      size: 1204000000,
      content_type: "video/mp4",
      parent_id: null,
      is_folder: 0,
      is_mp4_available: true,
      start_from: 0
    }
  };

  var ROOT_LISTING = [F.paintings, F.comic, F.gallery, F.rag, F.sbw, F.general, F.nosferatu];
  var PAINTINGS_LISTING = [F.kkCover, F.kkRhone];
  var ALL = [F.paintings, F.kkCover, F.kkRhone, F.comic, F.gallery, F.rag, F.sbw, F.general, F.nosferatu];

  /* /stream targets — the zip/cbz paths must honour Range (the parser's
   * tail read + per-entry reads depend on it). */
  var STREAM = {
    11: "/docs/shots/fixtures/starry-night-1889.jpg",
    12: "/docs/shots/fixtures/starry-rhone-1888.jpg",
    21: "/docs/shots/fixtures/krazy-kat-1918-1924.cbz",
    22: "/docs/shots/fixtures/gallery.zip",
    31: "/docs/shots/fixtures/maple-leaf-rag-1925.mp3",
    41: "/docs/shots/fixtures/steamboat-willie-1928.mp4", // the REAL PD clip — the player shot plays it
    42: "/test/e2e/testvid.mp4",
    43: "/test/e2e/testvid.mp4"
  };

  var origFetch = window.fetch.bind(window);

  window.fetch = function (input, init) {
    var url = typeof input === "string" ? input : (input && input.url) || "";
    if (url.indexOf("https://api.put.io/") !== 0) return origFetch(input, init);
    var p;
    try { p = new URL(url).pathname; } catch (e) { p = ""; }
    var ms = p.match(/\/files\/(\d+)(?:\/|$)/);
    var mid = ms ? parseInt(ms[1], 10) : 0;

    if (p.indexOf("/oauth2/oob/code") !== -1) {
      // device-code flow: the connect shot wants a live-looking code and
      // QR (qr-test1234.png encodes the same TEST1234 code). The poll
      // endpoint stays pending forever — the shot is the "waiting" frame.
      var body = p.indexOf("/oauth2/oob/code/") !== -1
        ? { status: "pending" }
        : { code: "TEST1234", qr_code_url: "/docs/shots/fixtures/qr-test1234.png" };
      return Promise.resolve(
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        })
      );
    }
    if (p.indexOf("/account/info") !== -1)
      return Promise.resolve(
        new Response(JSON.stringify(accountInfo), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        })
      );
    if (p.indexOf("/files") !== -1 && p.indexOf("/stream") === -1) {
      var qv = new URL(url).searchParams.get("parent_id");
      var files =
        qv === null ? ROOT_LISTING : qv === "1" ? PAINTINGS_LISTING : ROOT_LISTING;
      return Promise.resolve(
        new Response(
          JSON.stringify({ status: "ok", cursor: null, files: files }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      );
    }
    if (p.indexOf("/stream") !== -1) {
      var path = STREAM[mid];
      if (!path) return Promise.resolve(new Response("", { status: 404 }));
      var ranged = mid === 21 || mid === 22;
      return origFetch(path).then(function (r) {
        return r.arrayBuffer().then(function (buf) {
          var total = buf.byteLength;
          var range = init && init.headers ? init.headers.Range : null;
          var rm = range ? String(range).match(/^bytes=(\d+)-?(\d*)$/) : null;
          if (!ranged || !rm)
            return new Response(buf, {
              status: 200,
              headers: { "Content-Length": String(total) }
            });
          var start = parseInt(rm[1], 10);
          var end = rm[2] ? parseInt(rm[2], 10) : total - 1;
          end = Math.min(end, total - 1);
          return new Response(buf.slice(start, end + 1), {
            status: 206,
            headers: {
              "Content-Range": "bytes " + start + "-" + end + "/" + total,
              "Content-Length": String(end - start + 1)
            }
          });
        });
      });
    }
    /* file detail: name/size plus a single AAC audio stream (enough for
     * the music flow; the media element never asks for more). */
    var f = null;
    for (var i = 0; i < ALL.length; i++)
      if (ALL[i].id === mid) f = ALL[i];
    var det = f ? { status: "ok", file: f } : { status: "ok" };
    if (mid === 31)
      det.file.media_info = {
        format: { name: "MP3" },
        streams: [
          {
            codec_type: "audio",
            codec_name: "mp3",
            tags: { language: "", title: "Maple Leaf Rag" }
          }
        ]
      };
    return Promise.resolve(
      new Response(JSON.stringify(det), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      })
    );
  };

  /* Media-element src rewrite: api.put.io stream URLs -> local blobs, so
   * the mp3 (and the stand-in video) actually play in the browser. */
  var desc = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "src");
  var blobURL = {};
  Object.defineProperty(HTMLMediaElement.prototype, "src", {
    get: function () {
      return desc.get.call(this);
    },
    set: function (val) {
      var el = this;
      if (
        val &&
        val.indexOf("api.put.io") !== -1 &&
        val.indexOf("/stream") !== -1
      ) {
        var mm = val.match(/\/files\/(\d+)\//);
        var fid = mm ? parseInt(mm[1], 10) : 0;
        var media = STREAM[fid] || "/test/e2e/testvid.mp4";
        var apply = function (u) {
          desc.set.call(el, u);
          el.play().catch(function () {});
        };
        if (!blobURL[fid]) {
          origFetch(media)
            .then(function (r) { return r.blob(); })
            .then(function (b) {
              blobURL[fid] = URL.createObjectURL(b);
              apply(blobURL[fid]);
            });
        } else apply(blobURL[fid]);
        return;
      }
      desc.set.call(el, val);
    },
    configurable: true
  });

  /* <img> never goes through fetch: point the stream URL at the local
   * asset so the browser decodes the REAL image bytes (naturalWidth and
   * friends are honest). Svelte sets src via setAttribute — hook both. */
  var imgDesc = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, "src");
  var rewriteImgSrc = function (val) {
    if (val && val.indexOf("api.put.io") !== -1 && val.indexOf("/stream") !== -1) {
      var im = val.match(/\/files\/(\d+)\//);
      var fid = im ? parseInt(im[1], 10) : 0;
      return STREAM[fid] || null;
    }
    return null;
  };
  Object.defineProperty(HTMLImageElement.prototype, "src", {
    get: function () { return imgDesc.get.call(this); },
    set: function (val) {
      var local = rewriteImgSrc(val);
      imgDesc.set.call(this, local || val);
    }
  });
  var imgSetAttr = HTMLImageElement.prototype.setAttribute;
  HTMLImageElement.prototype.setAttribute = function (name, val) {
    if (name === "src") {
      var local = rewriteImgSrc(val);
      if (local) val = local;
    }
    return imgSetAttr.call(this, name, val);
  };
})();
