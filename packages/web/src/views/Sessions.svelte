<script lang="ts">
  import { onMount } from 'svelte';
  import { api, currentProject } from '../lib/store.svelte';

  let sessions = $state<Array<Record<string, any>>>([]);
  let scope = $state('demo');
  let open: Record<string, any> | null = $state(null);
  let error = $state('');
  let seq = 0;
  let newTitle = $state('');
  let newRole = $state<'user' | 'assistant'>('user');
  let newContent = $state('');

  // Filter to the selected project when one is active.
  $effect(() => {
    const s = currentProject.slug;
    if (s && scope !== s) {
      scope = s;
      void load();
    }
  });

  async function load() {
    const mine = ++seq;
    error = '';
    try {
      const r = await api().sessions.list(scope, 100);
      if (mine === seq) sessions = r;
    } catch (e) {
      if (mine === seq) error = (e as Error).message;
    }
  }

  async function openSession(id: string) {
    error = '';
    try {
      open = await api().sessions.get(id);
    } catch (e) {
      error = (e as Error).message;
    }
  }

  async function createSession() {
    if (!newTitle.trim()) return;
    error = '';
    try {
      await api().sessions.create({ scope, title: newTitle.trim() });
      newTitle = '';
      await load();
    } catch (e) {
      error = (e as Error).message;
    }
  }

  async function appendMsg() {
    if (!open || !newContent.trim()) return;
    error = '';
    try {
      await api().sessions.append(open.id, { role: newRole, content: newContent.trim() });
      newContent = '';
      open = await api().sessions.get(open.id);
    } catch (e) {
      error = (e as Error).message;
    }
  }

  onMount(() => void load());
</script>

<div class="page">
  <h1>Sessions <span class="scope">{scope}</span></h1>
  {#if error}<p class="err">{error}</p>{/if}

  <div class="row">
    <input value={scope} oninput={(e) => (scope = (e.currentTarget as HTMLInputElement).value)} onchange={() => load()} placeholder="scope" />
    <button onclick={() => load()}>refresh</button>
  </div>

  <form class="row" onsubmit={(e) => { e.preventDefault(); createSession(); }}>
    <input value={newTitle} oninput={(e) => (newTitle = (e.currentTarget as HTMLInputElement).value)} placeholder="new session title…" />
    <button type="submit">start session</button>
  </form>

  <div class="split">
    <ul class="list">
      {#each sessions as s (s.id)}
        <li class:active={open && open.id === s.id} onclick={() => openSession(s.id)}>
          <span class="ttl">{s.title || '(untitled)'}</span>
          <span class="meta">{(s.messages ?? []).length} msgs · {String(s.startedAt).replace('T', ' ').slice(0, 16)}</span>
        </li>
      {/each}
      {#if sessions.length === 0}<li class="empty">No sessions in scope {scope} yet.</li>{/if}
    </ul>

    <div class="thread">
      {#if open}
        <h2>{open.title || open.id} <span class="scope">{open.scope}</span></h2>
        <div class="msgs">
          {#each open.messages as m (m.at)}
            <div class="msg {m.role}">
              <span class="r">{m.role}</span>
              <span class="c">{m.content}</span>
            </div>
          {/each}
          {#if (open.messages ?? []).length === 0}<p class="empty">No messages yet.</p>{/if}
        </div>
        <div class="compose">
          <select bind:value={newRole}><option value="user">user</option><option value="assistant">assistant</option></select>
          <input value={newContent} oninput={(e) => (newContent = (e.currentTarget as HTMLInputElement).value)} placeholder="append a message…" />
          <button onclick={() => appendMsg()}>send</button>
        </div>
      {:else}
        <p class="empty">Select a session to view its conversation.</p>
      {/if}
    </div>
  </div>
</div>

<style>
  .page { max-width: 1000px; margin: 0 auto; padding: 20px; }
  h1 { font-size: 20px; color: #e6e8ee; }
  .scope { color: #9aa4ff; font-size: 13px; font-weight: 500; margin-left: 6px; }
  .row { display: flex; gap: 8px; margin: 12px 0; }
  .row input, .compose input { flex: 1; background: #0f1117; color: #e6e8ee; border: 1px solid #333a4d; border-radius: 6px; padding: 8px 10px; }
  .compose select, .compose input, .row select { background: #0f1117; color: #e6e8ee; border: 1px solid #333a4d; border-radius: 6px; padding: 8px; }
  button { background: #4f5bd5; color: #fff; border: none; border-radius: 8px; padding: 8px 14px; cursor: pointer; }
  .err { color: #ff6b6b; }
  .split { display: grid; grid-template-columns: 300px 1fr; gap: 16px; }
  .list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
  .list li { background: #151823; border: 1px solid #262a36; border-radius: 8px; padding: 10px 12px; cursor: pointer; display: flex; flex-direction: column; gap: 3px; }
  .list li.active { border-color: #4f5bd5; }
  .list .ttl { color: #e6e8ee; font-weight: 600; }
  .list .meta { color: #556; font-size: 12px; }
  .thread { background: #151823; border: 1px solid #262a36; border-radius: 10px; padding: 14px; min-height: 300px; display: flex; flex-direction: column; gap: 10px; }
  .thread h2 { font-size: 15px; color: #e6e8ee; margin: 0; }
  .msgs { display: flex; flex-direction: column; gap: 8px; flex: 1; max-height: 60vh; overflow: auto; }
  .msg { display: flex; gap: 10px; font-size: 13px; line-height: 1.45; }
  .msg .r { min-width: 70px; color: #9aa4ff; font-weight: 600; text-transform: capitalize; }
  .msg.user .r { color: #7fd; }
  .msg .c { color: #d7dae2; white-space: pre-wrap; word-break: break-word; }
  .compose { display: flex; gap: 8px; }
  .empty { color: #556; font-size: 13px; }
</style>
