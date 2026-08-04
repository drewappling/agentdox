<script lang="ts">
  import { onMount } from 'svelte';
  import { auth, setToken } from './lib/store.svelte';
  import { handleLoginRedirect } from './lib/oidc';
  import Login from './views/Login.svelte';
  import Memory from './views/Memory.svelte';
  import Docs from './views/Docs.svelte';
  import Context from './views/Context.svelte';

  const readHash = () => (window.location.hash.replace(/^#/, '').split('?')[0] || '/memory');
  let route = $state(readHash());

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
    <nav>
      {#each nav as [r, label]}
        <a href="#{r}" class:active={route === r}>{label}</a>
      {/each}
    </nav>
    <button class="ghost" onclick={() => setToken(null)}>sign out</button>
  </header>
  <main>
    {#if route === '/docs'}
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
