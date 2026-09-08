<script lang="ts">
  import { onMount } from 'svelte';
  import { api } from '../lib/store.svelte';
  import type { TokenSummary, WhoAmI } from '@agentdox/sdk';
  import { config } from '../lib/config';

  type Role = 'read' | 'write' | 'admin';
  interface GrantRow { scope: string; role: Role }

  let me = $state<WhoAmI | null>(null);
  let tokens = $state<TokenSummary[]>([]);
  let forbidden = $state(false);
  let error = $state('');
  let name = $state('');
  let rows = $state<GrantRow[]>([{ scope: '*', role: 'admin' }]);
  let ttlDays = $state('');
  let issued = $state<{ token: string; name: string } | null>(null);
  let copied = $state(false);
  let showRevoked = $state(false);

  // What a token needs for the clients that connect here. Kept in the UI so the person minting
  // the token does not have to reverse-engineer the grants from a 403.
  const PRESETS: Array<{ label: string; name: string; rows: GrantRow[]; why: string }> = [
    { label: 'auto-model-router team', name: 'amr-team', rows: [{ scope: '*', role: 'admin' }], why: 'The team edition creates a project per group and its router reads and writes each group\'s scope, so it needs admin on every scope.' },
    { label: 'coding agent, all projects', name: 'agent', rows: [{ scope: '*', role: 'write' }], why: 'Reads and writes memory, docs and sessions in every scope; cannot mint tokens or create projects.' },
    { label: 'one project, read-only', name: 'reader', rows: [{ scope: '', role: 'read' }], why: 'Fill in the scope. Dashboards and reviewers.' },
  ];

  const apiBase = () => (config.apiBase && config.apiBase !== '/api' ? config.apiBase : window.location.origin.replace(/:\d+$/, ':3003'));

  async function load() {
    error = '';
    try {
      me = await api().tokens.me();
    } catch (e) {
      error = (e as Error).message;
      return;
    }
    if (!me.wildcardAdmin) { forbidden = true; return; }
    try {
      tokens = await api().tokens.list();
      forbidden = false;
    } catch (e) {
      forbidden = /403|forbidden/i.test((e as Error).message);
      if (!forbidden) error = (e as Error).message;
    }
  }

  function applyPreset(p: (typeof PRESETS)[number]) {
    name = p.name;
    rows = p.rows.map((r) => ({ ...r }));
  }

  function grants(): Record<string, Role> {
    const g: Record<string, Role> = {};
    for (const r of rows) if (r.scope.trim()) g[r.scope.trim()] = r.role;
    return g;
  }

  async function create() {
    issued = null;
    error = '';
    const g = grants();
    if (Object.keys(g).length === 0) { error = 'add at least one scope'; return; }
    const days = Number(ttlDays);
    try {
      const r = await api().tokens.create({ name: name.trim() || undefined, grants: g, ...(days > 0 ? { ttlMs: days * 86_400_000 } : {}) });
      issued = { token: r.token, name: name.trim() || r.id };
      name = '';
      rows = [{ scope: '*', role: 'admin' }];
      ttlDays = '';
      await load();
    } catch (e) {
      error = (e as Error).message;
    }
  }

  async function revoke(t: TokenSummary) {
    if (!confirm(`Revoke "${t.name ?? t.id}"? Every client using it stops working immediately.`)) return;
    error = '';
    try {
      await api().tokens.revoke(t.id);
      await load();
    } catch (e) {
      error = (e as Error).message;
    }
  }

  async function copy() {
    if (!issued) return;
    await navigator.clipboard.writeText(issued.token);
    copied = true;
    setTimeout(() => (copied = false), 1500);
  }

  const fmtGrants = (g: Record<string, string>) => Object.entries(g).map(([s, r]) => `${s}: ${r}`).join(', ') || '(none)';
  const when = (iso: string) => iso.slice(0, 16).replace('T', ' ');
  const expiry = (t: TokenSummary) => (t.expiresAt ? (t.expiresAt < Date.now() ? 'expired' : `expires ${new Date(t.expiresAt).toISOString().slice(0, 10)}`) : 'no expiry');

  onMount(load);
</script>

<h2>Tokens</h2>
<p class="hint">Personal access tokens are how agents, the MCP server and the auto-model-router team edition authenticate. A token is shown <strong>once</strong>; only its hash is stored.</p>

