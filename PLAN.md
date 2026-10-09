# Implementation Plan — back button, subtitles, source-switch, fullscreen, remote fixes

Context: TV playback picture is fixed (inset→longhands, committed). This pass fixes the four
remaining behaviors plus a couple of latent remote bugs. Order is by risk (small/safe first).

## 1. Source-switch preserves play position
- `media.ts` `setSource`: capture `{time, paused}` before swap; set `pendingSeek`.
- `onMeta` (`loadedmetadata`): if `pendingSeek!=null`, re-seek to it after new metadata,
  restore play/pause. Prevents the "resets to start" jump.
- Guard `applyResume()` to fire only on the *first* metadata load, not on source swaps.

## 2. Fullscreen control
- `appinfo.json`: `requiredPermissions: ["internet","fullscreen"]` + `sim: true`.
- `platform.toggleFullscreen()` → `com.webos.appmanager setFullscreen` (Luna) with
  `requestFullscreen()` fallback in a plain browser.
- Player: a "Fullscreen" control in the button row.

## 3. Back button (the real bug)
Root cause: the webOS platform consumes the Back key as `history.back()` *before* page JS
sees it (sim AND TV — same platform layer, virtual remote in the sim). Empty history stack →
the platform "exit app?" dialog, so my keydown-461 never fired.

- `appinfo.json`: `disableBackHistoryAPI: true` (makes the key pass through as keydown 461).
- `remote.ts` KEYMAP → standard webOS: 403 red, 404 green, 405 yellow, 406 blue.
  (Was mislabeled 405=red → that's why the physical YELLOW opened subtitles.)
  Actions: red→subtitles, green→audio, blue→source, yellow→play/pause (player).
  Library: red→back one folder.
- History API as belt-and-braces: push a state on each screen change, `popstate` → central
  back handler. keydown(461) stays primary; they share one handler.
- `webostvjs` bundled as an npm dep (real TV doesn't auto-inject it; sim does) so
  `platformBack()` / `quit()` work on TV. Wrapped, degrades to no-op in a browser.
- Back routing (central, in App.svelte): player→library, settings→library,
  library folder→up one level, library root→exit prompt.
- Root exit = `platform.back()` (official webOS 6 exit dialog). Double-press hint toast at root.

## 4. Subtitles (self-rendered — the `<track src>` is unreliable in Chromium 79)
- `subs.ts`: new `vttToCues(text)` parser (WEBVTT + SRT, single-pass) → sorted cue list.
  Node unit test.
- `Player`: fetch subtitle *text* (CORS is open on api.put.io), parse to cues, render the
  active cue in a bottom-center DOM overlay synced to `currentTime`. Native `<track>` kept
  as a best-effort fallback only. Cheap on the C1 (one div text swap per cue change).

## 5. Remote double-fire guard
- `remote.ts` `activate`: a real mouse click currently double-fires the tile action
  (browser click + our synthesized `el.click()`). Guard so only the OK-key path synthesizes.

## Verification (simulator, then you on TV)
1. Node: `vttToCues` tests.
2. Simulator: source swap keeps time; fullscreen control; Back key (player→library→folder-up→
   root exit dialog); subtitle overlay shows a cue; color keys map to the right actions;
   keycode diagnostic confirms all four physical color buttons.
3. Rebuild + package. Then you test on the C1.
