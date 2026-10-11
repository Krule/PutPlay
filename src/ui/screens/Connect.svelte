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

<!-- Split frame (Apple-Music sign-in pattern): the brand frame is constant
     on the left; the right side is always the mechanism — the QR + code,
     its failure, or a loading spinner. The frame never gates the flow:
     startOOB() auto-fires, the QR is the first thing on screen. -->
<div class="connect fade-up">
  <div class="brand-side">
    <img class="brand-logo" src="icon.svg" alt="PutPlay" />
    <p class="brand-copy">Sign in to<br />put.io</p>
  </div>

  <div class="mech-side">
    {#if status === "loading"}
      <div class="mech-col">
        <div class="spinner"></div>
        <p class="muted">Checking for a saved session…</p>
      </div>
    {:else if status === "unauthed"}
      <div class="mech-col">
        {#if oobError}
          <!-- the failure renders INSIDE the frame — the brand frame stays,
               the mechanism side just hasn't succeeded yet -->
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
      <div class="mech-col">
        {#if oobQr}
          <div class="qr-card"><img src={oobQr} alt="QR code" /></div>
        {/if}
        {#if oobCode}
          <p class="code"><span class="code-num">{oobCode}</span></p>
          <p class="muted">or enter this code at <span class="linktext">{LINK_URL}</span></p>
        {/if}
        <div class="wait-row">
          <div class="spinner small"></div>
          <p class="muted">Waiting for approval…</p>
        </div>
        <button class="btn ghost" bind:this={newCodeBtn} data-focus on:click={startOOB}>
          Generate a new code
        </button>
      </div>
    {/if}
  </div>

  <p class="footer-note">Browse & play from your library · files stay on put.io</p>
</div>

<style>
  .connect {
    width: 1920px;
    height: 1080px;
    display: grid;
    grid-template-columns: 1fr 1fr;
    align-items: center;
    padding: 72px 112px 0;
    position: relative;
    overflow: hidden;
  }

  /* ---- left: brand frame ---- */
  .brand-side {
    display: flex;
    flex-direction: column;
    align-items: center;
    text-align: center;
  }
  .brand-side > :not(:first-child) {
    margin-top: 44px;
  }
  .brand-logo {
    width: 200px;
    height: 200px;
  }
  .brand-copy {
    font-size: var(--fs-display);
    font-weight: 700;
    line-height: 1.15;
    letter-spacing: -0.01em;
  }

  /* ---- right: the mechanism ---- */
  .mech-side {
    display: flex;
    justify-content: center;
  }
  .mech-col {
    display: flex;
    flex-direction: column;
    align-items: center;
    text-align: center;
  }
  .mech-col > :not(:first-child) {
    margin-top: 28px;
  }
  .qr-card {
    background: var(--white);
    border-radius: var(--r-lg);
    padding: 24px;
  }
  .qr-card img {
    display: block;
    width: 320px;
    height: 320px;
  }
  .code {
    margin: 0;
  }
  .code-num {
    font-size: var(--fs-display);
    font-weight: 800;
    letter-spacing: 0.12em;
    color: var(--accent-2);
    font-variant-numeric: tabular-nums;
  }
  .wait-row {
    display: flex;
    align-items: center;
    gap: 16px;
  }

  /* ---- shared ---- */
  .muted {
    color: var(--text-2);
    font-size: var(--fs-body);
    line-height: 1.5;
  }
  .linktext {
    color: var(--accent-2);
  }
  .btn.big {
    padding: 24px 48px;
    font-size: var(--fs-h3);
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
