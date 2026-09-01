# Multi-User & Domain-Scoped Access — Analysis + Best Practice

Status: **implemented** (see §12 for what shipped and how to migrate). Target: let clients log in and manage **only the domains assigned to them**, with a path to per-subdomain file uploads later.

---

## 1. Where the code stood before this change

(Kept as the record of what was wrong. All of it is fixed below unless marked otherwise.)

| Area | Current state | Verdict |
|---|---|---|
| `User.role` | `ADMIN \| USER` enum exists | present but **never enforced** — `requireRole()` in `backend/src/middleware/auth.ts:42` has zero callers |
| Registration | `POST /api/auth/register` is public (`backend/src/routes/auth.ts:12`) | anyone can self-serve an account today |
| Applications | every query filters `userId: req.user!.userId` | correctly scoped |
| Domains | scoped by `userId` | correctly scoped |
| Deployments / Logs / Databases / Git | filter by `userId` | scoped |
| `routes/cloudflare.ts` | **0 occurrences of `userId`** | any authenticated user hits the shared Cloudflare account |
| `routes/rdash.ts` | **0 occurrences of `userId`** | unscoped |
| `routes/metrics.ts` | 1 occurrence, mostly host-wide metrics | leaks host-level data to every user |
| `IntegrationConfig` | global table, no route guard | holds provider secrets — must be ADMIN-only |
| `Application` ↔ `Domain` | **no relation.** `Application.domain` is a free `String @unique` | a user can point an app at any hostname, incl. another client's domain |
| `GitAccount.accessToken` | stored plaintext | needs encryption at rest |
| S3 keys | `getStaticSitePrefix(applicationId)` — app-scoped, not tenant-scoped | usable, but no per-tenant isolation or quota |

**Two real holes, not stylistic:**

1. **No link between `Application.domain` and the `Domain` table.** Client A can create an app with `domain: "clientb.com"` and the platform will provision Caddy/DNS for it. This is the core requirement's security boundary and it does not exist.
2. **Ownership check repeated per-route by hand.** 13 hand-written `userId` filters in `applications.ts` alone. One forgotten filter = IDOR. `cloudflare.ts` and `rdash.ts` already prove the pattern fails.

---

## 2. Ownership model — pick the smallest one that holds

Three options, increasing cost:

**A. User owns resources directly (current shape).**
`Domain.userId` already exists. Add `Application.domainId`. Client = a `User` row with `role: CLIENT`.
→ zero new tables, one migration. **Recommended starting point.**

**B. Organization/Team layer.** `Organization` → `Membership(user, org, role)` → resources own `orgId`.
Needed only when one client is *multiple people* (agency staff, client + their developer).

**C. Full RBAC with permission strings.** Not needed. Skip.

**Decision: option B was built.** The requirement includes inviting several people per client, so the organization layer went in from the start rather than as a later migration. `Domain` and `Application` are owned by an `Organization`; `userId` is kept as the creator, for audit only.

### Schema delta (as implemented)

```prisma
enum UserRole {   // platform level
  ADMIN           // operator of CommitBase itself
  USER            // existing internal users — kept for back-compat
  CLIENT          // external customer
}

enum OrgRole {    // inside one organization
  OWNER
  ADMIN
  MEMBER
}

model Organization {
  id, name, slug @unique
  members      Membership[]
  domains      Domain[]
  applications Application[]
  invites      Invite[]
}

model Membership {
  role OrgRole @default(MEMBER)
  userId / organizationId
  @@unique([userId, organizationId])
}

model Invite {
  email, role OrgRole
  tokenHash String @unique   // sha256; the raw token is shown once, at creation
  expiresAt, acceptedAt
  organizationId, invitedById
}

model User {
  isActive    Boolean @default(true)   // disable an account without deleting data
  memberships Membership[]
}

model Domain {
  organizationId String?               // owner
  userId         String?               // creator, audit only (onDelete: SetNull)
  applications   Application[]
}

model Application {
  domain         String  @unique       // full FQDN, e.g. app.client.com
  domainId       String?               // parent domain — the ownership boundary
  organizationId String?               // inherited from the parent domain
  userId         String?               // creator, audit only
}
```

