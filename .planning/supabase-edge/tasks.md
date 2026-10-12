# Supabase Edge task list

Working checklist for [implementation-plan.md](implementation-plan.md). Tick items in the same commit that completes them. Hosted verification ([hosted-test-spec.md](hosted-test-spec.md)) is out of scope until requested separately.

**0. Spike / gate**: prove the risky assumptions before refactoring (investigation.md "Remaining engineering work" #1)
- [x] `supabase init` + a throwaway `powersync-write` function with `deno.json` + lock, pinning `pg` and `@supabase/server@1.9.2/middleware/required-claims`
- [x] `supabase start` + `functions serve`: verify a local ES256 token through `withRequiredClaims`, then run one pg transaction with `set_config('request.jwt.claims', …, true)` + `set local role authenticated`
- [x] `deno info` confirms the graph has no supabase-js client factories (or record what it pulls in)
- Gate: if any of these fail, stop and revisit the design with the user. **Passed 2026-10-12.**

Spike findings (CLI 2.98.2, edge-runtime 1.73.13 ≈ Deno 2.1.4; local Deno 2.7.14):
- `withRequiredClaims()` with no config verified a local ES256 user token using the auto-injected `SUPABASE_JWKS`. `withCors` needs an explicit config object (`withCors({})`). Gateway `verify_jwt` rejected a missing token with 401 before the function ran.
- In one pg transaction, `set_config('request.jwt.claims', …, true)` + `set local role authenticated` gave `auth.uid()` = user, `current_user` = authenticated. After COMMIT the pooled connection was back to `postgres` with empty claims.
- Runtime import graph of `required-claims` is local chunks + `jose` + `@supabase/middleware` only. `@supabase/server`/`postgres` references are doc comments. supabase-js **is resolved and downloaded** as a peer (shows in `deno info`) but is never imported. The phase 6 graph assertion must check imported modules, not resolved packages.
- Local `SUPABASE_DB_URL` uses host `supabase_db_<project>`. Its underscores make getaddrinfo fail inside the edge runtime (ENOTFOUND). The `db` alias works, so the connection-string override is required locally (`postgresql://postgres:postgres@db:5432/postgres`).
- An uncaught handler error yields a bare `500 Internal Server Error` with no CORS headers. The handler must catch everything itself.
- Under `supabase start`, function code is not hot-reloaded. Restart the edge container or use `supabase functions serve` while developing.

**1. Deno-compatible shared imports**
- [x] Switch shared modules from `.js` to `.ts` sibling imports; set `allowImportingTsExtensions` (or equivalent) in `backend/tsconfig.json`; `pnpm check` + `pnpm test` stay green
- [x] Split portable identity types out of `backend/src/auth/types.ts`; the Express augmentation stays Node-only (now `src/auth/express.d.ts`)

**2. Extract the transaction engine**
- [x] Runtime-independent factory pulled out of `backend/src/api/data.ts` (inject persister, authorizer, fatal handler, batch policy)
- [x] Express route becomes a thin wrapper; existing customization entry points are kept
- [x] `fatal-error-handler.ts`: Web Crypto `randomUUID`; callback scheduling is injected (Node fire-and-forget, Edge awaited). Done as `src/write/processor.ts` (`createTransactionProcessor`, `awaitDeadLetter` option) and `src/write/dead-letter.ts`; `fatal-error-handler.ts` re-exports the types and keeps the Node singleton

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

