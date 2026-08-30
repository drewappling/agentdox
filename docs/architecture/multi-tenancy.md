# agentdox Multi-Tenancy & SaaS UX Architecture

**Status:** Design (v0.1)
**Scope:** Domain model · REST API · Web UI flow · RBAC
**Amends:** `authentication.md` §1 (multi-tenant SaaS moves from non-goal → goal)

---

## 1. UX Review — Current State Problems

The current web UI (`packages/web`) is a flat, single-scope app:

```
[agentdox] [project dropdown ▾]  Projects Memory Docs Sessions Context        [sign out]
```

Problems that block a multi-tenant SaaS:

1. **No tenant concept anywhere.** `Project.slug` *is* the scope namespace; there is no
   organization layer above it. Two customers could claim the same slug; there is nothing
   to hang membership, billing, or quotas on.
2. **"all scopes" is the default landing mode.** The header dropdown defaults to showing
   *every* project the principal can see, mixed together. In a multi-tenant product this is
   a data-leak-shaped footgun, not a convenience.
3. **Memory is not actually scoped to projects.** `MemoryEntry` has no `scope` field;
   `Memory.svelte` silently stuffs the project slug into `category` — which corrupts the
   semantic meaning of category and breaks the moment two projects use the same category
   names. Docs and Sessions *do* have `scope`; Memory must too.
4. **No onboarding.** A new user logs in and lands on an empty Memory list with no
   project selected, no guidance, and no path to "connect your first agent."
5. **Admin surface is missing.** PATs (`/auth/tokens`) exist in the API but have no UI.
   Membership, usage, and project provisioning tokens are invisible to humans.
6. **Hash routes are not deep-linkable per project.** `#/memory` carries no tenant/project
   identity, so views can't be shared, bookmarked, or restored — and stale state survives
   project switches.