Backfill: `npm run db:backfill-orgs` (`src/scripts/backfillOrganizations.ts`) gives every existing user a personal org, moves their domains and apps into it, and links each app to its parent `Domain` row by hostname suffix. Idempotent. It prints any app whose hostname matches no `Domain` row — create those domains and re-run, or their owners cannot edit them.

Invariant to enforce on app create/update:

```ts
// the FQDN must be a domain the caller organization owns, or a subdomain of one
const parent = await prisma.domain.findFirst({
  where: { ...(await orgScope(req)), name: { in: candidateParents(fqdn) } },
});
if (!parent) return res.status(403).json({ success: false, error: 'Domain not assigned to you' });

// candidateParents("api.staging.client.com")
//   -> ["api.staging.client.com", "staging.client.com", "client.com"]
function candidateParents(fqdn: string) {
  const parts = fqdn.toLowerCase().split('.');
  return parts.map((_, i) => parts.slice(i).join('.')).filter(d => d.includes('.'));
}
```

This single check is what actually implements the brief. Everything else is plumbing.

---

## 3. Authorization — one choke point, not 13 filters

Do **not** keep hand-writing `userId: req.user!.userId`. Add one helper, use it everywhere:

```ts
// backend/src/lib/scope.ts
/** Platform ADMIN sees everything; everyone else sees only rows owned by their orgs. */
export async function orgScope(req: AuthenticatedRequest) {
  if (isPlatformAdmin(req)) return {};
  return { organizationId: { in: await getOrgIds(req) } };
}
```

```ts
const domains = await prisma.domain.findMany({ where: { ...(await orgScope(req)) } });
```

Memberships load once per request and are memoized on `req`. They are deliberately **not** put in the JWT: a claim goes stale the moment a membership changes, one query does not.

Companion helpers in the same file: `orgScopeVia()` for models that reach an org through `application`, `logScope()` (a member sees their own log lines plus everything logged against apps in their orgs), `getOrgRole()` / `canManageOrg()` for org-level permission checks, and `resolveOwnedDomain()` for the hostname boundary.

Why this and not Prisma middleware / RLS:

- **Prisma client extensions (`$extends`)** can auto-inject the filter, but need request context threading (AsyncLocalStorage). Real, worth it once there are >30 routes. Not yet.
- **Postgres Row-Level Security** is the strongest option — the DB enforces it even if app code forgets — but requires per-request `SET LOCAL app.user_id` and a connection-pooling story. Correct long-term destination for a platform holding customer data; overkill for the current route count.

Rule: `orgScope(req)` now, RLS when a breach of customer data would matter legally.

### Route guards

```ts
// backend/src/index.ts — admin-only, these touch shared infra or provider secrets
app.use('/api/rdash',      authenticateToken, requireRole(['ADMIN']), rdashRoutes);
app.use('/api/cloudflare', authenticateToken, requireRole(['ADMIN']), cloudflareRoutes);
app.use('/api/admin',      authenticateToken, requireRole(['ADMIN']), adminRoutes);
```

`GET /api/metrics/system` and `POST /api/metrics` carry the same guard inline, because `GET /api/metrics/application/:appId` on the same router stays open to the owning org. Domain create and delete are guarded the same way in `routes/domains.ts`.

Per-app metrics for clients: expose a separate `/api/applications/:id/metrics` that resolves the app through `ownerScope` first. Don't loosen the host-wide endpoint.

### Registration

`POST /api/auth/register` now only bootstraps the very first account: it returns 403 once any user exists, and the account it creates is platform `ADMIN` with a default organization it owns.

Every later account arrives one of two ways:

1. an org OWNER/ADMIN invites an email — `POST /api/organizations/:id/invites` — and the invitee sets a password at `POST /api/auth/accept-invite`;
2. a platform admin creates it directly with a temporary password — `POST /api/admin/users`.

Email delivery is not wired up: the invite link comes back in the API response and is copied out of the Team page. `APP_URL` in the backend env turns it into a full URL. A disabled account (`isActive: false`) is refused at login and at `/auth/validate`.

---

## 4. Organizations, invites, and domain assignment

**Platform admin** (`/api/admin`, plus `POST /api/organizations`):

