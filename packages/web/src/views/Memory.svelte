<script lang="ts">
  import { onMount } from 'svelte';
  import { api, currentProject } from '../lib/store.svelte';

  let entries = $state<Array<Record<string, any>>>([]);
  let category = $state('demo');
  let content = $state('');
  let error = $state('');
  let busy = $state(false);
  let seq = 0;

  // Filter to the selected project when one is active.
  $effect(() => {
    const s = currentProject.slug;
    if (s && category !== s) {
      category = s;
      void load();
    }
  });

  async function load() {
    const mine = ++seq;
    try {
      const r = await api().memory.list();
      if (mine === seq) { entries = r; error = ''; }
    } catch (e) {
      if (mine === seq) error = (e as Error).message;
    }
  }

  async function create() {
    if (!content.trim()) return;
    busy = true;
    try {
      await api().memory.create({ content: content.trim(), category: category.trim() || undefined });
      content = '';
      await load();
    } catch (e) {
      error = (e as Error).message;
    }
    busy = false;
  }

  onMount(load);
</script>

<h2>Memory</h2>
{#if error}<div class="err">{error}</div>{/if}

<form class="row" onsubmit={(e) => { e.preventDefault(); create(); }}>
  <input bind:value={category} placeholder="scope / category" class="cat" />
  <input bind:value={content} placeholder="a durable fact… (keep it compact & high-signal)" class="grow" />
  <button disabled={busy}>save</button>
</form>

<ul class="mem">
  {#each entries as e (e.id)}
    <li>
      <span class="cat">{e.category || '—'}{e.target ? `/ ${e.target}` : ''}</span>
      <span class="imp" title="importance">{e.importance}</span>
      <span class="txt">{e.content}</span>
    </li>
  {/each}
  {#if entries.length === 0}<li class="empty">No memory yet.</li>{/if}
</ul>

<style>
  h2 { margin-top: 0; }
  .row { display: flex; gap: 8px; margin-bottom: 16px; }
  .row input { background: #0f1117; color: inherit; border: 1px solid #333a4d; border-radius: 6px; padding: 8px; }
  .cat { width: 120px; }
  .grow { flex: 1; }
  button { background: #4f5bd5; color: #fff; border: none; border-radius: 8px; padding: 0 18px; cursor: pointer; }
  .mem { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
  .mem li { display: flex; gap: 12px; align-items: baseline; background: #151823; border: 1px solid #262a36; border-radius: 8px; padding: 10px 14px; }
  .mem .cat { color: #9aa4ff; font-size: 12px; white-space: nowrap; }
  .mem .imp { color: #caa66b; font-size: 12px; }
  .mem .txt { color: #e6e8ee; }
  .empty { color: #556; }
  .err { color: #ff6b6b; margin: 8px 0; }
</style>
