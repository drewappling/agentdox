<script lang="ts">
  import { onMount } from 'svelte';
  import { api, currentProject } from '../lib/store.svelte';

  let scope = $state('demo');
  let query = $state('');
  let memoryLimit = $state(12);
  let docsLimit = $state(2);
  let sessionLimit = $state(10);
  let slice = $state<any | null>(null);
  let error = $state('');
  let seq = 0;

  // Filter to the selected project when one is active.
  $effect(() => {
    const s = currentProject.slug;
    if (s && scope !== s) {
      scope = s;
      void run();
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

  onMount(run);
</script>

<h2>Context assembly</h2>
<p class="hint">Assemble the prompt-ready context block for a scope — memory + docs + recent conversation, ranked by relevance.</p>

<div class="controls">
  <label class="field">scope <input bind:value={scope} /></label>
  <label class="field">query <input bind:value={query} placeholder="optional relevance bias" /></label>
  <label class="field">memory <input type="range" min="1" max="50" bind:value={memoryLimit} /> {memoryLimit}</label>
  <label class="field">docs <input type="range" min="0" max="20" bind:value={docsLimit} /> {docsLimit}</label>
  <label class="field">session <input type="range" min="0" max="50" bind:value={sessionLimit} /> {sessionLimit}</label>
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
