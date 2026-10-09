<script lang="ts">
  import { onMount } from "svelte";
  import { get } from "svelte/store";
  import { startOOB, usePastedToken, LINK_URL } from "../../store/auth";
  import type { AuthState, AuthStore } from "../../store/auth";

  export let state: AuthStore;

  let s: AuthState;
  let pasteValue = "";
  let mode: "choice" | "paste" = "choice";

  let oobCode: string;
  let oobQr: string | null;
  let oobError: string | null;
  let status: AuthState["status"];

  $: sync();
  function sync() {
    const v = get(state);
    s = v;
    oobCode = v.oobCode;
    oobQr = v.oobQr;
    oobError = v.oobError;
    status = v.status;
  }

  let oobBtn: HTMLButtonElement;
  let pasteBtn: HTMLButtonElement;
  let tokenInput: HTMLInputElement;

  function onKey(e: KeyboardEvent) {
    if (status !== "unauthed") return;
    const code = (e as any).keyCode as number;
    if (mode === "paste" && tokenInput && document.activeElement === tokenInput) {
      if (code === 13 || e.key === "Enter") {
        e.preventDefault();
        submitPaste();
      }
      return;
    }
    if (code === 39 || code === 37 || e.key === "ArrowLeft" || e.key === "ArrowRight") {
      if (oobBtn && pasteBtn) {
        e.preventDefault();
        e.stopPropagation();
        const active = document.activeElement;
        for (const b of [oobBtn, pasteBtn]) if (b) b.dataset.state = b === active ? "active" : "";
        const target = active === oobBtn ? pasteBtn : oobBtn;
        if (target) {
          target.focus();
          target.dataset.state = "active";
        }
      }
    }
    if (code === 13 || e.key === "Enter") {
      if (mode === "choice") startOOB();
    }
  }

  function submitPaste() {
    if (tokenInput) usePastedToken(tokenInput.value);
  }

  onMount(() => {
    sync();
    const unsub = state.subscribe(sync);
    window.addEventListener("keydown", onKey, true);
    return () => {
      unsub();
      window.removeEventListener("keydown", onKey, true);
    };
  });
</script>

<div class="connect fade-up">
  <div class="brand">
    <img src="icon.png" alt="put.io" class="logo" />
    <div class="brand-text">
      <h1>put.io</h1>
      <p class="tag">your library, on the big screen</p>
    </div>
  </div>

  {#if status === "loading"}
    <div class="center-col">
      <div class="spinner"></div>
      <p class="muted">Checking for a saved session…</p>
    </div>
  {:else if status === "unauthed"}
    <div class="center-col">
      {#if mode === "choice"}
        <h2 class="h2">Connect your put.io</h2>
        <p class="muted">Choose how you'd like to sign in.</p>
        <div class="row">
          <button class="btn primary big" bind:this={oobBtn} data-focus on:click={startOOB}>
            Sign in with code
          </button>
          <button
            class="btn ghost big"
            bind:this={pasteBtn}
            data-focus
            on:click={() => {
              mode = "paste";
              tokenInput?.focus();
            }}
          >
            Paste a token
          </button>
        </div>
        <p class="hint">
          New here? Create an account at
          <a
            href="#"
            on:click={(e) => {
              e.preventDefault();
              window.open("https://app.put.io", "_blank");
            }}
            >app.put.io</a
          >
        </p>
      {:else}
        <h2 class="h2">Paste your put.io token</h2>
        <p class="muted">From app.put.io → click your name → your personal token</p>
        <input
          bind:this={tokenInput}
          bind:value={pasteValue}
          class="token-input"
          placeholder="Paste token here and press OK"
          spellcheck="false"
          on:keydown={(e) => {
            if (e.key === "Enter") submitPaste();
          }}
        />
        <div class="row">
          <button class="btn primary" on:click={submitPaste}>Connect</button>
          <button
            class="btn ghost"
            on:click={() => {
              mode = "choice";
              pasteValue = "";
            }}
            >Back</button
          >
        </div>
      {/if}
      {#if oobError}
        <p class="error-text">{oobError}</p>
      {/if}
    </div>
  {:else if status === "pending"}
    <div class="center-col">
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
      <button class="btn ghost" data-focus on:click={startOOB}>Generate a new code</button>
    </div>
  {/if}

  <p class="footer-note">Browse & play from your library · files stay on put.io</p>
</div>

<style>
  .connect {
    width: 1920px;
    height: 1080px;
    display: flex;
    flex-direction: column;
    align-items: center;
    padding-top: 104px;
    position: relative;
    overflow: hidden;
  }
  .brand {
    display: flex;
    align-items: center;
    gap: 26px;
    margin-bottom: 64px;
  }
  .logo {
    width: 96px;
    height: 96px;
    border-radius: var(--r-lg);
  }
  .brand-text h1 {
    font-size: var(--fs-display);
    font-weight: 800;
    letter-spacing: -0.02em;
    line-height: 1;
  }
  .brand-text .tag {
    margin-top: 10px;
    font-size: var(--fs-h3);
    color: var(--text-2);
  }
  .center-col {
    display: flex;
    flex-direction: column;
    align-items: center;
    text-align: center;
    gap: 26px;
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
  .row {
    display: flex;
    gap: 24px;
  }
  .btn.big {
    padding: 22px 48px;
    font-size: var(--fs-h3);
  }
  .hint {
    color: var(--text-3);
    font-size: var(--fs-small);
    margin-top: 12px;
  }
  .hint a {
    color: var(--accent-2);
    text-decoration: none;
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
  .token-input {
    width: 760px;
    padding: 20px 26px;
    font-size: var(--fs-body);
    border-radius: var(--r-md);
    background: var(--surface);
    border: 2px solid var(--line-strong);
    color: var(--text);
    outline: none;
    text-align: center;
    letter-spacing: 0.04em;
  }
  .token-input:focus {
    border-color: var(--accent);
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
    color: var(--text-3);
    font-size: var(--fs-small);
  }
</style>