```
GET    /api/admin/users                               # users + their memberships
POST   /api/admin/users                               # create an account
PUT    /api/admin/users/:id                           # enable/disable, change platform role
GET    /api/admin/domains                             # every domain + owning org
POST   /api/admin/domains/:id/assign  { organizationId }
DELETE /api/admin/domains/:id/assign                  # detach from any org
POST   /api/organizations             { name, slug? }  # creator becomes OWNER
```

**Org OWNER/ADMIN** (or platform admin) — the invite-user-to-organization flow:

```
GET    /api/organizations                             # orgs you belong to, with myRole
GET    /api/organizations/:id/members
PUT    /api/organizations/:id/members/:userId  { role }
DELETE /api/organizations/:id/members/:userId
GET    /api/organizations/:id/invites
POST   /api/organizations/:id/invites  { email, role? }    # returns the raw token ONCE
DELETE /api/organizations/:id/invites/:inviteId
POST   /api/auth/accept-invite  { token, name?, password? }  # public
```

Invite rules that are not optional:

- the token is 32 random bytes, stored only as a **sha256 hash** — a DB read cannot recover a live invite link;
- 7-day expiry, single use (`acceptedAt`), and reissuing an invite deletes the previous unaccepted one;
- accepting creates the account when the email is new (`password` required) or just adds the membership when it already exists;
- an org can never lose its last `OWNER` — both the role-change and remove-member paths refuse it.

> **Policy:** reassigning a domain also reassigns the applications under it. `Application.organizationId` is updated in the same transaction as `Domain.organizationId`.

```ts
await prisma.$transaction([
  prisma.domain.update({ where: { id }, data: { organizationId } }),
  prisma.application.updateMany({ where: { domainId: id }, data: { organizationId } }),
]);
```

Without the transaction you get half-moved state and a client still seeing an app they no longer own.

---

## 5. Frontend

`frontend/src/pages/` is flat with no role gating. Minimum work:

Shipped:

- `isAdmin()` in `frontend/src/lib/auth.ts` reads the role out of the JWT.
- `AdminRoute` in `App.tsx` guards `/admin` and `/integrations/*`; the sidebar hides both for non-admins.
- `pages/Team.tsx` — org switcher, member roster with role editing, invite form that surfaces the one-time link.
- `pages/Admin.tsx` — domain-to-organization assignment, org creation, user list with an enable/disable switch.
- `pages/AcceptInvite.tsx` — public `/accept-invite?token=...`.
- `pages/Domains.tsx` — the Add Domain dialog now requires an owning organization and is admin-only.
- `pages/AddApp.tsx` already picked the parent domain from a `<select>` fed by `/api/domains`, which is now org-scoped — no change needed.

**Hiding is UX, not security.** Everything hidden is also blocked server-side by `requireRole` or `orgScope`.

---

## 6. Future: per-subdomain file uploads

Design the key layout now so you don't migrate objects later:

```
tenants/{organizationId}/domains/{domainId}/apps/{applicationId}/...
```

Current `getStaticSitePrefix(applicationId)` is app-scoped only. Prefixing with `{organizationId}` gives you for free:

- per-tenant usage accounting (`ListObjectsV2` on the prefix),
- clean deletion when a client leaves,
- ability to hand out **scoped credentials or presigned URLs** limited to one prefix.

Upload rules — do not simplify these away:

- **Presigned PUT, short TTL** (≤5 min), generated only after `ownerScope` resolves the app. Never proxy large uploads through the API.
- **Reject `..`, absolute paths, and backslashes** in client-supplied relative paths before building the key. Path traversal in an object key is a real cross-tenant read/write.
- **Cap size and file count** per request and per tenant; enforce `Content-Length` in the presign conditions, not just client-side.
- **Force `Content-Type`** from a server-side allowlist by extension. Never trust the client's header — an uploaded `.html` served from your domain is stored XSS.
- **Serve user content from a separate domain** (e.g. `*.cdn.yourplatform.com`), never the control-plane origin, so uploaded HTML/JS can't reach the dashboard's cookies/localStorage.
- Log every upload to the existing `Log` model with `userId` + `applicationId`.

---

## 7. Audit trail

`Log` already has `userId`, `applicationId`, `metadata Json`. Reuse it — no new table. Write an entry for: login, failed login, domain assigned/unassigned, app created/deleted, deployment triggered, env var changed, file uploaded/deleted. Never log secret values — only the key name and `changed: true`.

