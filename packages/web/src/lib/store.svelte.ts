import { AgentDoxClient } from '@agentdox/sdk';
import { config } from './config';

/**
 * Module-level runes store. Exposed as an object so components read the reactive
 * `.token` property (Svelte 5 forbids exporting a reassigned bare `$state`).
 */
// The bearer token lives in sessionStorage, not localStorage: it is a wildcard-admin-capable
// credential, so it must not survive a browser restart or be shared with other tabs.
export const auth = $state<{ token: string | null }>({
  token: typeof sessionStorage !== 'undefined' ? sessionStorage.getItem('agentdox:token') : null,
});

export function setToken(t: string | null): void {
  auth.token = t;
  if (t) sessionStorage.setItem('agentdox:token', t);
  else sessionStorage.removeItem('agentdox:token');
}

/** The currently-selected project (slug). Filters the whole UI to one scope. */
export const currentProject = $state<{ slug: string | null }>({
  slug: typeof localStorage !== 'undefined' ? localStorage.getItem('agentdox:project') : null,
});

export function setCurrentProject(slug: string | null): void {
  currentProject.slug = slug;
  if (slug) localStorage.setItem('agentdox:project', slug);
  else localStorage.removeItem('agentdox:project');
}

/** Build an authenticated SDK client bound to the current token. */
export function api(): AgentDoxClient {
  // Native fetch binding is handled inside the SDK (calls fetch unbound).
  return new AgentDoxClient(config.apiBase, undefined, auth.token ?? undefined);
}
