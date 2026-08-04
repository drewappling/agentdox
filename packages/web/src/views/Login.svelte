<script lang="ts">
  import { AgentDoxClient } from '@agentdox/sdk';
  import { startLogin } from '../lib/oidc';
  import { setToken } from '../lib/store.svelte';
  import { config } from '../lib/config';

  let pat = $state('');
  let msg = $state('');
  let busy = $state(false);

  async function usePat() {
    busy = true;
    msg = '';
    const raw = pat.trim();
    if (!raw) { busy = false; msg = 'enter a token'; return; }
    // Validate with a throwaway client first; only commit the token once it works,
    // so a bad token never flashes the authed shell.
    try {
      await new AgentDoxClient(config.apiBase, undefined, raw).health();
      setToken(raw);
      msg = 'authenticated';
    } catch (e) {
      msg = `token rejected: ${(e as Error).message}`;
    }
    busy = false;
  }
</script>

<div class="wrap">
  <div class="card">
    <h1>agentdox</h1>
    <p class="sub">dynamic context, memory &amp; docs for agents</p>

    <button class="primary" disabled={busy} onclick={() => startLogin()}>
      Continue with Keycloak
    </button>

    <div class="divider"><span>or</span></div>

    <label for="pat">Paste an access token (OIDC) or PAT</label>
    <textarea id="pat" bind:value={pat} rows={3} placeholder="token…"></textarea>
    <button onclick={usePat} disabled={busy}>Use token</button>

    {#if msg}<p class="msg">{msg}</p>{/if}
  </div>
</div>

<style>
  .wrap { display: grid; place-items: center; min-height: 70vh; }
  .card {
    width: 380px; background: #151823; border: 1px solid #262a36; border-radius: 14px;
    padding: 28px; display: flex; flex-direction: column; gap: 12px;
  }
  h1 { margin: 0; color: #9aa4ff; }
  .sub { margin: 0; color: #aab; }
  textarea { background: #0f1117; color: inherit; border: 1px solid #333a4d; border-radius: 6px; padding: 8px; }
  button { padding: 10px; border-radius: 8px; cursor: pointer; }
  button.primary { background: #4f5bd5; color: #fff; border: none; font-weight: 600; }
  .divider { text-align: center; color: #556; font-size: 13px; }
  .msg { color: #ff9a6b; margin: 0; font-size: 13px; }
  label { color: #889; font-size: 12px; }
</style>
