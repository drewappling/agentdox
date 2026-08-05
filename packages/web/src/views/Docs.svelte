<script lang="ts">
  import { onMount } from 'svelte';
  import { api, currentProject } from '../lib/store.svelte';
  import { renderMarkdown } from '../lib/markdown';

  let docs = $state<Array<Record<string, any>>>([]);
  let scope = $state('demo');
  let current = $state<Record<string, any> | null>(null);
  let html = $state('');
  let source = $state('');
  let editing = $state(false);
  let error = $state('');
  let newSlug = $state('');
  let newTitle = $state('');
  let seq = 0;

  // Filter to the selected project when one is active.
  $effect(() => {
    const s = currentProject.slug;
    if (s && scope !== s) {
      scope = s;
      current = null;
      void load();
    }
  });

  async function load() {
    const mine = ++seq;
    try {
      const r = await api().docs.list({ scope });
      if (mine === seq) { docs = r; error = ''; }
    } catch (e) {
      if (mine === seq) error = (e as Error).message;
    }
  }

  async function open(d: Record<string, any>) {
    current = d;
    source = d.content;
    editing = false;
    // Top-level await so a render error surfaces (not an unhandled rejection).
    try {
      html = await renderMarkdown(d.content);
      error = '';
    } catch (e) {
      error = (e as Error).message;
    }
  }

  async function preview() {
    try {
      html = await renderMarkdown(source);
      error = '';
    } catch (e) {
      error = (e as Error).message;
    }
  }

  async function save() {
    if (!current) return;
    try {
      current = await api().docs.update(current.id, { content: source });
      editing = false;
      html = await renderMarkdown(current.content);
      await load();
    } catch (e) {
      error = (e as Error).message;
    }
  }

  async function cancel() {
    if (!current) return;
    editing = false;
    html = await renderMarkdown(current.content);
  }

  async function createDoc() {
    try {
      const title = newTitle.trim() || newSlug.trim();
      const d = await api().docs.create({
        slug: newSlug.trim(),
        title,
        content: `# ${title}\n\n`,
        scope,
      });
      newSlug = '';
      newTitle = '';
      await load();
      open(d);
    } catch (e) {
      error = (e as Error).message;
    }
  }

  onMount(load);
</script>

<h2>Docs</h2>
{#if error}<div class="err">{error}</div>{/if}

<div class="layout">
  <aside class="list">
    <label class="scope">scope <input bind:value={scope} onchange={load} /></label>
    <div class="new">
      <input bind:value={newSlug} placeholder="slug (guides/x)" />
      <input bind:value={newTitle} placeholder="title" />
      <button onclick={createDoc}>new</button>
    </div>
    <ul>
      {#each docs as d (d.id)}
        <li class:active={current?.id === d.id}>
          <button class="item" class:active={current?.id === d.id} onclick={() => open(d)}>
            <span class="slug">{d.slug}</span>
            <span class="v">v{d.version}</span>
          </button>
        </li>
      {/each}
      {#if docs.length === 0}<li class="empty">No docs in this scope.</li>{/if}
    </ul>
  </aside>

  <section class="content">
    {#if current}
      <div class="docbar">
        <span class="title">{current.title} <span class="v">v{current.version}</span></span>
        <div class="btns">
          {#if editing}
            <button onclick={preview}>preview</button>
            <button class="primary" onclick={save}>save → v{current.version + 1}</button>
            <button class="ghost" onclick={cancel}>cancel</button>
          {:else}
            <button onclick={() => { editing = true; }}>edit</button>
          {/if}
        </div>
      </div>
      {#if editing}
        <div class="split">
          <textarea bind:value={source} oninput={preview} spellcheck="false"></textarea>
          <div class="preview">{@html html}</div>
        </div>
      {:else}
        <article class="prose">{@html html}</article>
      {/if}
    {:else}
      <p class="empty">Select a doc on the left.</p>
    {/if}
  </section>
</div>

<style>
  .layout { display: grid; grid-template-columns: 260px 1fr; gap: 20px; align-items: start; }
  .list { display: flex; flex-direction: column; gap: 10px; }
  .scope input { width: 100%; box-sizing: border-box; background: #0f1117; color: inherit; border: 1px solid #333a4d; border-radius: 6px; padding: 7px; }
  .new { display: grid; gap: 6px; }
  .new input { background: #0f1117; color: inherit; border: 1px solid #333a4d; border-radius: 6px; padding: 7px; }
  .list ul { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
  .list li { padding: 0; border: 1px solid transparent; border-radius: 8px; }
  .list li.active { border-color: #4f5bd5; background: #1a1e2c; }
  .list button.item { width: 100%; display: flex; justify-content: space-between; align-items: center; gap: 8px; padding: 8px 10px; background: transparent; color: inherit; border: none; border-radius: 8px; cursor: pointer; text-align: left; }
  .list button.item:hover { background: #1a1e2c; }
  .slug { color: #e6e8ee; font-size: 13px; }
  .v { color: #556; font-size: 12px; }
  button { background: #2b3040; color: #fff; border: none; border-radius: 6px; padding: 6px 12px; cursor: pointer; }
  button.primary { background: #4f5bd5; }
  button.ghost { background: transparent; color: #aab; border: 1px solid #333a4d; }
  .docbar { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; }
  .docbar .title { font-weight: 600; color: #fff; }
  .btns { display: flex; gap: 8px; }
  .split { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  textarea { width: 100%; height: 60vh; background: #0f1117; color: inherit; border: 1px solid #333a4d; border-radius: 8px; padding: 12px; font: 13px/1.5 ui-monospace, monospace; resize: none; }
  .prose, .preview { color: #e6e8ee; }
  :global(.prose) { line-height: 1.6; }
  :global(.prose pre) { background: #1a1e2c; padding: 12px; border-radius: 8px; overflow: auto; }
  :global(.prose code) { font-family: ui-monospace, monospace; }
  :global(.prose table) { border-collapse: collapse; }
  :global(.prose th, .prose td) { border: 1px solid #333a4d; padding: 6px 10px; }
  .empty { color: #556; }
  .err { color: #ff6b6b; }
</style>
