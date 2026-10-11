import { writable, get } from "svelte/store";
import type { Writable } from "svelte/store";

export type AuthStore = Writable<AuthState>;
import type { Auth } from "../putio/api";
import { requestOOBCode, pollOOBCode, validateOAuth, getAccountInfo, PUTIO_WEB_APP_URL } from "../putio/api";
import type { OOBCodeResponse, OOBPollResponse } from "../putio/types";
import { PutioError } from "../putio/api";
import { nextPollStep } from "../putio/oob-poll";
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
/** Bumped on every stop — an in-flight tick sees the stale generation and dies (no zombie pollers). */
let pollGen = 0;
let pollStartedAt = 0;
let consecutiveErrors = 0;

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

function startOOBPoll(): void {
  const code = get(auth).oobCode;
  if (!code || polling) return;
  polling = true;
  const gen = pollGen;
  pollStartedAt = Date.now();
  consecutiveErrors = 0;
  const tick = async () => {
    if (gen !== pollGen) return; // stopped while we were queued
    let res: OOBPollResponse | null = null;
    let was429 = false;
    try {
      res = await pollOOBCode(code);
      consecutiveErrors = 0;
    } catch (e: any) {
      // 429 = put.io rate-limiting us — never hammer a limiter (that's how
      // the account got throttled). Other errors: back off, keep trying.
      was429 = e instanceof PutioError && e.status === 429;
      if (!was429) consecutiveErrors++;
    }
    if (gen !== pollGen) return; // stopped while the request was in flight
    if (res && res.oauth_token) {
      stopOOBPoll();
      await completeAuth(res.oauth_token);
      return;
    }
    const step = nextPollStep({
      elapsedMs: Date.now() - pollStartedAt,
      consecutiveErrors,
      lastErrorWas429: was429,
    });
    if (step.action === "stop") {
      stopOOBPoll();
      set({
        status: "unauthed",
        oobCode: null,
        oobQr: null,
        oobError:
          step.reason === "rate-limited"
            ? "put.io is rate-limiting sign-in. Wait a minute, then try again."
            : "Sign-in code expired. Press Sign in to start a fresh one.",
      });
      return;
    }
    pollTimer = window.setTimeout(tick, step.delayMs);
  };
  pollTimer = window.setTimeout(tick, 2000);
}

export function stopOOBPoll(): void {
  pollGen++;
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
