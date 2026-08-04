import { AgentDoxClient } from '@agentdox/sdk';
import { config } from './config';

/**
 * Module-level runes store. Exposed as an object so components read the reactive
 * `.token` property (Svelte 5 forbids exporting a reassigned bare `$state`).
 */
export const auth = $state<{ token: string | null }>({
  token: typeof localStorage !== 'undefined' ? localStorage.getItem('agentdox:token') : null,
});

export function setToken(t: string | null): void {
  auth.token = t;
  if (t) localStorage.setItem('agentdox:token', t);
  else localStorage.removeItem('agentdox:token');
}

/** Build an authenticated SDK client bound to the current token. */
export function api(): AgentDoxClient {
  // Native fetch binding is handled inside the SDK (calls fetch unbound).
  return new AgentDoxClient(config.apiBase, undefined, auth.token ?? undefined);
}
