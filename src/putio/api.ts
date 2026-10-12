import type {
  FilesListResponse,
  PutAccountInfo,
  PutFile,
  SubtitlesResponse,
  OOBCodeResponse,
  OOBPollResponse,
} from "./types";

const API = "https://api.put.io/v2";

export class PutioError extends Error {
  constructor(
    message: string,
    public status?: number,
    public errorType?: string
  ) {
    super(message);
  }
}

export interface Auth {
  oauthToken: string;
  downloadToken: string | null;
}

export async function api<T = any>(
  path: string,
  opts: { method?: string; body?: any; auth?: Auth | null; raw?: boolean } = {}
): Promise<T> {
  const headers: Record<string, string> = {};
  if (opts.auth) headers.Authorization = `Bearer ${opts.auth.oauthToken}`;
  let body: BodyInit | undefined;
  if (opts.body) {
    if (opts.body instanceof URLSearchParams) {
      body = opts.body;
      headers["Content-Type"] = "application/x-www-form-urlencoded";
    } else {
      body = JSON.stringify(opts.body);
      headers["Content-Type"] = "application/json";
    }
  }
  let res: Response;
  try {
    res = await fetch(API + path, { method: opts.method || (body ? "POST" : "GET"), headers, body });
  } catch (e) {
    throw new PutioError("Network error — check TV internet connection");
  }
  let data: any = null;
  if (!opts.raw) {
    const text = await res.text();
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
  } else {
    data = await res.text();
  }
  if (!res.ok) {
    const msg =
      (data && (data.error_message || data.error)) || `Request failed (${res.status})`;
    throw new PutioError(String(msg), res.status, data?.error_type);
  }
  return data as T;
}

/* ---------------- account ---------------- */

export async function getAccountInfo(auth: Auth): Promise<PutAccountInfo> {
  const d = await api<{ info: PutAccountInfo; status: string }>("/account/info", { auth });
  return d.info;
}

export function validateOAuth(token: string): Promise<any> {
  return api<{ status: string }>("/account/info", {
    auth: { oauthToken: token, downloadToken: null },
  });
}

/* ---------------- files ---------------- */

export interface ListParams {
  parentId?: number | null;
  /** Max items per page (put.io `per_page`, default 50). */
  perPage?: number;
  orderBy?: "name" | "size" | "date_added" | "date_modified";
  order?: "asc" | "desc";
  contentType?: "application/x-directory" | string;
  cursor?: number | null;
}

export async function listFiles(auth: Auth, params: ListParams = {}): Promise<FilesListResponse> {
  const qs = new URLSearchParams();
  qs.set("oauth_token", auth.oauthToken);
  // `!= null` (not truthiness): a folder can legitimately have id 0 — a
  // truthiness check dropped parent_id=0 and folder 0 listed the ROOT.
  if (params.parentId != null) qs.set("parent_id", String(params.parentId));
  qs.set("per_page", String(params.perPage ?? 50));
  qs.set("order_by", params.orderBy || "name");
  qs.set("order", params.order || "asc");
  if (params.contentType) qs.set("content_type", params.contentType);
  return api<FilesListResponse>("/files/list?" + qs.toString());
}

export async function listContinue(auth: Auth, cursor: string): Promise<FilesListResponse> {
  return api<FilesListResponse>("/files/list/continue", {
    method: "POST",
    body: new URLSearchParams({
      oauth_token: auth.oauthToken,
      cursor: String(cursor),
    }),
  });
}

export interface FileDetail extends PutFile {
  duration?: number;
}

export async function getFile(
  auth: Auth,
  id: number,
  opts: { mediaInfo?: boolean } = {}
): Promise<FileDetail> {
  const qs = new URLSearchParams();
  qs.set("oauth_token", auth.oauthToken);
  if (opts.mediaInfo) {
    qs.set("media_info", "true");
    qs.set("codecs", "true");
  }
  const d = await api<{ file: FileDetail; status: string }>(`/files/${id}?${qs.toString()}`, {
    auth,
  });
  return d.file;
}

/* ---------------- media streams ---------------- */

export function streamURL(auth: Auth, id: number): string {
  return `${API}/files/${id}/stream?oauth_token=${auth.downloadToken || auth.oauthToken}`;
}
export function mp4StreamURL(auth: Auth, id: number): string {
  return `${API}/files/${id}/mp4/stream?oauth_token=${auth.downloadToken || auth.oauthToken}`;
}
export function hlsURL(auth: Auth, id: number): string {
  return `${API}/files/${id}/hls/media.m3u8?oauth_token=${auth.downloadToken || auth.oauthToken}`;
}

/* ---------------- resume ---------------- */

export async function getStartFrom(auth: Auth, id: number): Promise<number | null> {
  const d = await api<{ start_from: number; status: string }>(
    `/files/${id}/start-from?oauth_token=${auth.oauthToken}`,
    { auth }
  );
  return d?.start_from ?? null;
}

export async function setStartFrom(auth: Auth, id: number, time: number): Promise<void> {
  await api(`/files/${id}/start-from`, {
    method: "POST",
    body: new URLSearchParams({
      time: String(Math.max(0, Math.floor(time))),
      oauth_token: auth.oauthToken,
    }),
  });
}

export async function deleteStartFrom(auth: Auth, id: number): Promise<void> {
  try {
    await api(`/files/${id}/start-from/delete?oauth_token=${auth.oauthToken}`, {
      auth,
    });
  } catch {
    // some API versions use DELETE verb; try it
    try {
      await api(`/files/${id}/start-from?oauth_token=${auth.oauthToken}`, {
        method: "DELETE",
        auth,
      });
    } catch {
      /* non-fatal */
    }
  }
}

/* ---------------- subtitles ---------------- */

export async function getSubtitles(
  auth: Auth,
  id: number,
  languages: string[]
): Promise<SubtitlesResponse> {
  const qs = new URLSearchParams();
  qs.set("oauth_token", auth.oauthToken);
  if (languages.length) qs.set("languages", languages.join(","));
  return api<SubtitlesResponse>(`/files/${id}/subtitles?${qs.toString()}`, { auth });
}

/* ---------------- OOB device-code auth ---------------- */

export const PUTIO_WEB_APP_URL = "https://app.put.io";

/** PutPlay's registered put.io app id — the consent screen shows our registered name/icon. */
export const PUTIO_CLIENT_ID = 9857;

export async function requestOOBCode(clientName = "PutPlay"): Promise<OOBCodeResponse> {
  const d = await api<any>(
    `/oauth2/oob/code?app_id=${PUTIO_CLIENT_ID}&client_name=${encodeURIComponent(clientName)}`,
    { raw: true }
  );
  return JSON.parse(typeof d === "string" ? d : JSON.stringify(d));
}

export async function pollOOBCode(code: string): Promise<OOBPollResponse> {
  const d = await api<any>(`/oauth2/oob/code/${code}`, { raw: true });
  return JSON.parse(typeof d === "string" ? d : JSON.stringify(d));
}

/* ---------------- formatting helpers ---------------- */

export function fmtBytes(n: number | null | undefined): string {
  if (n == null || isNaN(n)) return "";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  const num = i === 0 ? String(v) : v.toFixed(1).replace(/\.0$/, "");
  return `${num} ${units[i]}`;
}

export function fmtTime(sec: number | null | undefined): string {
  if (sec == null || isNaN(sec) || sec < 0) return "0:00";
  sec = Math.floor(sec);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const mm = h > 0 ? String(m).padStart(2, "0") : String(m);
  return `${h > 0 ? h + ":" : ""}${mm}:${String(s).padStart(2, "0")}`;
}