7. **Project switching doesn't navigate.** Changing the header dropdown leaves the user on
   the same view with ambiguous mixed state (e.g. Context view's `scope` field).

---

## 2. Target UX Flow

### 2.1 Hierarchy

```
Tenant (organization)          ← billing, membership, plan, quotas live here
  └── Project (= scope namespace)  ← memory, docs, sessions, context live here
```

### 2.2 The flow

```
login (PKCE)
   │
   ▼
┌─────────────────────┐   1 tenant  ┌──────────────────────────────┐
│  tenant gate        │ ──────────► │  project home (dashboard)    │
│  · pick tenant      │   >1 tenant │  brief · stats · activity    │
│  · or create org    │ ──────────► │  tenant picker screen        │
└─────────────────────┘   0 tenants └──────────────────────────────┘
                                   │
                                   ▼
                          ┌──────────────────────┐
                          │  onboarding wizard   │
                          │  create org → create │
                          │  first project →     │
                          │  copy agent token +  │
                          │  MCP config snippet  │
                          └──────────────────────┘
```

### 2.3 App shell (after selection)

```
┌────────────────────────────────────────────────────────────┐
│ ◤ acme-corp ▾      acme-corp / app             ⌕   ⓧ user ▾│  ← breadcrumb, not dropdown
├──────────┬─────────────────────────────────────────────────┤
│ PROJECTS │                                                 │
│  app     │   (project home / memory / docs / sessions /    │
│  demo    │    context renders here)                        │
│  + new   │                                                 │
│          │                                                 │
│ app      │                                                 │
│  Overview│                                                 │
│  Memory  │                                                 │
│  Docs    │                                                 │
│  Sessions│                                                 │
│  Context │                                                 │
│          │                                                 │
│ TENANT   │                                                 │
│  Members │                                                 │
│  Tokens  │                                                 │
│  Usage   │                                                 │
└──────────┴─────────────────────────────────────────────────┘
```

Rules:

- **Tenant switcher** lives at the top-left; switching tenant resets project context.
  Switching project *navigates* to the equivalent route under the new project.
- **No more global "all scopes" default.** An explicit *All projects* aggregate view may
  exist **within one tenant only**. Cross-tenant data is never mixed in any view.
- **Deep-linkable routes:** `#/t/:tenant/p/:project/memory`, `#/t/:tenant/p/:project/docs/:slug`,
  `#/t/:tenant/members`. Views derive their scope from the URL, not from mutable localStorage.
- **Project home** (Overview) is the landing view per project: the `ProjectBrief`,
  memory/doc/session counts, last context snapshot, recent decisions. Not an empty form.
- **First-class admin UI:** Members (invite by email, tenant role, per-project overrides)
  and Tokens (create/list/revoke PATs with per-project grants) — these APIs already exist
  or are trivial extensions of `/auth/tokens`.
- **Destructive actions** (delete project, remove member, revoke token) require typed
  confirmation of the slug/name.

---

## 3. Domain Model Changes

```ts
/** A customer organization. The tenancy, billing, and membership boundary. */
export interface Tenant {
  id: string;
  /** URL-ish, globally unique, immutable. */
  slug: string;
  name: string;
  /** SaaS plan tier; 'selfhosted' when not running as SaaS. */
  plan: 'free' | 'team' | 'enterprise' | 'selfhosted';
  createdAt: string;
}

/** Membership of a principal in a tenant. */
export interface TenantMembership {
  tenantId: string;
  sub: string;                    // Principal.sub
  /** Tenant-level role. owner ⊃ admin ⊃ member ⊃ viewer. */
  tenantRole: 'owner' | 'admin' | 'member' | 'viewer';
  createdAt: string;
}

export interface Project {
  // ...existing fields...
  /** Owning tenant. Projects are unique per (tenantId, slug). */
  tenantId: string;
}

export interface MemoryEntry {
  // ...existing fields...
  /** Project scope this entry belongs to. REQUIRED going forward —
      stops the current abuse of `category` as a scope carrier. */
  scope?: string;
}
```

**Scope naming.** Keep `scope` as the authorization unit, but make it canonical:
`{tenantSlug}/{projectSlug}` (e.g. `acme-corp/app`). This is already compatible with
the existing `grants: Record<string, Role>` map and the wildcard `*` — a tenant admin grant
is simply `acme-corp/*: admin` (prefix match added to the RBAC resolver). Existing
single-tenant installs keep bare slugs, which parse as the implicit `local` tenant.

---

## 4. RBAC: Two Layers

```
tenant role:   owner  ⊃  admin  ⊃  member  ⊃  viewer
project role:  admin  ⊃  write  ⊃  read    ⊃  none      (existing)
```

**Effective project role** = `max(explicit project grant, role derived from tenant role)`:

| Tenant role | Derived project role              |
|-------------|-----------------------------------|
| owner/admin | `admin` on every project in tenant|
| member      | `write`                           |
| viewer      | `read`                            |

Explicit per-project grants (existing `acls` table / `grants` map) can raise but, for v1,
not lower the tenant-derived role. Enforcement stays in the single middleware — it gains
tenant resolution (`scope → project → tenantId → membership check`) before the existing
role check, so REST and future MCP-HTTP never drift.

**Isolation invariant:** every storage query joins through project → tenant and filters by
the caller's tenant set. There is no code path that lists scopes across tenants.

---

## 5. REST API Additions

```
# Tenants
GET    /tenants                              # tenants the caller belongs to
POST   /tenants                              # create org (caller becomes owner)
GET    /tenants/:slug                        # tenant detail (member+)
PATCH  /tenants/:slug                        # rename etc. (admin+)

# Membership
GET    /tenants/:slug/members
POST   /tenants/:slug/members                # invite by email/sub (admin+)
PATCH  /tenants/:slug/members/:sub           # change tenant role (admin+)
DELETE /tenants/:slug/members/:sub           # remove (admin+; owner removable only by owner)

# Projects, nested (existing /projects stays as a compat alias scoped to caller's tenants)
GET    /tenants/:slug/projects
POST   /tenants/:slug/projects
GET    /tenants/:slug/projects/:proj
DELETE /tenants/:slug/projects/:proj

# Tokens — extend existing /auth/tokens with a tenant filter + project-grant picker
GET    /tenants/:slug/usage                  # v1.1: entry counts, storage, API calls
```

All existing scope-keyed endpoints (`/memory`, `/docs`, `/sessions`, `/context/*`) accept
canonical `tenant/project` scopes; the guard resolves them through the tenant layer.

---

## 6. Storage

- **SaaS (pool model):** shared Postgres, `tenant_id` on `projects` (and denormalized onto
  `memory`/`docs`/`sessions` for cheap enforcement + composite indexes on
  `(tenant_id, scope)`). Unique index `projects(tenant_id, slug)`.
- **Self-hosted:** SQLite keeps working; a single implicit `local` tenant is seeded so the
  code paths are identical and auth-disabled mode is unchanged.
- Migration: backfill existing rows into the `local` tenant; backfill `MemoryEntry.scope`
  from `category` where it matches a known project slug.

---

## 7. Phasing

**Phase 1 — model & shell**
`Tenant`/`TenantMembership` types + tables, canonical scope parsing, tenant switcher,
nested project routes, deep-linkable hash routing, `scope` field on memory.

**Phase 2 — SaaS UX**
Tenant gate + onboarding wizard, project Overview home, Members UI, Tokens UI,
typed-confirmation deletes, removal of cross-tenant "all scopes".

**Phase 3 — SaaS operations**
Plans/quotas (`usage` endpoint, per-tenant entry/storage limits), audit log, Stripe hooks,
IdP group→tenant-role sync.

---

## 8. Open Questions

- Can explicit per-project grants *lower* a tenant-derived role (needed for "contractor
  sees only one project")? Current recommendation: no for v1 — instead allow a membership
  flag `projectRestricted: true` that limits a member to explicit grants only.
- Tenant slug immutability vs. rename (rename breaks canonical scopes in stored grants —
  recommend immutable slugs, mutable display names).
- Per-tenant data residency (separate DB per enterprise tenant) — pool model first,
  silo option later behind the same repository interface.
