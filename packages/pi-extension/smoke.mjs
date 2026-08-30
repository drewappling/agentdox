/**
 * Integration smoke for the agentdox pi extension.
 *
 * Drives the REAL extension factory with a mock omp host against a live agentdox server
 * (start `npm run dev:server` first, auth off). Run under Bun (omp's runtime):
 *
 *   bun packages/pi-extension/smoke.mjs
 */
import { tmpdir } from 'node:os';
import agentdoxMemory from './src/index.ts';

const URL = process.env.AGENTDOX_URL ?? 'http://localhost:3003';
const SCOPE = `pi-smoke-${Date.now()}`;
process.env.AGENTDOX_URL = URL;
process.env.AGENTDOX_SCOPE = SCOPE;
process.env.AGENTDOX_MEMORY_RETAIN_EVERY_TURNS = '1';
delete process.env.AGENTDOX_TOKEN;

const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

async function api(method, path, body) {
  const res = await fetch(`${URL}${path}`, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}`);
  return res.status === 204 ? null : await res.json();
}

// ---- mock omp host ----
const zt = () => {
  const o = {};
  for (const m of ['describe', 'optional', 'min', 'max', 'default']) o[m] = () => o;
  return o;
};
const handlers = new Map();
const tools = new Map();
const commands = new Map();
const sent = [];
const notes = [];

const pi = {
  zod: { object: () => zt(), string: () => zt(), number: () => zt(), array: () => zt() },
  logger: { info: () => {}, warn: (m) => console.error('[warn]', m), error: (m) => console.error('[err]', m) },
  setLabel: () => {},
  on: (e, h) => handlers.set(e, h),
  registerTool: (d) => tools.set(d.name, d),
  registerCommand: (n, d) => commands.set(n, d),
  sendMessage: (msg, opts) => sent.push({ msg, opts }),
};

let branch = [];
const ctx = {
  cwd: tmpdir(),
  hasUI: true,
  ui: { notify: (m) => notes.push(m) },
  sessionManager: { getBranch: () => branch, getSessionId: () => 'smoke-session' },
  logger: pi.logger,
};

async function main() {
  await api('GET', '/health');

  // seed something recall can find
  await api('POST', '/memory', { content: 'The build command is npm run build.', category: SCOPE, importance: 0.9 });
  await api('PUT', '/context/brief', { scope: SCOPE, overview: 'A smoke-test project.' });

  // run the extension factory + registrations
  agentdoxMemory(pi);
  check('registers recall/retain/reflect tools', ['recall', 'retain', 'reflect'].every((t) => tools.has(t)), [...tools.keys()].join(','));
  check('registers /agentdox command', commands.has('agentdox'));
  check('subscribes session lifecycle', handlers.has('session_start') && handlers.has('turn_end') && handlers.has('session_shutdown'));

  // session_start -> recall injection + retain session created
  await handlers.get('session_start')(null, ctx);
  const injected = sent.find((s) => typeof s.msg?.content === 'string' && s.msg.content.includes('<memories'));
  check('session_start injects a <memories> block', !!injected, injected ? `deliverAs=${injected.opts?.deliverAs}` : 'no injection');
  check('injected block carries seeded context', !!injected && /build command|smoke-test project/i.test(injected.msg.content));

  // retain tool
  const retainRes = await tools.get('retain').execute('t-retain', { content: 'Prefer tabs over spaces here.', importance: 0.8 }, undefined, undefined, ctx);
  check('retain tool stores a fact', !retainRes.isError, retainRes.content?.[0]?.text);
  const found = await api('GET', `/memory/search?q=${encodeURIComponent('tabs over spaces')}&category=${SCOPE}&limit=5`);
  check('retained fact is searchable via REST', Array.isArray(found) && found.some((h) => /tabs over spaces/i.test(h.entry?.content ?? '')));

  // recall tool
  const recallRes = await tools.get('recall').execute('t-recall', { query: 'build command', limit: 5 }, undefined, undefined, ctx);
  check('recall tool returns hits', !recallRes.isError && /build command/i.test(recallRes.content?.[0]?.text ?? ''), (recallRes.content?.[0]?.text ?? '').slice(0, 80));

  // reflect tool
  const reflectRes = await tools.get('reflect').execute('t-reflect', { query: 'how do I build' }, undefined, undefined, ctx);
  check('reflect tool assembles a context block', !reflectRes.isError && (reflectRes.content?.[0]?.text ?? '').length > 0);

  // auto-retain on turn_end (retainEveryTurns=1)
  branch = [
    { role: 'user', content: 'What is the build command?' },
    { role: 'assistant', content: 'Run npm run build.' },
  ];
  await handlers.get('turn_end')(null, ctx);
  const sessions = await api('GET', `/sessions?scope=${SCOPE}`);
  const mine = Array.isArray(sessions) ? sessions.find((s) => typeof s.title === 'string' && s.title.startsWith('omp ')) : undefined;
  check('auto-retain created an agentdox session', !!mine, mine?.id);
  if (mine) {
    const full = await api('GET', `/sessions/${mine.id}`);
    const texts = (full.messages ?? []).map((m) => m.content).join(' | ');
    check('auto-retain appended the conversation turn', /build command/i.test(texts) && /npm run build/i.test(texts), texts.slice(0, 120));
  } else {
    check('auto-retain appended the conversation turn', false, 'no session');
  }

  await api('DELETE', `/projects/${SCOPE}`).catch(() => {});

  const passed = results.filter(Boolean).length;
  console.log(`\n${passed}/${results.length} checks passed`);
  process.exit(passed === results.length ? 0 : 1);
}

main().catch((e) => {
  console.error('smoke error:', e instanceof Error ? e.message : e);
  console.error('Is the agentdox server running? `npm run dev:server` (auth off) on', URL);
  process.exit(1);
});
