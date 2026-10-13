# put.io API caching — design notes (parked, not adopted)

Status: **thought exercise, deliberately not built.** The only piece that
shipped out of this discussion is the cold-start double-call merge (see
"Shipped" at the bottom). Everything below is the design as discussed, kept
so a future pass doesn't have to re-derive the API facts.

## Why it was considered

Remote data (library layout, file metadata) changes rarely; the app is
read-only (no upload/delete/rename in the UI). Today everything is
remote-first: the only persisted state is `putio.oauthToken` and
`putio.config` (webOS `appData` via `src/webos/platform.ts`). Cold start =
`/account/info` ×2 + root `/files/list`; every folder revisit and back
navigation refetches. put.io has no ETag/delta API, so every refetch is a
full page — and the account has a live 429 history (see the OOB poller's
backoff discipline).

## What the `/v2/events/list` endpoint actually offers (verified against
the official `putdotio/putio-sdk-typescript` SDK, `src/domains/events.ts`)

- **Query:** `before` (positive int, exclusive upper bound on event id) +
  `per_page` (positive int; out-of-range → 400 `INVALID_PER_PAGE`).
- **Response:** `{ status, events: [...], has_more }` — pagination walks
  down by integer event `id` via `before`; there is no cursor string.
- **Event:** `{ id: int, created_at, type, user_id }` + per-type fields.
  File events (`upload`, `file_shared`,
  `file_from_rss_deleted_for_space`, `transfer_completed`) carry
  `file_id`, `file_name`, `file_size` — **no parent folder id**.
- **Known types:** `upload`, `transfer_completed`, `transfer_error`,
  `transfer_from_rss_error`, `transfer_callback_error`,
  `file_from_rss_deleted_for_space`, `file_shared`, `zip_created`,
  `private_torrent_pin`, `rss_filter_paused`, `voucher`.
- **Two findings that shape everything:**
  1. `before` + integer ids = a clean **watermark**: "anything changed?"
     costs one tiny probe (newest event id vs the stored watermark).
  2. The feed is **ingest-side only — no `file_deleted`, no
     `file_renamed`, no `file_moved`.** It can prove *nothing new
     arrived*, never *nothing was deleted or renamed*. (The SDK's own
     schema ends in a base-schema fallback for unknown types — the list is
     open-ended.)

## The design as discussed

- **State on disk:** watermark `W` (int) + cached first-page listings
  (keyed `folderId + sort + dir`, folder id 0 included — the
  `!= null` discipline) + last position. All wiped on sign-out.
- **Bootstrap:** probe newest id → store `W` → *then* fetch the initial
  listing (W-first: the one race resolves toward an extra refetch, never a
  stale view).
- **Mount check:** probe newest id. `≤ W` → done, zero listing calls (the
  common case). `> W` → walk new events down via `before` with a page
  budget, classify, invalidate, refetch the on-screen folder, advance `W`.
  Budget exhausted without reaching `≤ W` → **gap** → invalidate all,
  reset `W` to newest.
- **Classification (pure function):** tree-changing: `upload`,
  `transfer_completed`, `file_from_rss_deleted_for_space`, `zip_created`;
  metadata-only: `voucher` (refresh disk gauge); inert: `file_shared`,
  all `*_error`, `private_torrent_pin`, `rss_filter_paused`;
  **unknown → treat as tree-changing** (conservative).
- **Granularity:** coarse visited-set invalidation (events give `file_id`
  but not the parent folder; fine-grained would need `GET /files/{id}` per
  event — only pays off for big multi-folder libraries).
- **Deletions (the blind spot): optimistic reads, verified on failure.**
  No periodic blind revalidation. A ghost tile dies on first contact:
  play it → 404 → one-shot refetch of that folder's listing → confirmed
  gone → drop the id from the cache and say "this file is no longer on
  put.io".
- **Architecture split:** the *pipeline* (probe → walk → classify →
  invalidate → advance) as a small background **service** (reusing the OOB
  poller's generation-counter + 429-backoff machinery), with the *trigger
  policy* as a separate knob — mount-only (cold start, return from player,
  back to library) as the v1 heartbeat; an idle floor while the Library is
  visible only if ever wanted. Not a real Web Worker (no parallelism to
  gain, appData/DOM live on the main thread), not a Service Worker (no bet
  on Chromium 79 app-webview support), and no OS-level background (webOS
  suspends the app — catch-up on resume is absorbed by the watermark walk).

## Why it was parked

None of it fixes a bug — worst case without the cache is a refetch, so
correctness is never at stake; only a seconds-long spinner. The
watermark + event-feed invalidation is a real complexity investment
(state machine, fixture surface, new failure modes) to buy back seconds
on a single-user TV app. Thin trade. Revisit only if the cold-start
spinner or 429s ever become an actual pain point — the endpoint facts
above are the part that took effort to establish.

## Shipped from this discussion

- **Cold start makes one `/account/info` call instead of two.**
  `validateOAuth` and `getAccountInfo` were the same endpoint called twice
  on every launch with a saved token; the shared adoption step is now
  `adoptAccount()` in `src/store/auth.ts`, and the dead `validateOAuth`
  export is gone. Gated by `test/cold-start-auth.test.mjs`.
