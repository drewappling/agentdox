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

  // Historic project brief (on-ramp)
  let brief = $state<any | null>(null);
  let bf = $state({ overview: '', repoLayout: '', codeStyle: '', buildTest: '', assetConventions: '', gotchas: '' });
  let dec = $state({ title: '', decision: '', rationale: '' });
  let briefMsg = $state('');

  // Filter to the selected project when one is active.
  $effect(() => {
    const s = currentProject.slug;
    if (s && scope !== s) {
      scope = s;
      void run();
      void loadSnapshot();
      void loadBrief();
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

  async function loadBrief() {
    try {
      brief = await api().context.brief.get(scope);
      bf = {
        overview: brief.overview ?? '',
        repoLayout: brief.repoLayout ?? '',
        codeStyle: brief.codeStyle ?? '',
        buildTest: brief.buildTest ?? '',
        assetConventions: brief.assetConventions ?? '',
        gotchas: brief.gotchas ?? '',
      };
      briefMsg = '';
    } catch {
      brief = null;
      bf = { overview: '', repoLayout: '', codeStyle: '', buildTest: '', assetConventions: '', gotchas: '' };
    }
  }

  async function saveBrief() {
    try {
      brief = await api().context.brief.save(scope, bf);
      briefMsg = 'brief saved';
    } catch (e) {
      briefMsg = (e as Error).message;
    }
  }

  async function addDecision() {
    if (!dec.title.trim() || !dec.decision.trim()) return;
    try {
      brief = await api().context.brief.addDecision(scope, { ...dec, rationale: dec.rationale || undefined });
      dec = { title: '', decision: '', rationale: '' };
      briefMsg = 'decision recorded';
    } catch (e) {
      briefMsg = (e as Error).message;
    }
  }

  async function seedBrief() {
    try {
      brief = await api().context.brief.seed(scope);
      bf = { overview: brief.overview ?? '', repoLayout: brief.repoLayout ?? '', codeStyle: brief.codeStyle ?? '', buildTest: brief.buildTest ?? '', assetConventions: brief.assetConventions ?? '', gotchas: brief.gotchas ?? '' };
      briefMsg = 'seeded from current memory/docs';
    } catch (e) {
      briefMsg = (e as Error).message;
    }
  }

  const fmt = (iso?: string) => (iso ? new Date(iso).toLocaleString() : '—');

  onMount(() => { void run(); void loadSnapshot(); void loadBrief(); });
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

<h3 class="brief-title">Project brief <span class="scope">{scope}</span></h3>
<p class="hint">Historic, cumulative on-ramp — decisions, repo/code conventions, gotchas. A new agent reads this when first starting on the project.</p>
{#if briefMsg}<span class="snap-msg-inline">{briefMsg}</span>{/if}
<div class="brief">
  <div class="brief-controls">
    <button class="ghost" onclick={seedBrief}>seed from memory/docs</button>
  </div>
  <div class="brief-grid">
    <label class="field">Overview <textarea rows="2" bind:value={bf.overview} placeholder="what this project is" /></label>
    <label class="field">Repo layout & tooling <textarea rows="2" bind:value={bf.repoLayout} placeholder="repos, layout, tooling" /></label>
    <label class="field">Code style <textarea rows="2" bind:value={bf.codeStyle} placeholder="styling / conventions" /></label>
    <label class="field">Build & test <textarea rows="2" bind:value={bf.buildTest} placeholder="build/test commands" /></label>
    <label class="field">Asset / art conventions <textarea rows="2" bind:value={bf.assetConventions} /></label>
    <label class="field">Gotchas <textarea rows="2" bind:value={bf.gotchas} /></label>
  </div>
  <button class="ghost" onclick={saveBrief}>save brief</button>

  <div class="decisions">
    <h4>Decision log</h4>
    <form class="decform" onsubmit={(e) => { e.preventDefault(); addDecision(); }}>
      <input bind:value={dec.title} placeholder="decision title" />
      <input bind:value={dec.decision} placeholder="the decision / convention" />
      <input bind:value={dec.rationale} placeholder="rationale (why)" />
      <button type="submit">record</button>
    </form>
    {#if brief && (brief.decisionLog ?? []).length}
      <ul class="decs">
        {#each brief.decisionLog as d (d.id)}
          <li>
            <span class="dttl">{d.title}</span>
            <span class="ddec">{d.decision}</span>
            {#if d.rationale}<span class="drat">— {d.rationale}</span>{/if}
            <span class="dwhen">{fmt(d.at)}</span>
          </li>
        {/each}
      </ul>
    {:else}
      <p class="empty">No decisions recorded yet — record them as they're made so a new agent sees the history.</p>
    {/if}
  </div>
</div>

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
  .brief-title { margin-top: 28px; font-size: 17px; color: #e6e8ee; }
  .brief { border: 1px solid #2f3a55; background: #12161f; border-radius: 10px; padding: 14px; display: grid; gap: 12px; }
  .brief-controls { display: flex; gap: 8px; }
  .brief-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  .brief .field { display: grid; gap: 4px; color: #889; font-size: 12px; }
  .brief textarea, .decform input { background: #0f1117; color: #e6e8ee; border: 1px solid #333a4d; border-radius: 6px; padding: 7px; font: 13px/1.4 ui-monospace, monospace; resize: vertical; }
  .decisions { border-top: 1px solid #262a36; padding-top: 10px; }
  .decisions h4 { margin: 0 0 8px; color: #9aa4ff; font-size: 13px; }
  .decform { display: flex; gap: 8px; flex-wrap: wrap; }
  .decform input { flex: 1; min-width: 160px; }
  .decs { list-style: none; margin: 10px 0 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
  .decs li { display: grid; grid-template-columns: 150px 1fr auto auto; gap: 10px; align-items: baseline; font-size: 13px; }
  .dttl { color: #e6e8ee; font-weight: 600; }
  .ddec { color: #cfd3e0; }
  .drat { color: #889; font-size: 12px; }
  .dwhen { color: #556; font-size: 11px; }
</style>
