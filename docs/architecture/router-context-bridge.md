# agentdox ↔ auto-model-router Context Bridge

**Status:** Implemented (v0.1)
**Scope:** Shared realtime context across model switches · prompt-cache economics · model-attributed transcripts
**Counterpart repo:** `E:/projects/omp-router` (`auto-model-router`), module `src/context/`

---

## 1. Why the router is the right integration point

`auto-model-router` presents itself as one keyless OpenAI-compatible provider and picks a
concrete OpenRouter model **per turn**, including mid-conversation. Every harness the user
runs — omp, Hermes, Claude Code — points at that single endpoint.

That makes the router the **only choke point that sees every model in every harness**.
Injecting agentdox context there gives every candidate model the same project memory, docs,
and brief, with no per-harness `.mcp.json` and no per-model setup. The alternative — wiring
agentdox into each harness separately — leaves the context behind the moment the router
switches models.

```
   omp ─┐
Hermes ─┼──▶ auto-model-router ──▶ [agentdox context injected] ──▶ any OpenRouter model
Claude ─┘            │
                     └──▶ agentdox sessions (turn recorded, attributed to the served model)
```

---

## 2. The constraint that shapes everything: the prompt cache

The naive design — fetch context and prepend it on every turn — is the one thing that would
wreck the router. The block sits at the **front of the prompt**, so changing it invalidates
the entire cached prefix after it. The router's cache-aware hysteresis
(`src/router/select.ts`, `src/router/cache-control.ts`) exists precisely to avoid that.
Per-turn injection would cost far more than routing saves.

So a block is **pinned per conversation** and re-fetched only when the prefix is already
being paid for:

| Refresh trigger | Cache cost | Where decided |
| --- | --- | --- |
| No pin yet (first turn) | none — nothing is warm | `bridge.shouldRefresh` |
| Router switches slug this turn | none — already forfeited | `state.currentSlug !== decision.slug` |
| Escalation / failover retry | none — new dispatch is cold | `attempt > 0` |
| Staleness TTL elapsed (default 900s) | paid once | `context.maxStalenessMs` |

Between those moments the **same bytes** are re-injected verbatim and the cache survives.
This is what makes "context refreshes as I switch models" cheap rather than ruinous: the
refresh rides on a cache miss that was happening anyway.

### 2.1 Version is a content hash, not a timestamp

agentdox's auto-context job re-assembles each scope on a timer
(`AGENTDOX_CONTEXT_INTERVAL_SECONDS`, 900s default; 60s in dev), so `assembledAt` changes
even when **nothing about the content did**. Keying the pin on that timestamp would break a
warm cache on every scheduler tick, for nothing.

The bridge therefore versions a block by `sha256(block).slice(0, 32)`. An unchanged
re-assembly hashes to the same version, returns identical bytes, and the cache holds. Only
a genuine content change — a new memory, an edited doc, a recorded decision — produces a
new version and a deliberate, one-time prefix invalidation.

### 2.2 Staleness is per-conversation

Two conversations may hold the same version. Staleness is measured from when **this
conversation** last refreshed (`conversations.context_fetched_at_ms`), not from the shared
block row — otherwise another conversation confirming the same content would silently
extend an unrelated TTL. The redundant re-check is cheap, and §2.1 means a confirming
refresh costs nothing at all.

---

## 3. Injection mechanics

The block is **appended to the last system/developer message**, never inserted as a new one.

Two reasons, both load-bearing:

1. `Decision.cacheBreakpointMessageIndices` are indices into the *client's own* message
   array. Inserting a message shifts every one of them.
2. `planCacheBreakpoints` already places breakpoint #1 at "end of the last system message",
   so appending lands the block **inside** the prefix that is already marked cacheable.

When a request carries no system message at all, one is prepended and the breakpoint indices
are shifted by one to compensate.

`conversationKey` is unaffected by design: `parseChatRequest` hashes the client's messages
**before** `renderUpstreamBody` runs, so a changing context block never re-keys a
conversation or orphans its hysteresis and cache-warmth state.

---

## 4. Write path — the model-attributed transcript

After each settled turn the bridge queues a write-back to agentdox sessions:

