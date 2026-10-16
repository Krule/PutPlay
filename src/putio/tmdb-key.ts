/**
 * THE TMDb API READ ACCESS TOKEN, baked into the app at build time.
 *
 * Why it lives here and not in Settings: a TV remote has no viable
 * keyboard for a long token, so it is embedded in code and the feature
 * works out of the box. To refresh it: themoviedb.org → Settings → API →
 * copy the "API Read Access Token" (the long `eyJ…` string — it is what
 * the v3 REST API accepts as `Authorization: Bearer`) and rebuild. An
 * empty value turns the segment-skip lookup off (the honest "nothing to
 * skip" — no error, no network).
 */
export const TMDB_KEY =
  "eyJhbGciOiJIUzI1NiJ9.eyJhdWQiOiI3ODQ1YjNjZGQ4ZWNiMDk2YjQ4YzM4NmJhMzlkYzE2OCIsIm5iZiI6MTc5MTA0MDkzNi4xOTUwMDAyLCJzdWIiOiI2YWMxMWRhODYzNDUxZDRhYTgyY2VmMjEiLCJzY29wZXMiOlsiYXBpX3JlYWQiXSwidmVyc2lvbiI6MX0.FijUpJ40cXXsgAPjAry7XMwPPpa2ZYz0p9h3gvvJIBk";
