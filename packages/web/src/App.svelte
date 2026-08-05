<script lang="ts">
  import { onMount } from 'svelte';
  import { auth, setToken, currentProject, setCurrentProject, api } from './lib/store.svelte';
  import { handleLoginRedirect } from './lib/oidc';
  import Login from './views/Login.svelte';
  import Memory from './views/Memory.svelte';
  import Docs from './views/Docs.svelte';
  import Context from './views/Context.svelte';
  import Projects from './views/Projects.svelte';

  const readHash = () => (window.location.hash.replace(/^#/, '').split('?')[0] || '/memory');
  let route = $state(readHash());
  let projects = $state<Array<Record<string, any>>>([]);

  // Load the project list when signed in; drop the selection if the project disappears.
  $effect(() => {
    if (!auth.token) {
      projects = [];
      setCurrentProject(null);
      return;
    }
    api()
      .projects.list()
      .then((list) => {
        projects = list;
        if (currentProject.slug && !list.some((p) => p.slug === currentProject.slug)) setCurrentProject(null);
      })
      .catch(() => { /* list may be restricted; keep going */ });
  });

  const onHash = () => (route = readHash());

  onMount(async () => {
    window.addEventListener('hashchange', onHash);
    try {
      const t = await handleLoginRedirect();
      if (t) setToken(t);
      route = readHash();
    } catch {
      /* token exchange failed — remain on login */
    }
  });

  const nav = [
    ['/projects', 'Projects'],
    ['/memory', 'Memory'],
    ['/docs', 'Docs'],
    ['/context', 'Context'],
  ] as const;
</script>

{#if !auth.token}
  <Login />
{:else}
  <header class="bar">
    <span class="logo"><strong>agentdox</strong></span>
    <select
      class="proj"
      value={currentProject.slug ?? ''}
      onchange={(e) => setCurrentProject((e.currentTarget as HTMLSelectElement).value || null)}
      title="Filter the whole UI to one project/scope"
    >
      <option value="">all scopes</option>
      {#each projects as p (p.slug)}
        <option value={p.slug}>{p.name}</option>
      {/each}
    </select>
    <nav>
      {#each nav as [r, label]}
        <a href="#{r}" class:active={route === r}>{label}</a>
      {/each}
    </nav>
    <button class="ghost" onclick={() => setToken(null)}>sign out</button>
  </header>
  <main>
    {#if route === '/projects'}
      <Projects />
    {:else if route === '/docs'}
      <Docs />
    {:else if route === '/context'}
      <Context />
    {:else}
      <Memory />
    {/if}
  </main>
{/if}

<style>
  :global(body) {
    margin: 0;
    font-family: system-ui, -apple-system, sans-serif;
    background: #0f1117;
    color: #e6e8ee;
  }
  .bar {
    display: flex;
    align-items: center;
    gap: 20px;
    padding: 12px 20px;
    border-bottom: 1px solid #262a36;
    position: sticky;
    top: 0;
    background: #151823;
    z-index: 5;
  }
  .logo { color: #9aa4ff; letter-spacing: 0.3px; }
  .proj {
    background: #0f1117; color: #e6e8ee; border: 1px solid #333a4d; border-radius: 6px;
    padding: 5px 8px; font-size: 13px; max-width: 180px;
  }
  nav { display: flex; gap: 4px; flex: 1; }
  nav a {
    color: #aab; text-decoration: none; padding: 6px 12px; border-radius: 6px;
  }
  nav a.active { background: #2b3040; color: #fff; }
  button.ghost {
    background: transparent; color: #aab; border: 1px solid #333a4d; border-radius: 6px;
    padding: 6px 12px; cursor: pointer;
  }
  main { max-width: 1080px; margin: 0 auto; padding: 24px 20px; }
</style>