{#if error}<div class="err">{error}</div>{/if}

{#if me}
  <div class="me">
    <span class="label">you</span>
    <span class="who">{me.name ?? me.sub}</span>
    <span class="grants">{fmtGrants(me.grants)}</span>
    {#if !me.authEnabled}<span class="tag">auth off: everything is allowed</span>{/if}
  </div>
{/if}

{#if forbidden}
  <div class="box">
    <strong>Managing tokens needs a wildcard-admin token.</strong>
    <p>Your token can use its scopes but cannot list or mint tokens. Sign out and sign in with the bootstrap admin token (<code>AGENTDOX_ADMIN_TOKEN</code> in the deployment's <code>deploy/.env</code>) or any token granted <code>*: admin</code>. Without the UI, the same thing over HTTP:</p>
    <pre>curl -X POST {apiBase()}/auth/tokens \
  -H "Authorization: Bearer $AGENTDOX_ADMIN_TOKEN" \
  -H 'content-type: application/json' \
  -d '&#123;"name":"amr-team","grants":&#123;"*":"admin"&#125;&#125;'</pre>
  </div>
{:else if me}
  {#if issued}
    <div class="token">
      <strong>Token "{issued.name}" — copy it now, it is not shown again</strong>
      <code>{issued.token}</code>
      <button onclick={copy}>{copied ? 'copied ✓' : 'copy'}</button>
    </div>
  {/if}

  <form class="new" onsubmit={(e) => { e.preventDefault(); create(); }}>
    <div class="presets">
      <span class="label">presets</span>
      {#each PRESETS as p}
        <button type="button" class="ghost" title={p.why} onclick={() => applyPreset(p)}>{p.label}</button>
      {/each}
    </div>
    <div class="row">
      <label>name <input bind:value={name} placeholder="amr-team" /></label>
      <label>expires in days <input bind:value={ttlDays} placeholder="never" inputmode="numeric" /></label>
    </div>
    <div class="grants-edit">
      <span class="label">grants <em>(scope → role; <code>*</code> = every scope; <code>admin</code> on <code>*</code> may also mint tokens and create projects)</em></span>
      {#each rows as r, i}
        <div class="grant">
          <input bind:value={r.scope} placeholder="scope slug or *" />
          <select bind:value={r.role}>
            <option value="read">read</option>
            <option value="write">write</option>
            <option value="admin">admin</option>
          </select>
          <button type="button" class="ghost" onclick={() => (rows = rows.filter((_, j) => j !== i))} disabled={rows.length === 1}>remove</button>
        </div>
      {/each}
      <button type="button" class="ghost" onclick={() => (rows = [...rows, { scope: '', role: 'read' }])}>+ scope</button>
    </div>
    <button>mint token</button>
  </form>

  <div class="listhead">
    <h3>Existing tokens</h3>
    <label class="small"><input type="checkbox" bind:checked={showRevoked} /> show revoked</label>
  </div>
  <ul class="toks">
    {#each tokens.filter((t) => showRevoked || !t.revoked) as t (t.id)}
      <li class:revoked={t.revoked}>
        <span class="name">{t.name ?? t.id}</span>
        <span class="grants">{fmtGrants(t.grants)}</span>
        <span class="when">{when(t.createdAt)} · {expiry(t)}{t.revoked ? ' · revoked' : ''}</span>
        {#if !t.revoked}<button class="del" onclick={() => revoke(t)}>revoke</button>{/if}
      </li>
    {/each}
    {#if tokens.length === 0}<li class="empty">No tokens yet.</li>{/if}
  </ul>
{/if}

<style>
  .hint { color: #889; }
  .hint code, .box code, .grants-edit code { background: #1a1e2c; padding: 2px 6px; border-radius: 4px; }
  .label { color: #889; font-size: 12px; }
  .me { display: flex; gap: 12px; align-items: baseline; background: #151823; border: 1px solid #262a36; border-radius: 8px; padding: 10px 14px; margin-bottom: 16px; }
  .me .who { color: #9aa4ff; font-weight: 600; }
  .me .grants, .toks .grants { color: #aab; font-size: 13px; }
  .tag { color: #ffb86b; font-size: 12px; margin-left: auto; }
  .box { border: 1px solid #5a4a2b; background: #1a1e2c; border-radius: 10px; padding: 14px; display: grid; gap: 8px; }
  .box p { margin: 0; color: #aab; }
  .box pre { margin: 0; background: #0f1117; padding: 10px; border-radius: 6px; font-size: 12px; overflow-x: auto; }
  .token { border: 1px solid #4f5bd5; background: #1a1e2c; border-radius: 10px; padding: 14px; margin-bottom: 16px; display: grid; gap: 8px; }
  .token code { word-break: break-all; font-size: 13px; background: #0f1117; padding: 6px; border-radius: 4px; }
  .new { display: grid; gap: 12px; background: #151823; border: 1px solid #262a36; border-radius: 10px; padding: 14px; margin-bottom: 20px; }
  .presets { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  .row { display: grid; grid-template-columns: 2fr 1fr; gap: 10px; }
  .new label { display: grid; gap: 4px; color: #889; font-size: 12px; }
  .new input, .new select { background: #0f1117; color: inherit; border: 1px solid #333a4d; border-radius: 6px; padding: 8px; }
  .grants-edit { display: grid; gap: 6px; }
  .grants-edit em { font-style: normal; color: #667; }
  .grant { display: grid; grid-template-columns: 2fr 1fr auto; gap: 8px; }
  button { background: #4f5bd5; color: #fff; border: none; border-radius: 8px; padding: 9px 14px; cursor: pointer; justify-self: start; }
  button.ghost { background: transparent; color: #aab; border: 1px solid #333a4d; padding: 6px 10px; font-size: 12px; }
  button:disabled { opacity: 0.4; cursor: default; }
  .listhead { display: flex; align-items: baseline; gap: 16px; }
  .listhead h3 { margin: 0 0 8px; font-size: 15px; }
  .small { color: #889; font-size: 12px; }
  .toks { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
  .toks li { display: flex; gap: 14px; align-items: baseline; background: #151823; border: 1px solid #262a36; border-radius: 8px; padding: 10px 14px; }
  .toks li.revoked { opacity: 0.55; }
  .toks .name { color: #9aa4ff; font-weight: 600; }
  .toks .when { color: #556; font-size: 12px; margin-left: auto; white-space: nowrap; }
  .toks button.del { background: transparent; color: #ff6b6b; border: 1px solid #5a2b33; border-radius: 6px; padding: 4px 10px; font-size: 12px; }
  .toks button.del:hover { background: #5a2b33; }
  .empty { color: #556; }
  .err { color: #ff6b6b; margin-bottom: 10px; }
</style>
