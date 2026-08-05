<script lang="ts">
  import { onMount } from 'svelte';
  import { api, currentProject } from '../lib/store.svelte';

  let scope = $state('demo');
  let query = $state('');
  let memoryLimit = $state(12);
  let docsLimit = $state(2);
  let sessionLimit = $state(10);
  let slice = $state<any | null>(null);
  let snapshot = $state<any | null>(null);
  let error = $state('');
  let snapMsg = $state('');
  let seq = 0;

  // Filter to the selected project when one is active.
  $effect(() => {
    const s = currentProject.slug;
    if (s && scope !== s) {
      scope = s;
      void run();
      void loadSnapshot();
    }
  });

  async function run() {
    const mine = ++seq;
    try {
      const s = await api().context.assemble({ scope, query: query || undefined, memoryLimit, docsLimit, sessionLimit });
      if (mine === seq) { slice = s; error = ''; }
    } catch (e) {
      if (mine === seq) error = (e as Error).message;
    }
  }

  async function loadSnapshot() {
    try {
      snapshot = await api().context.snapshot(scope);
      snapMsg = '';
    } catch {
      snapshot = null; // 404 = not auto-refreshed yet
    }
  }

  async function refreshNow() {
    try {
      snapshot = await api().context.refresh(scope);
      snapMsg = 'refreshed just now';
    } catch (e) {
      snapMsg = (e as Error).message;
    }
  }

  const fmt = (iso?: string) => (iso ? new Date(iso).toLocaleString() : '—');

  onMount(() => { void run(); void loadSnapshot(); });
</script>

<h2>Context assembly</h2>
<p class="hint">Assemble the prompt-ready context block for a scope — memory + docs + recent conversation, ranked by relevance.</p>

{#if snapshot}
  <div class="snap">
    <span class="snap-title">Saved baseline (auto-refreshed)</span>
    <span class="snap-meta">
      chars <b>{snapshot.chars}</b> · memory <b>{snapshot.memoryHits}</b> · docs <b>{snapshot.docs}</b> · msgs <b>{snapshot.sessionMsgs}</b> ·
      refreshed <b>{fmt(snapshot.assembledAt)}</b>
    </span>
    <pre class="prompt">{snapshot.prompt}</pre>
  </div>
{:else if !error}
  <p class="hint">No auto-refreshed baseline yet — it will appear on the next job tick (or hit <i>refresh now</i>).</p>
{/if}

<div class="controls">
  <label class="field">scope <input bind:value={scope} /></label>
  <label class="field">query <input bind:value={query} placeholder="optional relevance bias" /></label>
  <label class="field">memory <input type="range" min="1" max="50" bind:value={memoryLimit} /> {memoryLimit}</label>
  <label class="field">docs <input type="range" min="0" max="20" bind:value={docsLimit} /> {docsLimit}</label>
  <label class="field">session <input type="range" min="0" max="50" bind:value={sessionLimit} /> {sessionLimit}</label>
  <button onclick={run}>assemble</button>
  <button class="ghost" onclick={refreshNow}>refresh now</button>
  {#if snapMsg}<span class="snap-msg-inline">{snapMsg}</span>{/if}
</div>

{#if error}<div class="err">{error}</div>{/if}

{#if slice}
  <div class="meta">
    chars: <b>{slice.chars}</b> · memory hits: <b>{slice.memory.length}</b> · docs: <b>{slice.docs.length}</b> · msgs: <b>{slice.sessionMessages.length}</b>
  </div>
  <pre class="prompt">{slice.prompt}</pre>
{:else}
  <p class="empty">Nothing assembled yet.</p>
{/if}

<style>
  .hint { color: #889; }
  .snap { border: 1px solid #2f3a55; background: #141a2b; border-radius: 10px; padding: 12px 14px; margin-bottom: 16px; display: grid; gap: 8px; }
  .snap-title { color: #9aa4ff; font-weight: 600; font-size: 13px; }
  .snap-meta { color: #889; font-size: 12px; }
  .snap-msg { color: #8f9; font-size: 12px; }
  .snap button.ghost { background: transparent; border: 1px solid #3a4668; color: #cbd; }
  .snap button.ghost:hover { background: #1c2440; }
  .controls { display: flex; gap: 14px; flex-wrap: wrap; align-items: end; margin-bottom: 16px; }
  .controls label { display: grid; gap: 4px; color: #889; font-size: 12px; }
  .controls input { background: #0f1117; color: inherit; border: 1px solid #333a4d; border-radius: 6px; padding: 7px; width: 120px; }
  button { background: #4f5bd5; color: #fff; border: none; border-radius: 8px; padding: 8px 16px; cursor: pointer; }
  button.ghost { background: transparent; border: 1px solid #3a4668; color: #cbd; }
  button.ghost:hover { background: #1c2440; }
  .snap-msg-inline { color: #8f9; font-size: 12px; }
  .meta { color: #9aa4ff; margin-bottom: 10px; }
  .prompt { background: #151823; border: 1px solid #262a36; border-radius: 10px; padding: 16px; white-space: pre-wrap; font: 13px/1.5 ui-monospace, monospace; }
  .empty, .err { color: #889; }
  .err { color: #ff6b6b; }
</style>
