# Supabase Edge investigation and handoff

Investigation date: 2026-10-12. Read [implementation-plan.md](implementation-plan.md) for the agreed design and [hosted-test-spec.md](hosted-test-spec.md) for deferred hosted verification.

## Resume here

The user requested investigation and planning, then asked to save the context before moving to a new conversation. Only planning documents have been written. No application code, dependencies, Supabase configuration, databases, or deployments were changed. No implementation tests or runtime compatibility probes were run. No commit was made.

The primary motivation was making this write backend usable inside a Supabase Edge Function without pulling in unrelated database code. Exploration showed that published packages are not necessary: a narrow import graph and shared source modules satisfy the selected adoption model.

The next implementation step, when requested, is to prove strict Deno resolution of the selected shared modules and pinned dependencies, then extract the transaction engine and wire both runtimes to it. Local Supabase integration is the completion gate. Hosted verification is expressly deferred to a written test specification.

## User decisions

These were settled through the requested grill-me interview. Do not reopen them just because a new context starts.

| Topic | Decision |
| --- | --- |
| Edge database | Supabase Postgres first; other adapters remain supported in Node. |
| Distribution | Clone-and-deploy example in this repository, not published packages. |
| Refactor size | Extract the shared functionality needed for Supabase; defer a full workspace/package split. |
| Compatibility | Preserve the Node/Docker backend and existing client upload protocol. |
| Authentication | Same-project Supabase Auth, using Supabase's verification helpers rather than the generic PowerSync export loader. |
| Signing keys | Modern asymmetric project keys. The user questioned whether they must manage keys; clarification was that discovery is automatic, with no copied keys or JWT secret. |
| Authorization | Existing Supabase RLS via auth.uid()/auth.jwt(), plus an available application authorization hook. |
| Table scope | RLS and database grants only; no mandatory table allowlist. |
| Database writes | Keep direct SQL and multi-operation database transactions, not PostgREST RPC. |
| Zero affected rows | PATCH/DELETE remain successful no-ops, including rows invisible through RLS. |
| Database login | Use the existing connection and fixed transaction-local authenticated role; do not require a dedicated production login role. |
| Deployment workflow | Direct source deployment with Supabase/Deno tooling, without installing/building the Node backend. |
| Customization | Editable local mapper, authorizer, and fatal-error hook modules. |
| Dead-letter callbacks | Await callbacks in Edge; callback errors remain logged without changing transaction outcomes. |
| Acceptance | Local integration tests; separately document hosted tests for later. |
| Workload | Ordinary interactive uploads using the current batching/retry contract; no large-import or exactly-once infrastructure. |

The developer-tool choice, source layout, generated validator, and specific helper import in the implementation plan are engineering recommendations supporting these decisions, not individually dictated user requirements.

## Repository map and coupling

- `backend/src/api/data.ts` contains both Express routing and the reusable transaction algorithm. It imports configuration, the global persister selector, and singleton application hooks. Extract the algorithm and inject these dependencies.
- `backend/src/persistence/persister.ts` lazily creates a configured persister, but imports `persister-factories.ts`, which statically imports MongoDB, MySQL, Postgres, and MSSQL. Lazy initialization does not isolate the module graph.
- `backend/src/types.ts` defines `Persister.updateBatch(batch, auth)` and derives wire types from generated OpenAPI types. This is an existing useful boundary, not a greenfield interface.
- `backend/src/auth/types.ts` mixes portable identity interfaces with Express request augmentation. Keep the Express augmentation out of shared runtime contracts.
- `backend/src/auth/verifier.ts` reads a PowerSync export through `node:fs/promises`; its environment helper defaults to `process.env`. These are Node composition concerns. The lower-level verifier uses jose, but the Supabase example does not need the generic resolver/configuration machinery.
- `backend/app.ts` loads the OpenAPI YAML from disk using Express middleware. An edge handler needs runtime validation without this filesystem/framework path. Keep one contract source and check validator parity.
- `backend/src/fatal-error-handler.ts` uses `node:crypto.randomUUID` and deliberately does not await callback promises. Shared code can use Web Crypto or injection; scheduling must remain runtime-specific.
- `backend/src/mapping/index.ts` also re-exports Mongo mapping. Prefer narrow imports over broad barrels that can reintroduce unrelated implementations.
- `backend/config.ts` imports dotenv. `backend/src/middleware/logger.ts` imports Winston. Neither belongs in the function's dependency graph.
- Docker's build context is `./backend`. Keeping shared source under that tree avoids an unnecessary Docker/workspace restructure.

