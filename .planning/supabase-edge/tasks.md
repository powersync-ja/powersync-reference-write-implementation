# Supabase Edge task list

Working checklist for [implementation-plan.md](implementation-plan.md). Tick items in the same commit that completes them. Hosted verification ([hosted-test-spec.md](hosted-test-spec.md)) is out of scope until requested separately.

**0. Spike / gate**: prove the risky assumptions before refactoring (investigation.md "Remaining engineering work" #1)
- [ ] `supabase init` + a throwaway `powersync-write` function with `deno.json` + lock, pinning `pg` and `@supabase/server@1.9.2/middleware/required-claims`
- [ ] `supabase start` + `functions serve`: verify a local ES256 token through `withRequiredClaims`, then run one pg transaction with `set_config('request.jwt.claims', …, true)` + `set local role authenticated`
- [ ] `deno info` confirms the graph has no supabase-js client factories (or record what it pulls in)
- Gate: if any of these fail, stop and revisit the design with the user

**1. Deno-compatible shared imports**
- [ ] Switch shared modules from `.js` to `.ts` sibling imports; set `allowImportingTsExtensions` (or equivalent) in `backend/tsconfig.json`; `pnpm check` + `pnpm test` stay green
- [ ] Split portable identity types out of `backend/src/auth/types.ts`; the Express augmentation stays Node-only

**2. Extract the transaction engine**
- [ ] Runtime-independent factory pulled out of `backend/src/api/data.ts` (inject persister, authorizer, fatal handler, batch policy)
- [ ] Express route becomes a thin wrapper; existing customization entry points are kept
- [ ] `fatal-error-handler.ts`: Web Crypto `randomUUID`; callback scheduling is injected (Node fire-and-forget, Edge awaited)

**3. Postgres adapter hardening** (Node defaults unchanged)
- [ ] Pass the full connection string through (TLS/query options, decoded credentials)
- [ ] Optional pool, acquire, and statement timeouts; optional transaction-init hook
- [ ] Discard the client when rollback fails; map 42501 to an authorization failure (`postgres-errors.test.ts`)
- [ ] Optional cleanup seam for tests

**4. Edge validator**
- [ ] Pick and lock a standalone validator generator; generate it from `powersync-reference-write-api.openapi.yaml` and commit the output
- [ ] Parity test against the Node/Express validator

**5. Compose `supabase/functions/powersync-write`**
- [ ] Routing for `/powersync-write/api/data`, CORS + preflight, required-claims config (issuer, audience, sub, exp, role)
- [ ] Transaction init: verified claims + fixed `authenticated` role, both transaction-local
- [ ] Local editable mapper / authorizer / fatal-hook modules

**6. Local acceptance** (implementation-plan.md "Local acceptance")
- [ ] Deno check + dependency-graph assertion (no mongo/mysql/mssql/express/dotenv/winston)
- [ ] Local Supabase integration tests: CRUD, two-user RLS, pooled identity cleanup, rollback, stop/skip, validation, awaited callbacks
- [ ] Auth negative cases + RS256 isolated verifier test
- [ ] Connector compatibility with only the URL changed; deployment needs no backend install
- [ ] README/docs for the Supabase example

