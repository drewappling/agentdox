<script lang="ts">
  import { onMount } from 'svelte';
  import { api } from '../lib/store.svelte';

  let scope = $state('demo');
  let query = $state('');
  const memoryLimit = $state(12);
  const docsLimit = $state(2);
  const sessionLimit = $state(10);
  let slice = $state<any | null>(null);
  let error = $state('');

  async function run() {
    try {
      slice = await api().context.assemble({ scope, query: query || undefined, memoryLimit, docsLimit, sessionLimit });
      error = '';
    } catch (e) {
      error = (e as Error).message;
    }
  }

  onMount(run);
</script>

<h2>Context assembly</h2>
<p class="hint">Assemble the prompt-ready context block for a scope — memory + docs + recent conversation, ranked by relevance.</p>

<div class="controls">
  <label>scope <input bind:value={scope} /></label>
  <label>query <input bind:value={query} placeholder="optional relevance bias" /></label>
  <label>memory {memoryLimit}</label>
  <label>docs {docsLimit}</label>
  <label>session {sessionLimit}</label>
  <button onclick={run}>assemble</button>
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
  .controls { display: flex; gap: 14px; flex-wrap: wrap; align-items: end; margin-bottom: 16px; }
  .controls label { display: grid; gap: 4px; color: #889; font-size: 12px; }
  .controls input { background: #0f1117; color: inherit; border: 1px solid #333a4d; border-radius: 6px; padding: 7px; width: 120px; }
  button { background: #4f5bd5; color: #fff; border: none; border-radius: 8px; padding: 8px 16px; cursor: pointer; }
  .meta { color: #9aa4ff; margin-bottom: 10px; }
  .prompt { background: #151823; border: 1px solid #262a36; border-radius: 10px; padding: 16px; white-space: pre-wrap; font: 13px/1.5 ui-monospace, monospace; }
  .empty, .err { color: #889; }
  .err { color: #ff6b6b; }
</style>