---

## 8. Secrets

- `GitAccount.accessToken` — plaintext today. Encrypt with AES-256-GCM using a key from env, or move to a secrets manager. A DB dump currently equals full repo access for every client.
- `Application.envVars Json` — same exposure. Encrypt, or at minimum never return values in list endpoints: return `{ key, hasValue: true }` and require an explicit reveal call that gets audit-logged.
- `IntegrationConfig.value` — provider credentials. ADMIN-only, encrypted, never serialized into any client-facing response.

---

## 9. Implementation order

**Phase 1 — close the holes.** DONE
1. `requireRole(['ADMIN'])` on `cloudflare`, `rdash`, host `metrics`, domain create/delete.
2. Public registration closed — `/api/auth/register` now only bootstraps the very first account, which becomes platform ADMIN and gets a default org.
3. `orgScope()` replaced every hand-written `userId` filter across applications, deployments, logs, databases, domains, metrics.

**Phase 2 — the feature.** DONE
4. Schema: `Organization`, `Membership`, `Invite`, `OrgRole`, `CLIENT` role, `User.isActive`, `Application.domainId` + `organizationId`, `Domain.organizationId`.
5. Subdomain-ownership check on app create/update (`resolveOwnedDomain`).
6. Admin domain-assignment endpoints with the transaction; org CRUD; member and invite management.
7. Frontend: Team, Admin and AcceptInvite pages; role-gated routes and nav.

**Phase 3 — hardening / later.** NOT STARTED
8. Encrypt `GitAccount.accessToken` / `Application.envVars`.
9. Audit-log entries into the existing `Log` model.
10. Org-prefixed S3 keys + presigned uploads.
11. Postgres RLS.
12. Email delivery for invites — today the link is copied out of the UI.

---

## 10. Verification — the one test that matters

Before shipping Phase 2, run an IDOR sweep with two client accounts, A and B:

```
For every route: authenticate as A, pass B's resource id.
Expected: 403 or 404 on every single one. Never 200.
```

Specifically:

- `GET /api/applications/{B_app_id}` → 404
- `POST /api/applications` with `domain: "b-client.com"` as A → 403
- `PUT /api/domains/{B_domain_id}` → 404
- `GET /api/cloudflare/*` as any CLIENT → 403
- `GET /api/deployments/{B_deployment_id}/logs` → 404
- `GET /api/organizations/{B_org_id}/members` as A → 403
- `POST /api/organizations/{B_org_id}/invites` as A → 403
- `POST /api/auth/accept-invite` with a used, revoked, or expired token → 400

The hostname-suffix logic behind the boundary has its own self-check: `npx tsx src/scripts/checkScope.ts`, covering the `evil-client.com` and `clientXcom` lookalike bypasses.

Cheap way to keep it honest: one script that enumerates the route table and asserts non-200 for cross-tenant ids. Failing that test is the only definition of "the feature isn't done".

---

## 11. Open decisions for you

1. ~~One client = one login, or multiple people per client?~~ **Resolved: multiple.** Organizations plus invites are implemented.
2. **Can a client add their own domains, or admin-only assignment?** Currently admin-only — domain add triggers real Cloudflare zone creation and costs money. Self-serve would need a DNS TXT verification step before provisioning.
3. **Do clients see host-level metrics/logs?** No. `GET /api/metrics/system` is admin-only; per-app metrics stay open to the owning org.

---

## 12. Running the migration

```bash
cd backend
npm run db:push          # or: npx prisma db push
npm run db:backfill-orgs # personal org per user, moves domains + apps, links app -> parent domain
npx tsx src/scripts/checkScope.ts   # hostname boundary self-check
```

Then, as platform admin: create an organization per client, assign their domains to it on `/admin`, and invite their people from `/team`. Set `APP_URL` in the backend env so invite links come back as full URLs.

Breaking API changes for any existing consumer of this API:

- `POST /api/domains` now requires `organizationId` and is admin-only.
- `POST /api/auth/register` returns 403 once any user exists.
- `/api/cloudflare/*`, `/api/rdash/*`, `GET /api/metrics/system` and `POST /api/metrics` are admin-only.
- Creating an application on a hostname that is not under one of your organization domains returns 403.
