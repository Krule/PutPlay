/* Browser init-script: fakes the put.io API so the real app runs end-to-end
 * offline in a desktop browser (e2e repro harness).
 *  - seeds the saved oauth token (desktop path = localStorage)
 *  - intercepts fetch() for https://api.put.io/v2 (JSON endpoints)
 *  - rewrites <video>.src for api.put.io stream URLs to a local test mp4 blob
 */
(function () {
  var TOKEN = "fake-oauth-token";
  /* seed only when requested via ?seedtoken — the harness runs BOTH flows:
   *   /?seedtoken  → library/player verification
   *   /            → Connect screen verification (unauthenticated) */
  try {
    if (location.search.indexOf("seedtoken") !== -1) {
      localStorage.setItem("putio.oauthToken", JSON.stringify(TOKEN));
    }
  } catch (e) {}

  var GB = 1024 * 1024 * 1024;
  var accountInfo = {
    info: {
      account_active: true,
      account_status: "active",
      family_owner: "Test User",
      mail: "test@example.com",
      disk: { avail: 6 * GB, size: 10 * GB, used: 4 * GB },
      download_token: "fake-dl-token",
      settings: { subtitle_languages: ["eng"] }
    },
    status: "ok"
  };
  var fileList = {
    status: "ok",
    cursor: null,
    files: [
      {
        id: 0,
        name: "Movies",
        size: 0,
        content_type: "application/x-directory",
        parent_id: null,
        is_folder: 1,
        start_from: 0
      }
    ].concat(
      [1, 2, 3, 4, 5, 6, 7, 8].map(function (n) {
        return {
          id: n,
          name: "testvid-" + n + ".mp4",
          size: 906084,
          content_type: "video/mp4",
          parent_id: null,
          is_folder: 0,
          is_mp4_available: n === 1, // file 1 proves the "put.io MP4" source path in e2e
          // file 8 simulates a previously-watched title (put.io start_from >30s)
          // so the Player's "Resume?" prompt path is reachable in e2e
          start_from: n === 8 ? 45 : 0
        };
      })
    )
  };

  var origFetch = window.fetch.bind(window);

  window.fetch = function (input, init) {
    var url = typeof input === "string" ? input : (input && input.url) || "";
    if (url.indexOf("https://api.put.io/") !== 0) return origFetch(input, init);
    var p;
    try { p = new URL(url).pathname; } catch (e) { p = ""; }
    var body;
    if (p.indexOf("/account/info") !== -1) body = JSON.stringify(accountInfo);
    else if (p.indexOf("/files/list") !== -1) body = JSON.stringify(fileList);
    else if (p.indexOf("/oauth2/oob/code") !== -1 && p.split("/").pop().length > 4)
      // poll: never approve in the harness (stays in "waiting" state)
      body = JSON.stringify({ status: "ok" });
    else if (p.indexOf("/oauth2/oob/code") !== -1)
      body = JSON.stringify({
        status: "ok",
        code: "TEST1234",
        qr_code_url: location.origin + "/test/e2e/qr-fake.svg"
      });
    else if (p.indexOf("/subtitles") !== -1)
      // NOTE: deliberately returned in API "wrong" order (suggestion first) —
      // the app must sort MKV-embedded first.
      body = JSON.stringify({
        status: "ok",
        default: null,
        subtitles: [
          {
            key: "os-eng", language: "English", language_code: "eng",
            name: "suggested.srt", format: "srt", source: "opensubtitles",
            url: location.origin + "/test/e2e/subs-os.srt"
          },
          {
            key: "mk-eng", language: "English", language_code: "eng",
            name: "embedded.ass", format: "ass", source: "mkv",
            url: location.origin + "/test/e2e/subs-emb.ass"
          }
        ]
      });
    else if (p.indexOf("/start-from") !== -1)
      body = JSON.stringify({ status: "ok", start_from: 0 });
    else if (p.indexOf("/stream") !== -1)
      return origFetch("/test/e2e/testvid.mp4"); // media load (rarely via fetch)
    else body = JSON.stringify({ status: "ok" });
    return Promise.resolve(
      new Response(body, { status: 200, headers: { "Content-Type": "application/json" } })
    );
  };

  /* Rewrite the stream URL on the media element to a local blob so playback
   * works without the real put.io CDN. No error events fire, so the engine's
   * fallback chain stays dormant and all video events flow normally. */
  var desc = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "src");
  var blobURL = null;
  Object.defineProperty(HTMLMediaElement.prototype, "src", {
    get: function () { return desc.get.call(this); },
    set: function (val) {
      var el = this;
      if (val && val.indexOf("api.put.io") !== -1 && val.indexOf("/stream") !== -1) {
        if (!blobURL) {
          origFetch("/test/e2e/testvid.mp4")
            .then(function (r) { return r.blob(); })
            .then(function (b) {
              blobURL = URL.createObjectURL(b);
              desc.set.call(el, blobURL);
              el.play().catch(function () {});
            });
        } else {
          desc.set.call(el, blobURL);
          el.play().catch(function () {});
        }
        return;
      }
      desc.set.call(el, val);
    },
    configurable: true
  });
})();