## Existing behavior to preserve

- `POST /api/data` accepts 1–50 transactions, processes them in order, and uses a separate database transaction for each.
- Results are `success`, `retryable_error`, `fatal_error`, or `not_attempted`; processed batches return HTTP 200. Authentication and request failures use HTTP errors.
- Default fatal policy is stop. Skip mode continues only after backend-directed fatal errors. Client-directed fatal errors and retryable errors stop the batch.
- A transaction may contain zero operations. The current contract does not impose a per-transaction operation-count maximum. Do not silently split transactions.
- The default fatal handler routes failures to the backend, and the default dead-letter handler logs them. This does not provide durable rejected-write storage.
- `EntryMapper` transforms one operation or returns null to skip it. Authorization receives the original transaction and verified identity; existing-row checks belong inside the database transaction or RLS.
- Both example connectors append `/api/data` to their configured backend base URL. Their default request timeout is 30 seconds. Network/non-2xx failures retain work for retry; this is not an exactly-once protocol.
- Current Postgres authorization sets transaction-local `app.user_id`. Keep that Node default; the Edge composition needs Supabase claims and role semantics instead.

## Postgres findings

The current adapter checks out one pg client, begins a transaction, executes sequential unnamed parameterized statements, and commits or rolls back. This is a suitable starting shape for transaction pooling. Official [Supabase driver documentation](https://github.com/supabase/server/blob/main/docs/postgres.md#runtime-support) and [Deno's PostgreSQL example](https://docs.deno.com/examples/connecting_to_databases_tutorial/) support pg usage; the actual pinned edge combination has not yet been exercised.

Concrete adapter gaps found by inspection:

- Manual URL splitting discards connection-string query options, including TLS settings; credentials also need correct decoding.
- Pool limits, acquisition deadlines, and statement deadlines are not exposed.
- Rollback failure is swallowed, followed by unconditional release. Discard unusable clients rather than returning them to the pool.
- The current error classifier maps all SQLSTATE class 42 errors to schema mismatch. Handle permission code 42501 specifically as authorization failure.
- The persister interface has no lifecycle method. If tests need cleanup, provide an explicit adapter/pool cleanup seam without forcing unrelated adapters to change.

Use the [transaction pooler guidance](https://supabase.com/docs/guides/database/connecting-to-postgres) for hosted serverless connections. Bound each worker's own pool as well; remote pooling does not remove per-worker connection growth. Preserve TLS verification and test the real endpoint later.

Do not switch to Postgres.js merely because examples use it. The investigation found a [documented pipelining caveat](https://supabase.com/docs/guides/database/postgres-js), and preserving pg avoids an unnecessary driver rewrite.

## Authentication findings and caveats

There is no automatically injected, trusted user context in the function request. Supabase's SDK verifies the token and constructs that context. The gateway check alone is insufficient to establish an end-user identity: current [authorization-header documentation](https://supabase.com/docs/guides/functions/auth-headers) also documents API-key compatibility paths.

The investigation inspected published npm metadata and the 1.9.2 tarball, not only repository main:

- `@supabase/server@1.9.2/core` exports `verifyAuth`, but its runtime entry also imports client factories and therefore supabase-js.
- `@supabase/server@1.9.2/middleware/required-claims` exports `withRequiredClaims`. Its inspected runtime path imports auth/error helpers, jose, and `@supabase/middleware`, without the client factories. The plan selects this narrower entry.
- The package has a supabase-js peer dependency. Distinguish package resolution/downloads from the runtime graph; verify actual Deno behavior instead of promising that an export alone excludes every peer.
- Required-claims supports issuer/audience/JWKS configuration and returns verified `ctx.jwtClaims`. It needs an outer CORS/preflight layer. See [published metadata](https://registry.npmjs.org/@supabase/server/1.9.2) and [middleware source](https://github.com/supabase/server/blob/main/src/middleware/required-claims/index.ts).

The inspected SDK verifier requires a string subject but does not itself impose our fixed authenticated role or all desired required-claim checks. Enforce nonempty subject, required valid expiry, expected issuer/audience, and the selected user-role boundary. Do not assume TypeScript claims types establish runtime validity. See [verification source](https://github.com/supabase/server/blob/main/src/core/verify-user-jwt.ts).

Use automatically available JWKS configuration, with a derived project JWKS URL where necessary. Distinguish the expected public token issuer from a Docker-internal URL used to fetch keys locally. Do not derive trust settings from unverified request claims.

Current function auth/error docs and the pinned CLI source support asymmetric gateway verification, while the signing-key migration documentation still contained contrary advice. Keep `verify_jwt = true` as planned, test locally, and record hosted verification as outstanding rather than silently disabling the gateway. Sources: [auth errors](https://supabase.com/docs/guides/functions/error-codes), [CLI 2.98.2 gateway source](https://github.com/supabase/cli/blob/v2.98.2/internal/functions/serve/templates/main.ts).

For RLS, pass only verified claims into transaction-local `request.jwt.claims` and switch to the fixed `authenticated` role. Never interpolate a caller-selected role. Do not replace our persister with Supabase's query middleware: its documented transaction boundary is per query, whereas ours must encompass all operations in a submitted transaction.

## Deno, validation, and deployment

- Installed tooling during investigation: Deno 2.7.14 and Supabase CLI 2.98.2. No `supabase/config.toml` existed.
- Existing backend TypeScript uses sibling `.js` imports but `noEmit`. Strict Deno cannot simply resolve them to `.ts`. Normalize shared imports and adjust the backend compiler configuration; do not depend on unstable sloppy-imports.
- Keep a function-specific deno.json and lockfile. Ensure it resolves dependencies independently of backend/node_modules. See [Supabase dependencies](https://supabase.com/docs/guides/functions/dependencies) and [Deno module resolution](https://docs.deno.com/runtime/fundamentals/modules/).
- Generate a checked-in standalone ESM validator at maintenance time. Avoid runtime code generation or filesystem-based OpenAPI loading in Edge. Match actual contract behavior, including optional fields and allowed extra properties, and verify parity against the Node boundary.
- CLI help exposes neither `supabase functions bundle` nor `deploy --dry-run`; do not invent those checks. Use deno check, deno info, and supabase functions serve for local evidence.
- Deno dependency information is not proof of the exact deployed ESZip's contents or size. The [documented bundle limits](https://supabase.com/docs/guides/functions/limits) distinguish CLI-local and server-side bundling. Capture exact deployment evidence during later hosted tests.

CLI 2.98.2 includes an ES256 development signing key by default, so local asymmetric tests need no production key material. Its bearer-JWT generation command can create local fixtures. Use isolated verifier tests for RS256 unless explicitly provisioning an RS256 local fixture. See [pinned CLI configuration](https://github.com/supabase/cli/blob/v2.98.2/pkg/config/config.go).

## Remaining engineering work

These are implementation/verification tasks, not evidence already obtained:

1. Prove strict Deno imports, pg behavior, and the selected auth helper in the local Edge runtime before a broad refactor.
2. Choose and lock validator-generation tooling; confirm generated output needs neither Node-only loaders nor runtime compilation.
3. Implement explicit bounded pool/query settings appropriate to interactive uploads. Exact timeout/pool values were not chosen during the interview; do not claim an end-to-end 30-second guarantee without testing.
4. Verify local issuer/JWKS configuration and hosted connection defaults; no credentials were inspected or saved.
5. Preserve Node callback timing and configuration while making edge callbacks awaited. Awaiting alone does not provide durability or rescue indefinitely hanging callbacks.
6. Cover RLS no-op behavior explicitly: success means no database error, not proof that a row changed.

The interview used Matt Pocock's [grill-me skill](https://github.com/mattpocock/skills/blob/main/skills/productivity/grill-me/SKILL.md), which delegates to [grilling](https://github.com/mattpocock/skills/blob/main/skills/productivity/grilling/SKILL.md). It was read remotely, not installed. A read-only sub-agent assisted with Supabase/package/CLI evidence. Research is a snapshot; verify pinned APIs during implementation rather than assuming repository main remains identical.