- one agentdox session per router `conversationKey` (`agentdox_sessions` table maps them);
- the user turn and the assistant response;
- `refs: ["model:<served-slug>", "tier:<tier>"]` on the assistant message.

That last line produces an artifact neither project had before: a transcript that records
**which model actually produced each turn**.

It also closes the loop. Those messages feed `ContextService.assemble`'s `sessionMessages`,
so the next model the router picks inherits what the previous model did. Verified live:

```
## Recent conversation
user:: does the bridge record which model served this turn?
assistant:: yes - refs carry model: and tier:.
```

Write-backs are queued, serialized per process, bounded (`context.maxQueue`, default 64),
and never awaited by the turn. agentdox is an **enrichment, not a dependency**: if it is
down, slow, or unauthorized, every client method returns null and the turn routes and
dispatches normally. A pinned block keeps being served when a refresh fails — stale shared
context beats none, and re-using it also keeps the prefix stable.

---

## 5. Scope resolution

A scope is an agentdox project slug. Resolution order, first match wins:

1. `X-Agentdox-Scope` request header — follows the existing `X-Omp-Harness` /
   `X-Omp-Session` convention.
2. `context.defaultScope` in the router config.
3. **Nothing** — the bridge stays inert. It never guesses, so one harness cannot leak
   context into another project.

The omp embed extension sets the header automatically, deriving the slug from the workspace
basename (`deriveAgentdoxScope`, handling both path separators) unless `defaultScope` pins
it explicitly.

---

## 6. Configuration

| Env var | Meaning |
| --- | --- |
| `AGENTDOX_URL` | agentdox REST base URL, e.g. `http://localhost:3003` |
| `AGENTDOX_TOKEN` | PAT with read+write on the project scope |
| `AGENTDOX_SCOPE` | default project slug when no header is sent |

Setting `AGENTDOX_URL` + `AGENTDOX_TOKEN` turns the bridge on; requiring a config-file flag
as well would make the common case (export two vars, restart) silently do nothing. Full
config lives under `context` in `RouterConfig` (`enabled`, `baseUrl`, `token`,
`defaultScope`, `timeoutMs`, `maxStalenessMs`, `maxBlockChars`, `recordTurns`, `maxQueue`).

`GET /health` on the router reports bridge provenance — URL, default scope, `recordTurns` —
and never the token.

---

## 7. Schema (router side, `user_version` 11)

```sql
-- Content-addressed, so many conversations on one project share one copy, and
-- a restart can re-inject the SAME bytes a conversation was already using.
CREATE TABLE context_blocks (
  version TEXT PRIMARY KEY, scope TEXT NOT NULL,
  block TEXT NOT NULL, fetched_at_ms INTEGER NOT NULL
);

CREATE TABLE agentdox_sessions (
  conversation_key TEXT PRIMARY KEY, scope TEXT NOT NULL,
  session_id TEXT NOT NULL, created_at_ms INTEGER NOT NULL
);

ALTER TABLE conversations ADD COLUMN context_version TEXT;
ALTER TABLE conversations ADD COLUMN context_fetched_at_ms INTEGER NOT NULL DEFAULT 0;
```

No agentdox schema change was required — model attribution rides on the existing
`SessionMessage.refs`.

---

## 8. Verification

- `test/context-bridge.test.ts` — 14 tests covering every refresh trigger, content-hash
  version stability, restart survival, agentdox-down degradation, write-back attribution,
  and both injection paths (append vs. prepend-and-shift).
- `tools/agentdox-e2e.ts` — live end-to-end against a running server: real HTTP client, real
  pin policy, real write-back, read back through the REST API. All checks pass.
- Full router suite: 406 pass, 0 fail; `tsc --noEmit` clean.

---

## 9. Deliberately not built

**An agentdox change feed (SSE).** agentdox has no push channel today (the SSE at
`packages/server/src/index.ts` is MCP transport only). A `GET /context/events?scope=`
emitting `{scope, version}` on writes would let a web-UI edit land mid-conversation.

It was skipped because turn boundaries are the natural granularity here, and §2.1 already
makes a poll-on-refresh nearly free. Add it only if sub-turn freshness turns out to matter —
the bridge's pin/version machinery would not need to change, only the trigger for marking a
pin dirty.
