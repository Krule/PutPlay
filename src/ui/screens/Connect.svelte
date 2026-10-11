<script lang="ts">
  import { onMount } from "svelte";
  import { get } from "svelte/store";
  import { startOOB, LINK_URL } from "../../store/auth";
  import type { AuthState, AuthStore } from "../../store/auth";
  import { getRemote } from "../../webos/remote";
  import { platform } from "../../webos/platform";
  import { connectBackAction, doublePress } from "../../putio/connect";

  export let state: AuthStore;

  let oobCode: string;
  let oobQr: string | null;
  let oobError: string | null;
  let status: AuthState["status"];

  $: sync();
  let prevStatus: AuthState["status"] | null = null;
  function sync() {
    const v = get(state);
    oobCode = v.oobCode;
    oobQr = v.oobQr;
    oobError = v.oobError;
    status = v.status;
    // Auto-start: the QR code is the first thing on screen. This runs on the
    // TRANSITION into unauthed — at mount the status is still "loading"
    // (saved-session check). A failed start (oobError) must NOT re-trigger:
    // the user recovers via the Try again button.
    if (status === "unauthed" && !v.oobError && prevStatus !== "unauthed") {
      startOOB();
    }
    // entering the pending state: focus the one control that exists then
    // (Generate a new code) so OK does something useful
    if (status === "pending" && prevStatus !== "pending") {
      requestAnimationFrame(() => {
        if (newCodeBtn) remote.focusEl(newCodeBtn);
      });
    }
    // the unauthed-with-error frame has exactly one focusable element
    // (Try again) — focusFirst is a no-op in the transient spinner states
    if (status === "unauthed") {
      requestAnimationFrame(() => remote.focusFirst());
    }
    prevStatus = status;
  }

  let oobBtn: HTMLButtonElement;
  let newCodeBtn: HTMLButtonElement;

  const remote = getRemote();

  // the double-press exit guard is a plain object — kept out of reactive state
  const exitGuard = { lastRootBackAt: 0 };

  // The Connect screen owns Back through the same channel as every other
  // screen. Both visible frames (QR screen, error frame) exit the app via
  // the double-press guard — there is no sign-in screen to go back to.
  // The approval flow is bounded (TTL + 429 stop) and self-terminates in
  // the background.
  function onBack() {
    if (connectBackAction(status) === "ignore") return;
    const now = Date.now();
    if (doublePress(exitGuard, now) === "exit") {
      platform.back();
    } else {
      platform.toast("Press Back again to exit", 1800);
    }
  }

  // register the (re)created buttons with the remote engine; removed DOM
  // nodes drop out of the candidate scan on their own
  $: {
    for (const b of [oobBtn, newCodeBtn]) {
      if (b && !b.dataset.__reg) {
        b.dataset.__reg = "1";
        remote.register(b);
      }
    }
  }

  onMount(() => {
    sync();
    // Auto-start: skip the sign-in gate button — the QR code + device code
    // are the first thing on screen. The failure path (oobError) keeps a
    // "Try again" button for recovery.
    if (get(state).status === "unauthed") startOOB();
    const unsub = state.subscribe(sync);
    remote.setHandlers({ onBack, onOK: () => remote.clickActive() });
    return () => {
      unsub();
      remote.clearHandlers(); // no stale handlers may leak into the next screen
    };
  });
</script>

<div class="connect fade-up">
  {#if status === "loading"}
    <div class="form-col center">
      <div class="spinner"></div>
      <p class="muted">Checking for a saved session…</p>
    </div>
  {:else if status === "unauthed"}
    <div class="form-col center">
      {#if oobError}
        <!-- the failure renders INSIDE the approve screen's frame — the
             sign-in gate is gone, the approve screen is THE connect screen -->
        <h2 class="h2">Approve this TV</h2>
        <p class="error-text">{oobError}</p>
        <button class="btn primary big" bind:this={oobBtn} data-focus on:click={startOOB}>
          Try again
        </button>
      {:else}
        <div class="spinner"></div>
        <p class="muted">Starting sign-in…</p>
      {/if}
    </div>
  {:else if status === "pending"}
    <div class="form-col center">
      <h2 class="h2">Approve this TV</h2>
      {#if oobCode}
        <div class="code-box">
          <span class="code">{oobCode}</span>
        </div>
        <p class="muted">
          On your phone or PC, open <span class="linktext">{LINK_URL}</span> and enter this code.
        </p>
      {/if}
      {#if oobQr}
        <div class="qr-frame"><img src={oobQr} alt="QR code" /></div>
        <p class="muted">or scan it with the put.io app</p>
      {/if}
      <div class="spinner small" style="margin-top: 8px"></div>
      <p class="muted">Waiting for approval…</p>
      <button class="btn ghost" bind:this={newCodeBtn} data-focus on:click={startOOB}>Generate a new code</button>
    </div>
  {/if}

  <p class="footer-note">Browse & play from your library · files stay on put.io</p>
</div>

<style>
  .connect {
    width: 1920px;
    height: 1080px;
    display: grid;
    grid-template-columns: 1fr;
    align-items: center;
    padding: 72px 112px 0;
    position: relative;
    overflow: hidden;
  }
  .form-col {
    display: flex;
    flex-direction: column;
    align-items: center;
    text-align: center;
  }
  .form-col > :not(:first-child) {
    margin-top: 26px;
  }
  .form-col.center {
    grid-column: 1;
  }
  .h2 {
    font-size: var(--fs-h2);
    font-weight: 700;
  }
  .muted {
    color: var(--text-2);
    font-size: var(--fs-body);
    max-width: 760px;
    line-height: 1.5;
  }
  .linktext {
    color: var(--accent-2);
  }
  .btn.big {
    padding: 22px 48px;
    font-size: var(--fs-h3);
  }
  .code-box {
    padding: 22px 48px;
    border-radius: var(--r-lg);
    background: var(--surface);
    border: 1px solid var(--line-strong);
    box-shadow: var(--elev-md);
  }
  .code {
    font-size: 88px;
    font-weight: 800;
    letter-spacing: 0.18em;
    color: var(--accent-2);
    font-variant-numeric: tabular-nums;
  }
  .qr-frame {
    padding: 12px;
    border-radius: var(--r-lg);
    background: var(--white);
  }
  .qr-frame img {
    display: block;
    width: 220px;
    height: 220px;
  }
  .error-text {
    color: var(--danger);
    font-size: var(--fs-body);
  }
  .spinner.small {
    width: 32px;
    height: 32px;
    border-width: 3px;
  }
  .footer-note {
    position: absolute;
    bottom: 48px;
    left: 0;
    right: 0;
    text-align: center;
    color: var(--text-3);
    font-size: var(--fs-small);
  }
</style>
