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
    /* ?autofallback → the "use the put.io stream" audio-fallback setting;
     * ?prefaudio=<code> → the preferred audio language. Both seed the config
     * so e2e flows don't have to navigate the Settings screen. */
    var cfgSeed = {};
    var prefM = location.search.match(/prefaudio=([a-z]{2,3})/);
    if (prefM) cfgSeed.audioLang = prefM[1];
    if (location.search.indexOf("autofallback") !== -1)
      cfgSeed.audioFallback = "auto-hls";
    if (Object.keys(cfgSeed).length)
      localStorage.setItem("putio.config", JSON.stringify(cfgSeed));
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
          parent_id: 0, // inside the "Movies" folder (folder-browsing e2e)
          is_folder: 0,
          is_mp4_available: n === 1, // file 1 proves the "put.io MP4" source path in e2e
          // file 8 simulates a previously-watched title (put.io start_from >30s)
          // so the Player's "Resume?" prompt path is reachable in e2e
          start_from: n === 8 ? 45 : 0
        };
      })
        .concat([
          {
            // MULTI-AUDIO MKV, both tracks natively switchable (E-AC3 + AAC).
            // With ?stubborn the webview mock vetoes enabled-writes until a
            // full src reload (the webOS 6 audio-switch bug the app must
            // escalate past — see .agents/plan.md Phase 3).
            id: 9,
            name: "multi-audio-9.mkv",
            size: 906084,
            content_type: "video/x-matroska",
            parent_id: null,
            is_folder: 0,
            is_mp4_available: false,
            start_from: 0
          },
          {
            // MULTI-AUDIO MKV, second track (DTS) HIDDEN by the "webview"
            // (undecodable on webOS 6) — only reachable via the put.io HLS
            // rendition. Exercises the metadata-merge + HLS-fallback path.
            id: 10,
            name: "multi-audio-10.mkv",
            size: 906084,
            content_type: "video/x-matroska",
            parent_id: null,
            is_folder: 0,
            is_mp4_available: false,
            start_from: 0
          },
          {
            // MULTI-AUDIO MKV whose webview VETOES the reload dance too
            // (never re-arms) — the auto-hls fallback fixture: with the
            // setting on, a refused pick must land on the put.io rendition
            // of the chosen language without a second prompt.
            id: 11,
            name: "multi-audio-11.mkv",
            size: 906084,
            content_type: "video/x-matroska",
            parent_id: null,
            is_folder: 0,
            is_mp4_available: false,
            start_from: 0
          },
          {
            // The EAAAO exposure: the webview gives NO language code for
            // these tracks (empty), only the MKV titles. A configured
            // preference must match via the LABEL ("English AC-3 5.1"),
            // or it silently does nothing (the reported "plays Italian").
            id: 12,
            name: "multi-audio-12.mkv",
            size: 906084,
            content_type: "video/x-matroska",
            parent_id: null,
            is_folder: 0,
            is_mp4_available: false,
            start_from: 0
          }
        ])
    )
  };

  /* put.io /files/{id} detail with media_info (the app's track-list source of
   * truth: per-stream codec + language + title, ffmpeg-probe shape). */
  var audioStream = function (codec, lang, title) {
    return {
      codec_type: "audio",
      codec_name: codec,
      tags: { language: lang, title: title }
    };
  };
  var fileDetail = function (id) {
    var f = null;
    for (var i = 0; i < fileList.files.length; i++)
      if (fileList.files[i].id === id) f = fileList.files[i];
    if (!f) return null;
    var streams = [{ codec_type: "video", codec_name: "h264" }];
    if (id === 9)
      streams.push(audioStream("eac3", "eng", "English"), audioStream("aac", "spa", "Spanish"));
    else if (id === 11)
      streams.push(audioStream("eac3", "eng", "English"), audioStream("aac", "spa", "Spanish"));
    else if (id === 12)
      streams.push(audioStream("eac3", "ita", "Italiano"), audioStream("eac3", "eng", "English"));
    else if (id === 10)
      streams.push(audioStream("eac3", "eng", "English"), audioStream("dca", "spa", "Spanish (DTS)"));
    else streams.push(audioStream("aac", "eng", ""));
    f.media_info = { format: { name: f.name.indexOf(".mkv") !== -1 ? "Matroska" : "MP4" }, streams: streams };
    return f;
  };

  var origFetch = window.fetch.bind(window);

  window.fetch = function (input, init) {
    var url = typeof input === "string" ? input : (input && input.url) || "";
    if (url.indexOf("https://api.put.io/") !== 0) return origFetch(input, init);
    var p;
    try { p = new URL(url).pathname; } catch (e) { p = ""; }
    var body;
    if (p.indexOf("/account/info") !== -1) body = JSON.stringify(accountInfo);
    else if (p.indexOf("/files/list") !== -1) {
      // honor parent_id (folder browsing): absent/null = root listing
      var pid = null;
      try {
        var qv = new URL(url).searchParams.get("parent_id");
        if (qv) pid = Number(qv);
      } catch (e2) {}
      var shown = fileList.files.filter(function (f) {
        return pid === null ? f.parent_id === null : f.parent_id === pid;
      });
      body = JSON.stringify({ status: "ok", cursor: null, files: shown });
    }
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
    else if (p.indexOf("/stream") !== -1) {
      // media load (rarely via fetch): the multi-audio files carry their own
      var ms = p.match(/\/files\/(\d+)(?:\/|$)/);
      var mid = ms ? parseInt(ms[1], 10) : 0;
      return origFetch(mid === 9 || mid === 10 ? "/test/e2e/dual-audio.mp4" : "/test/e2e/testvid.mp4");
    }
    else if (p.indexOf("/hls/") !== -1) {
      // the whole fake HLS tree (manifest + media playlists + segments) is
      // served straight from the generated local files
      var hlsBase = p.split("/hls/")[1].split("?")[0];
      var ctype = hlsBase.indexOf(".m3u8") !== -1
        ? "application/vnd.apple.mpegurl"
        : hlsBase.indexOf(".ts") !== -1 ? "video/mp2t" : "application/octet-stream";
      return origFetch("/test/e2e/hls/" + hlsBase).then(function (r) {
        return r.arrayBuffer().then(function (buf) {
          return new Response(buf, { status: 200, headers: { "Content-Type": ctype } });
        });
      });
    }
    else {
      var dm = p.match(/\/files\/(\d+)$/);
      var det = dm ? fileDetail(parseInt(dm[1], 10)) : null;
      body = det ? JSON.stringify({ status: "ok", file: det }) : JSON.stringify({ status: "ok" });
    }
    return Promise.resolve(
      new Response(body, { status: 200, headers: { "Content-Type": "application/json" } })
    );
  };

  /* Rewrite the stream URL on the media element to a local blob so playback
   * works without the real put.io CDN. No error events fire, so the engine's
   * fallback chain stays dormant and all video events flow normally.
   *
   * MULTI-AUDIO: files 9/10 load dual-audio.mp4 and get a per-element
   * webOS-style `audioTracks` mock attached (desktop Chrome has no such API
   * at all). The mock mirrors the C1/webOS 6 behavior under test:
   *   - file 9:  two tracks, both exposed natively (eac3/eng + aac/spa)
   *   - file 10: one track — the DTS/spa stream is HIDDEN, as the webview
   *     does with codecs it cannot decode (Jellyfin webOS profile)
   *   - ?stubborn: the webview VETOES `enabled` writes while a session is
   *     active (the read-back reveals the old track — the documented bug).
   *     A full src reload (strip → load → re-set) re-arms the pipeline and
   *     the write then lands — which is exactly why the app's escalation
   *     performs the "reload dance" (proven in kieranbrown/stremio-webos).
   *   - `addtrack` fires shortly after a fresh load (LG extension event),
   *     `change` fires when a write lands. */
  var AT_SPECS = {
    9: [
      { enabled: true, language: "eng", label: "English (E-AC3)" },
      { enabled: false, language: "spa", label: "Spanish (AAC)" }
    ],
    10: [{ enabled: true, language: "eng", label: "English (E-AC3)" }],
    11: [
      { enabled: true, language: "eng", label: "English (E-AC3)" },
      { enabled: false, language: "spa", label: "Spanish (AAC)" }
    ],
    12: [
      { enabled: true, language: "", label: "Italiano AC-3 5.1" },
      { enabled: false, language: "", label: "English AC-3 5.1" }
    ]
  };
  // every playable file exposes its audio tracks natively (webview behavior)
  // — the single-track mp4s (files 1-8) expose one AAC track
  var DEFAULT_AT_SPEC = [{ enabled: true, language: "eng", label: "English (AAC)" }];
  var STUBBORN = location.search.indexOf("stubborn") !== -1;

  function makeTrackList(el, spec) {
    var list = {
      _events: {},
      length: spec.length,
      fire: function (n) {
        var es = (list._events[n] || []).slice();
        for (var k = 0; k < es.length; k++) es[k]({ type: n });
      },
      addEventListener: function (n, f) {
        (list._events[n] = list._events[n] || []).push(f);
      },
      removeEventListener: function (n, f) {
        list._events[n] = (list._events[n] || []).filter(function (x) { return x !== f; });
      },
      item: function (i) { return spec[i] ? tracks[i] : null; }
    };
    var tracks = spec.map(function (t, idx) {
      return {
        _e: t.enabled,
        get enabled() {
          return this._e;
        },
        set enabled(v) {
          // the webview veto: while the session is "armed against" changes,
          // the assignment is silently a no-op (no error, old value reads
          // back). After a full src reload the pipeline re-evaluates and the
          // write lands.
          if (el._atArmed === false) return;
          if (this._e === !!v) return;
          this._e = !!v;
          list.fire("change");
        },
        get language() { return t.language; },
        get label() { return t.label; },
        get id() { return String(idx); }
      };
    });
    for (var i = 0; i < tracks.length; i++)
      (function (i) {
        Object.defineProperty(list, i, { get: function () { return tracks[i]; }, configurable: true });
      })(i);
    return list;
  }

  function attachMock(el, fileId) {
    var spec = AT_SPECS[fileId] || DEFAULT_AT_SPEC;
    if (!spec) { clearMock(el); return; }
    // stubborn mode: a FRESH session starts vetoed, but a load() re-arm
    // sticks — the dance's load() happens before this attachMock, and the
    // pipeline re-evaluation that reload buys is exactly what we're
    // simulating (downgrading here would make the dance "fail" in the fake)
    if (STUBBORN && el._atArmed !== true) el._atArmed = false;
    el.audioTracks = makeTrackList(el, spec);
    // LG's extension announces tracks via addtrack after metadata
    setTimeout(function () {
      try { if (el.isConnected) el.audioTracks.fire("addtrack"); } catch (e) {}
    }, 60);
    // a full reload (load() after src was re-set) re-arms the pipeline —
    // EXCEPT file 11, whose webview keeps vetoing even after the reload
    // (the auto-hls fixture: the dance must lose, the fallback must win)
    var origLoad = el.load ? el.load.bind(el) : null;
    el.load = function () {
      el._atArmed = STUBBORN && fileId === 11 ? false : true;
      if (origLoad) origLoad();
    };
  }
  function clearMock(el) {
    delete el.audioTracks;
    el._atArmed = null;
  }

  var desc = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "src");
  var blobURL = {}; // per file id
  var blobId = {}; // blob url -> file id (so the reload dance's re-set is recognised)
  Object.defineProperty(HTMLMediaElement.prototype, "src", {
    get: function () { return desc.get.call(this); },
    set: function (val) {
      var el = this;
      if (val && blobId[val]) {
        // the reload dance re-sets the element's current (blob) src — the
        // media reloads and the re-armed track list stays attached
        attachMock(el, blobId[val]);
        desc.set.call(el, val);
        return;
      }
      if (val && val.indexOf("api.put.io") !== -1 && val.indexOf("/stream") !== -1) {
        var mm = val.match(/\/files\/(\d+)\//);
        var fid = mm ? parseInt(mm[1], 10) : 0;
        var isMulti = fid === 9 || fid === 10 || fid === 11 || fid === 12;
        var media = isMulti ? "/test/e2e/dual-audio.mp4" : "/test/e2e/testvid.mp4";
        if (!blobURL[fid]) {
          origFetch(media)
            .then(function (r) { return r.blob(); })
            .then(function (b) {
              blobURL[fid] = URL.createObjectURL(b);
              blobId[blobURL[fid]] = fid;
              attachMock(el, fid);
              desc.set.call(el, blobURL[fid]);
              el.play().catch(function () {});
            });
        } else {
          attachMock(el, fid);
          desc.set.call(el, blobURL[fid]);
          el.play().catch(function () {});
        }
        return;
      }
      clearMock(el);
      desc.set.call(el, val);
    },
    configurable: true
  });

  /* ---------------- XHR interception ----------------
   * hls.js loads manifests + segments via XMLHttpRequest, NOT fetch —
   * without this the put.io HLS switch fails to a silent fallback in the
   * harness (the fetch-only interception was caught by the e2e: zero
   * audio segments fetched after switching to HLS). */
  (function () {
    var realXHR = window.XMLHttpRequest;
    function FakeXHR() {
      var self = this;
      var url = "";
      this.readyState = 0;
      this.status = 0;
      this.statusText = "";
      this.responseType = "";
      this.response = null;
      this.responseText = "";
      this.onload = null;
      this.onerror = null;
      this.onprogress = null;
      this.onreadystatechange = null;
      this.open = function (method, u) {
        url = String(u);
      };
      this.setRequestHeader = function () {};
      this.getResponseHeader = function () {
        return "application/vnd.apple.mpegurl";
      };
      this.getAllResponseHeaders = function () {
        return "";
      };
      this.abort = function () {
        self.readyState = 0;
        if (self.onerror) self.onerror();
      };
      this.send = function () {
        var m = url.match(/\/hls\/([^?]+)/);
        if (!m) {
          // not a local HLS asset — behave like a blocked external request
          self.readyState = 4;
          self.status = 0;
          if (self.onerror) self.onerror();
          return;
        }
        origFetch("/test/e2e/hls/" + m[1])
          .then(function (r) { return r.arrayBuffer(); })
          .then(function (buf) {
            self.status = 200;
            self.statusText = "OK";
            var bytes = new Uint8Array(buf);
            var txt = "";
            for (var i = 0; i < bytes.length; i++) txt += String.fromCharCode(bytes[i]);
            self.response = buf;
            self.responseText = txt;
            self.readyState = 4;
            if (self.onreadystatechange) self.onreadystatechange();
            if (self.onprogress) self.onprogress();
            if (self.onload) self.onload();
          })
          .catch(function () {
            self.readyState = 4;
            self.status = 0;
            if (self.onerror) self.onerror();
          });
      };
    }
    window.XMLHttpRequest = FakeXHR;
  })();
})();
