/* Browser init-script: fakes the put.io API so the real app runs end-to-end
 * offline in a desktop browser (e2e repro harness).
 *  - seeds the saved oauth token (desktop path = localStorage)
 *  - intercepts fetch() for https://api.put.io/v2 (JSON endpoints)
 *  - rewrites <video>.src for api.put.io stream URLs to a local test mp4 blob
 *  - rewrites <img>.src for api.put.io stream URLs to the local PNG assets
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
            // EPISODE-NAMED FILE (segment-skip e2e): the name parses to
            // "Test Show" S01E01, which the fake TMDb/TheIntroDB world
            // (above) resolves to intro 0–20 s / recap 20–30 s /
            // credits 40 s–end over the 60 s testvid.
            id: 20,
            name: "Test.Show.S01E01.720p.mp4",
            size: 906084,
            content_type: "video/mp4",
            parent_id: null,
            is_folder: 0,
            is_mp4_available: false,
            start_from: 0
          },
          {
            // ANIME-NAMED FILE (dual-source e2e): a bare-episode name that
            // TMDb/TheIntroDB miss but AniList/AniSkip resolve — op 0–20 s
            // / ED 45 s–end over the 60 s testvid.
            id: 21,
            name: "[SubsPlease] Black Clover - 171 (1080p) [7AD4AFC7].mkv",
            size: 906084,
            content_type: "video/x-matroska",
            parent_id: null,
            is_folder: 0,
            is_mp4_available: false,
            start_from: 0
          },
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
          },
          {
            // IMAGE (viewer e2e): two PNGs inside "Movies" — open, browse
            // Left/Right, Back restores the folder. /stream serves the real
            // PNG assets so the browser actually decodes them.
            id: 13,
            name: "wall-1.png",
            size: 1234,
            content_type: "image/png",
            parent_id: 0,
            is_folder: 0,
            start_from: 0
          },
          {
            id: 14,
            name: "wall-2.png",
            size: 1234,
            content_type: "image/png",
            parent_id: 0,
            is_folder: 0,
            start_from: 0
          },
          {
            // ARCHIVE (viewer e2e): a plain zip at the root — ONE image, so
            // the App's post-tail decision sends it to the archive browser,
            // not the comic reader (>= 2 decodable images is the comic rule).
            // /stream serves it WITH Range support (the parser depends on it).
            id: 15,
            name: "archive.zip",
            size: 495,
            content_type: "application/zip",
            parent_id: null,
            is_folder: 0,
            start_from: 0
          },
          {
            // COMIC (reader e2e): a real CBZ at the root. content_type is
            // application/octet-stream on purpose — put.io does not know
            // "CBZ", so the app's entry decision must be extension-based.
            id: 16,
            name: "story.cbz",
            size: 3469,
            content_type: "application/octet-stream",
            parent_id: null,
            is_folder: 0,
            start_from: 0
          },
          {
            // RAR comic (e2e refusal path): matched by name and refused with
            // an honest toast — it is never fetched, so a placeholder size
            // is all it needs.
            id: 17,
            name: "mystery.cbr",
            size: 1234,
            content_type: "application/octet-stream",
            parent_id: null,
            is_folder: 0,
            start_from: 0
          },
          {
            // SPREAD-MODE comic (e2e, v1.1): 6 uniform portrait pages + one
            // big 2:1 'scanned spread' (page 3). The sheet model must cut
            // this into [0], [1,2], [3], [4,5]. content_type is octet-
            // stream like every real CBZ on put.io (extension-based entry).
            id: 18,
            name: "spread.cbz",
            size: 15529,
            content_type: "application/octet-stream",
            parent_id: null,
            is_folder: 0,
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

  /* TMDb + TheIntroDB — the segment-skip lookup's e2e world. The episode
   * file "Test.Show.S01E01.720p.mp4" (id 20) resolves to show id 777,
   * whose TheIntroDB entry is shaped for the 60 s testvid: intro 0–20 s,
   * recap 20–30 s, end credits from 40 s to the end. */
  var TMDB_FAKE = {
    results: [
      { id: 777, name: "Test Show", first_air_date: "2020-01-01", popularity: 50 },
      { id: 778, name: "Test Show Returns", first_air_date: "2021-05-05", popularity: 10 }
    ]
  };
  var TIDB_FAKE = {
    tmdb_id: 777,
    type: "tv",
    season: 1,
    episode: 1,
    intro: [{ start_ms: 0, end_ms: 20000 }],
    recap: [{ start_ms: 20000, end_ms: 30000 }],
    credits: [{ start_ms: 40000, end_ms: null }]
  };
  /* AniList + AniSkip — the keyless anime source's e2e world. "Black
   * Clover" resolves to MAL id 555, whose AniSkip entry is shaped for the
   * 60 s testvid: op 0–20 s, ED 45 s (to the end). Everything else (the
   * Western "Test Show") gets no anime match. */
  var ANILIST_FAKE = {
    data: {
      Page: {
        media: [
          // the internal `id` (Media(id:) key) and `idMal` (AniSkip key)
          // are different namespaces — the e2e world keeps both, distinct
          { id: 999, idMal: 555, title: { romaji: "Black Clover", english: "Black Clover" }, averageScore: 72, startDate: { year: 2017 } }
        ]
      }
    }
  };
  var ANISKIP_FAKE = {
    found: true,
    results: [
      { interval: { startTime: 0, endTime: 20 }, skipType: "op" },
      { interval: { startTime: 45, endTime: 55 }, skipType: "ed" }
    ]
  };

  var origFetch = window.fetch.bind(window);

  window.fetch = function (input, init) {
    var url = typeof input === "string" ? input : (input && input.url) || "";
    if (url.indexOf("https://api.themoviedb.org/") === 0) {
      window.__segCalls = window.__segCalls || [];
      window.__segCalls.push({ host: "tmdb", url: url, auth: init && init.headers ? init.headers.Authorization : null });
      return Promise.resolve(
        new Response(JSON.stringify(TMDB_FAKE), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        })
      );
    }
    if (url.indexOf("https://api.theintrodb.org/") === 0) {
      window.__segCalls = window.__segCalls || [];
      window.__segCalls.push({ host: "theintrodb", url: url });
      return Promise.resolve(
        new Response(JSON.stringify(TIDB_FAKE), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        })
      );
    }
    if (url.indexOf("https://graphql.anilist.co") === 0) {
      window.__segCalls = window.__segCalls || [];
      var alBody = init && init.body ? String(init.body) : "";
      window.__segCalls.push({ host: "anilist", url: url, body: alBody });
      // The info fallback POSTS twice to this URL — the query text
      // distinguishes: SearchMedia (title → anime list) vs MediaInfo
      // (the picked id → the SHOW shape, with the real schema field
      // averageScore).
      if (alBody.indexOf("MediaInfo") !== -1) {
        return Promise.resolve(
          new Response(JSON.stringify({
            data: {
              Media: {
                averageScore: 72,
                genres: ["Action", "Fantasy"],
                description: "<p>A 15-year-old boy who cannot use magic dreams of becoming the next Magic King of the Black Clover kingdom.</p>",
                coverImage: { large: "/test/e2e/wall-13.png" }
              }
            }
          }), {
            status: 200,
            headers: { "Content-Type": "application/json" }
          })
        );
      }
      var alData = alBody.indexOf("Black Clover") !== -1 ? ANILIST_FAKE : { data: { Page: { media: [] } } };
      return Promise.resolve(
        new Response(JSON.stringify(alData), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        })
      );
    }
    if (url.indexOf("https://api.aniskip.com/v1/") === 0) {
      window.__segCalls = window.__segCalls || [];
      window.__segCalls.push({ host: "aniskip-v1", url: url });
      // The legacy DB answers for the anime file too — with DIFFERENT
      // numbers — to prove the current (v2) DB wins in the merge.
      var as1Data = url.indexOf("/555/171") !== -1 ? {
        found: true,
        results: [
          { interval: { start_time: 5, end_time: 15 }, skip_type: "op" },
          { interval: { start_time: 46, end_time: 56 }, skip_type: "ed" }
        ]
      } : { found: false, results: [], message: "No skip times found" };
      return Promise.resolve(
        new Response(JSON.stringify(as1Data), {
          status: url.indexOf("/555/171") !== -1 ? 200 : 404,
          headers: { "Content-Type": "application/json" }
        })
      );
    }
    if (url.indexOf("https://api.aniskip.com/") === 0) {
      window.__segCalls = window.__segCalls || [];
      window.__segCalls.push({ host: "aniskip", url: url });
      var asData = url.indexOf("/555/171") !== -1 ? ANISKIP_FAKE : { found: false, results: [], message: "No skip times found" };
      return Promise.resolve(
        new Response(JSON.stringify(asData), {
          status: url.indexOf("/555/171") !== -1 ? 200 : 404,
          headers: { "Content-Type": "application/json" }
        })
      );
    }
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
      if (mid === 13 || mid === 14) {
        return origFetch("/test/e2e/wall-" + mid + ".png");
      }
      // the archive/comic e2e: honour Range (tail read + per-entry reads),
      // and count every request for the bandwidth-honesty assertions
      if (mid === 15 || mid === 16 || mid === 18) {
        var zipPath = mid === 15 ? "/test/e2e/archive.zip" : mid === 18 ? "/test/e2e/spread.cbz" : "/test/e2e/story.cbz";
        var zipType = mid === 15 ? "application/zip" : "application/octet-stream";
        return origFetch(zipPath).then(function (r) {
          // test hook: an artificial CDN latency so the prefetch-timing
          // behaviour is observable (window.__rangeDelay = 1500)
          var delay = window.__rangeDelay || 0;
          var delayed = delay
            ? new Promise(function (res) { setTimeout(res, delay); }).then(function () { return r; })
            : Promise.resolve(r);
          return delayed.then(function (r2) {
            return r2.arrayBuffer().then(function (buf) {
            var total = buf.byteLength;
            var range = init && init.headers ? init.headers.Range : null;
            window.__ranges = window.__ranges || [];
            window.__ranges.push({ url: zipPath, range: range, ts: Date.now() });
            var rm = range ? String(range).match(/^bytes=(\d+)-?(\d*)$/) : null;
            if (!rm) {
              return new Response(buf, {
                status: 200,
                headers: { "Content-Length": String(total), "Content-Type": zipType }
              });
            }
            var start = parseInt(rm[1], 10);
            var end = rm[2] ? parseInt(rm[2], 10) : total - 1;
            end = Math.min(end, total - 1);
            return new Response(buf.slice(start, end + 1), {
              status: 206,
              headers: {
                "Content-Range": "bytes " + start + "-" + end + "/" + total,
                "Content-Length": String(end - start + 1),
                "Content-Type": zipType
              }
            });
            });
          });
        });
      }
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

  /* <img> never goes through fetch: point the signed stream URL at the
   * local PNG asset so the browser decodes REAL image bytes (naturalWidth
   * and friends are honest). */
  var imgDesc = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, "src");
  var rewriteImgSrc = function (val) {
    if (val && val.indexOf("api.put.io") !== -1 && val.indexOf("/stream") !== -1) {
      var im = val.match(/\/files\/(\d+)\//);
      var fid = im ? parseInt(im[1], 10) : 0;
      if (fid === 13 || fid === 14)
        return "/test/e2e/wall-" + fid + ".png";
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
  /* Svelte sets <img src={...}> via setAttribute, not the property — hook
   * both paths (the browser's native loader bypasses the fetch patch). */
  var imgSetAttr = HTMLImageElement.prototype.setAttribute;
  HTMLImageElement.prototype.setAttribute = function (name, val) {
    if (name === "src") {
      var local = rewriteImgSrc(val);
      if (local) val = local;
    }
    return imgSetAttr.call(this, name, val);
  };
})();
