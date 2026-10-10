import { writable, get, derived } from "svelte/store";
import type { Writable } from "svelte/store";

export type AuthStore = Writable<AuthState>;
import type { Auth } from "../putio/api";
import { requestOOBCode, pollOOBCode, validateOAuth, getAccountInfo, PUTIO_WEB_APP_URL } from "../putio/api";
import type { OOBCodeResponse, OOBPollResponse } from "../putio/types";
import { store } from "../webos/platform";

export interface AuthState {
  status: "loading" | "unauthed" | "pending" | "authed";
  oauthToken: string | null;
  downloadToken: string | null;
  oobCode: string | null;
  oobQr: string | null;
  oobError: string | null;
  accountEmail: string | null;
  accountName: string | null;
  disk: { avail: number; size: number; used: number } | null;
  subtitleLanguages: string[];
  lastError: string | null;
}

const initial: AuthState = {
  status: "loading",
  oauthToken: null,
  downloadToken: null,
  oobCode: null,
  oobQr: null,
  oobError: null,
  accountEmail: null,
  accountName: null,
  disk: null,
  subtitleLanguages: ["eng"],
  lastError: null,
};

export const auth: AuthStore = writable<AuthState>(initial);

let pollTimer: number | null = null;
let polling = false;

function set(patch: Partial<AuthState>) {
  auth.update((s) => ({ ...s, ...patch }));
}

export function currentAuth(): Auth | null {
  const s = get(auth);
  if (!s.oauthToken) return null;
  return { oauthToken: s.oauthToken, downloadToken: s.downloadToken };
}

async function completeAuth(oauthToken: string): Promise<void> {
  try {
    const info = await getAccountInfo({ oauthToken, downloadToken: null });
    set({
      status: "authed",
      oauthToken,
      downloadToken: info.download_token || null,
      accountEmail: info.mail || null,
      accountName: info.family_owner || null,
      disk: info.disk || null,
      subtitleLanguages:
        (info.settings?.subtitle_languages || []).length > 0
          ? info.settings.subtitle_languages
          : ["eng"],
      oobCode: null,
      oobQr: null,
      oobError: null,
      lastError: null,
    });
    await store.set("putio.oauthToken", oauthToken);
  } catch (e: any) {
    set({ status: "unauthed", oauthToken: null, lastError: e.message });
  }
}

/** Load a stored token and validate it. */
export async function loadAuth(): Promise<boolean> {
  const token = await store.get<string | null>("putio.oauthToken", null);
  if (!token) {
    set({ status: "unauthed" });
    return false;
  }
  try {
    await validateOAuth(token);
    await completeAuth(token);
    return true;
  } catch {
    await store.remove("putio.oauthToken");
    set({ status: "unauthed", oauthToken: null });
    return false;
  }
}

/** Start the put.io out-of-band device-code flow. */
export async function startOOB(): Promise<void> {
  stopOOBPoll();
  set({ status: "pending", oobError: null });
  try {
    const res: OOBCodeResponse = await requestOOBCode();
    set({ oobCode: res.code, oobQr: res.qr_code_url || null });
    startOOBPoll();
  } catch (e: any) {
    set({ status: "unauthed", oobError: e.message || "Could not start sign-in" });
  }
}

function startOOBPoll(): Promise<void> {
  const code = get(auth).oobCode;
  if (!code || polling) return Promise.resolve();
  polling = true;
  const tick = async () => {
    try {
      const res: OOBPollResponse = await pollOOBCode(code);
      if (res.oauth_token) {
        stopOOBPoll();
        await completeAuth(res.oauth_token);
        return;
      }
    } catch {
      /* transient network errors: keep polling */
    }
    pollTimer = window.setTimeout(tick, 3000);
  };
  pollTimer = window.setTimeout(tick, 2000);
  return Promise.resolve();
}

export function stopOOBPoll(): void {
  polling = false;
  if (pollTimer) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
}

/** Cancel a started device-code flow and return to the sign-in choices. */
export function cancelOOB(): void {
  stopOOBPoll();
  set({ status: "unauthed", oobCode: null, oobQr: null, oobError: null });
}

export async function signOut(): Promise<void> {
  stopOOBPoll();
  await store.remove("putio.oauthToken");
  auth.set({ ...initial, status: "unauthed" });
}

export const LINK_URL = `${PUTIO_WEB_APP_URL}/link`;
