<script lang="ts">
  import { onMount } from 'svelte';
  import { api, currentProject, setCurrentProject } from '../lib/store.svelte';

  let projects = $state<Array<Record<string, any>>>([]);
  let name = $state('');
  let slug = $state('');
  let description = $state('');
  let token = $state<string | null>(null);
  let error = $state('');
  let copied = $state(false);
  let seq = 0;

  const slugOK = /^[a-z0-9][a-z0-9-_/]*$/i;

  async function load() {
    const mine = ++seq;
    try {
      const r = await api().projects.list();
      if (mine === seq) projects = r;
    } catch (e) {
      if (mine === seq) error = (e as Error).message;
    }
  }

  async function remove(slugToDelete: string) {
    if (!confirm(`Delete project "${slugToDelete}" and ALL of its memory/docs/sessions? This cannot be undone.`)) return;
    error = '';
    try {
      await api().projects.remove(slugToDelete);
      if (currentProject.slug === slugToDelete) setCurrentProject(null);
      await load();
    } catch (e) {
      error = (e as Error).message;
    }
  }

  async function create() {
    token = null;
    error = '';
    try {
      const res = await api().projects.ensure({ slug: slug.trim(), name: name.trim(), description: description.trim() || undefined });
      if (res.token) token = res.token; // shown once
      slug = '';
      name = '';
      description = '';
      await load();
    } catch (e) {
      error = (e as Error).message;
    }
  }

  async function copyToken() {
    if (!token) return;
    await navigator.clipboard.writeText(token);
    copied = true;
    setTimeout(() => (copied = false), 1500);
  }

  onMount(load);
</script>

<h2>Projects</h2>
<p class="hint">Agent workspaces. Each project is its own <code>scope</code> — create/ensure it here or from any connected coding agent via the SDK/MCP.</p>

{#if error}<div class="err">{error}</div>{/if}

{#if token}
  <div class="token">
    <strong>Project provisioned — here is your scoped token (shown once)</strong>
    <code>{token}</code>
    <button onclick={copyToken}>{copied ? 'copied ✓' : 'copy'}</button>
    <p class="note">Use this PAT to operate on <code>{token ? 'this project' : ''}</code> scope. Store it somewhere safe.</p>
  </div>
{/if}

<form class="new" onsubmit={(e) => { e.preventDefault(); create(); }}>
  <label>name <input bind:value={name} placeholder="Acme" /></label>
  <label>slug <input bind:value={slug} placeholder="acme" /></label>
  <label>description <input bind:value={description} placeholder="optional" /></label>
  <button disabled={!name.trim() || !slug.trim()}>create / ensure</button>
</form>

<ul class="projs">
  {#each projects as p (p.id)}
    <li class:active={currentProject.slug === p.slug}>
      <span class="slug">{p.slug}</span><span class="name">{p.name}</span>{#if p.description}<span class="desc">{p.description}</span>{/if}<span class="when">{p.createdAt?.slice(0, 10)}</span>
      <button class="del" title="Delete project" onclick={() => remove(p.slug)}>delete</button>
    </li>
  {/each}
  {#if projects.length === 0}<li class="empty">No projects yet.</li>{/if}
</ul>

<style>
  .hint { color: #889; }
  .hint code, .token code { background: #1a1e2c; padding: 2px 6px; border-radius: 4px; }
  .token { border: 1px solid #4f5bd5; background: #1a1e2c; border-radius: 10px; padding: 14px; margin-bottom: 16px; display: grid; gap: 8px; }
  .token code { word-break: break-all; font-size: 13px; }
  .note { color: #889; font-size: 12px; margin: 0; }
  .new { display: grid; grid-template-columns: 1fr 1fr 2fr auto; gap: 10px; align-items: end; margin-bottom: 18px; }
  .new label { display: grid; gap: 4px; color: #889; font-size: 12px; }
  .new input { background: #0f1117; color: inherit; border: 1px solid #333a4d; border-radius: 6px; padding: 8px; }
  button { background: #4f5bd5; color: #fff; border: none; border-radius: 8px; padding: 9px 14px; cursor: pointer; }
  .projs { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
  .projs li { display: flex; gap: 14px; align-items: baseline; background: #151823; border: 1px solid #262a36; border-radius: 8px; padding: 10px 14px; }
  .projs li.active { border-color: #4f5bd5; }
  .projs .slug { color: #9aa4ff; font-weight: 600; }
  .projs .name { color: #e6e8ee; }
  .projs .desc { color: #889; font-size: 13px; flex: 1; }
  .projs .when { color: #556; font-size: 12px; margin-left: auto; }
  .projs button.del { background: transparent; color: #ff6b6b; border: 1px solid #5a2b33; border-radius: 6px; padding: 4px 10px; cursor: pointer; font-size: 12px; margin-left: 8px; }
  .projs button.del:hover { background: #5a2b33; }
  .empty { color: #556; }
  .err { color: #ff6b6b; }
</style>
