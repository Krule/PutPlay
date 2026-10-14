/* e2e: the MUSIC flow. A minimal fake — a sibling of fake-api.js (owned by
 * the video/comic fixtures; this one stays stable for the music verifications).
 *
 * Run:
 *   npm run build
 *   python3 -m http.server 8642
 *   agent-browser open "http://localhost:8642/?seedtoken" \
 *     --init-script test/e2e/fake-api-music.js
 *
 * Serves: a root with 3 audio tracks + a "Music" folder holding 3 more tracks
 * and a cover.jpg. Every stream is rewritten to /test/e2e/testvid.mp4 (a 60 s
 * clip with a 440 Hz sine audio track — the music session plays real audio).
 * The cover stream is rewritten to a local PNG.
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
      family_owner: "Test User",
      mail: "t@e.com",
      disk: { avail: 6 * GB, size: 10 * GB, used: 4 * GB },
      download_token: "fake-dl-token",
      settings: { subtitle_languages: ["eng"] }
    },
    status: "ok"
  };

  function audio(id, name, parent) {
    return { id: id, name: name, size: 906084, content_type: "audio/flac", parent_id: parent, is_folder: 0, start_from: 0 };
  }
  var origFetch = window.fetch.bind(window);
  /* the comic's size is the REAL fixture size (the app derives its tail-read
   * range from the declared size — a wrong size makes the range run past
   * EOF and the EOCD read finds nothing) */
  var cbzSizePromise = origFetch("/test/e2e/story.cbz", { method: "HEAD" }).then(function (r) {
    return parseInt(r.headers.get("Content-Length") || "0", 10);
  });
  var files = [
    { id: 50, name: "Music", size: 0, content_type: "application/x-directory", parent_id: null, is_folder: 1, start_from: 0 },
    { id: 120, name: "story.cbz", size: 0, content_type: "application/zip", parent_id: null, is_folder: 0, start_from: 0 },
    audio(101, "01 - First.flac", null),
    audio(102, "02 - Second.flac", null),
    audio(103, "03 - Third.flac", null),
    audio(111, "A - Alpha.flac", 50),
    audio(112, "B - Beta.flac", 50),
    audio(113, "C - Gamma.flac", 50),
    { id: 114, name: "cover.jpg", size: 12345, content_type: "image/jpeg", parent_id: 50, is_folder: 0, start_from: 0 }
  ];

  /* ---------------- JSON endpoints ---------------- */
  window.fetch = function (input, init) {
    var url = typeof input === "string" ? input : (input && input.url) || "";
    if (url.indexOf("https://api.put.io/") !== 0) return origFetch(input, init);
    var p;
    try { p = new URL(url).pathname; } catch (e) { p = ""; }
    var body;
    if (p.indexOf("/account/info") !== -1) {
      body = JSON.stringify(accountInfo);
    } else if (p.indexOf("/files/list") !== -1) {
      var pid = null;
      try {
        var qv = new URL(url).searchParams.get("parent_id");
        if (qv) pid = Number(qv);
      } catch (e2) {}
      var shown = files.filter(function (f) {
        return pid === null ? f.parent_id === null : f.parent_id === pid;
      });
      return cbzSizePromise.then(function (sz) {
        files.forEach(function (f) { if (f.id === 120) f.size = sz; });
        return new Response(JSON.stringify({ status: "ok", cursor: null, files: shown }), { status: 200, headers: { "Content-Type": "application/json" } });
      });
    } else if (/\/files\/\d+\/start-from/.test(p)) {
      body = JSON.stringify({ status: "ok", start_from: 0 });
    } else if (p.indexOf("/stream") !== -1) {
      // a direct fetch() of a stream URL (not the media element)
      var sm = p.match(/\/files\/(\d+)(?:\/|$)/);
      var sid = sm ? parseInt(sm[1], 10) : 0;
      if (sid === 120) {
        // the comic e2e: honour Range like fake-api.js (tail read + per-entry reads)
        return origFetch("/test/e2e/story.cbz").then(function (r) {
          return r.arrayBuffer().then(function (buf) {
            var total = buf.byteLength;
            var range = init && init.headers ? init.headers.Range : null;
            var rm = range ? String(range).match(/^bytes=(\d+)?-?(\d*)$/) : null;
            if (!rm) {
              return new Response(buf, { status: 200, headers: { "Content-Length": String(total), "Content-Type": "application/zip" } });
            }
            var start, end;
            if (rm[1] === "" || rm[1] === undefined) {
              // suffix form: bytes=-N → the last N bytes
              var suffix = rm[2] ? parseInt(rm[2], 10) : total;
              start = Math.max(0, total - suffix);
              end = total - 1;
            } else {
              start = parseInt(rm[1], 10);
              end = rm[2] ? parseInt(rm[2], 10) : total - 1;
            }
            end = Math.min(end, total - 1);
            return new Response(buf.slice(start, end + 1), {
              status: 206,
              headers: { "Content-Range": "bytes " + start + "-" + end + "/" + total, "Content-Length": String(end - start + 1), "Content-Type": "application/zip" }
            });
          });
        });
      }
      return origFetch("/test/e2e/testvid.mp4");
    } else if (/\/files\/\d+/.test(p)) {
      var mm = p.match(/\/files\/(\d+)/);
      var f = files.filter(function (x) { return x.id === Number(mm[1]); })[0] || { id: Number(mm[1]), name: "x", size: 0, content_type: "audio/flac", parent_id: null };
      body = JSON.stringify({ status: "ok", file: Object.assign({}, f, { media_info: { streams: [] } }) });
    } else {
      body = JSON.stringify({ status: "ok" });
    }
    return Promise.resolve(new Response(body, { status: 200, headers: { "Content-Type": "application/json" } }));
  };

  /* ---------------- media element src rewrite ----------------
   * <video src> loads don't go through window.fetch — the app's music element
   * gets the local clip via a src-setter proxy (the element stays a real
   * media element, so the engine's events all fire for real). */
  var desc = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "src");
  Object.defineProperty(HTMLMediaElement.prototype, "src", {
    get: function () { return desc.get.call(this); },
    set: function (val) {
      if (val && val.indexOf("api.put.io") !== -1) {
        var el = this;
        origFetch("/test/e2e/testvid.mp4")
          .then(function (r) { return r.blob(); })
          .then(function (b) {
            desc.set.call(el, URL.createObjectURL(b));
            el.play().catch(function () {});
          });
        return;
      }
      desc.set.call(this, val);
    }
  });

  /* ---------------- image src rewrite (the folder cover) ---------------- */
  var imgDesc = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, "src");
  Object.defineProperty(HTMLImageElement.prototype, "src", {
    get: function () { return imgDesc.get.call(this); },
    set: function (val) {
      if (val && val.indexOf("api.put.io") !== -1) {
        imgDesc.set.call(this, "/test/e2e/wall-13.png");
        return;
      }
      imgDesc.set.call(this, val);
    }
  });
})();
