# Supabase Edge Function support

Status: agreed design; implementation has not started.

## Agreed direction

Add a clone-and-deploy Supabase example backed by shared TypeScript modules. Preserve the existing Node/Docker backend and client upload protocol.

The first version targets Supabase Postgres and same-project Supabase Auth. Use direct SQL transactions, existing RLS policies and grants, and editable application hooks. No published packages or full workspace restructuring.

## Planning deliverables

The documentation set lives under `.planning/supabase-edge/`:

- **[investigation.md](investigation.md)** — current dependency graph, runtime findings, sources, interview decisions, rejected alternatives, and remaining hosted-runtime uncertainties. Start here when resuming in a new context.
- **[implementation-plan.md](implementation-plan.md)** — this implementation design and its local acceptance criteria.
- **[hosted-test-spec.md](hosted-test-spec.md)** — a standalone procedure for later hosted verification, including prerequisites, expected outcomes, evidence collection, and cleanup.

All three planning documents have been created. Implementation, runtime verification, and deployment have not started.

## Implementation design

### Share the write engine

- Extract transaction processing into a runtime-independent factory accepting the persister, authorizer, fatal-error handler, and batch policy. Return a processor accepting the validated batch and verified identity.
- Preserve ordered processing, transaction atomicity, stop/skip behavior, operation indices, and all existing response statuses.
- Keep shared modules within the backend source tree so Docker retains its current build context. Use explicit Deno-compatible TypeScript imports for shared code.
- Keep Node-specific environment loading, Express, logging middleware, and the all-database registry outside the edge import graph.
- Preserve existing backend customization entry points through wrappers where code moves.

### Compose the Supabase function

- Provide a `powersync-write` function with its own `deno.json`, lockfile, and local modules for mapping, authorization, and fatal-error handling.
- Import shared source and the Postgres adapter directly. Deployment requires no backend installation or Node build. This follows Supabase's [per-function dependency workflow](https://supabase.com/docs/guides/functions/dependencies).
- Serve `/powersync-write/api/data`, allowing existing connectors to use the function URL as their backend base URL. The hosted request URL is `https://<project-ref>.supabase.co/functions/v1/powersync-write/api/data`; configure the connector's backend base URL as `https://<project-ref>.supabase.co/functions/v1/powersync-write`.
- Preserve the OpenAPI request/response contract. Generate and commit an edge-compatible standalone request validator from the existing specification; regeneration is a maintainer task, not a deployment prerequisite.
- Handle browser preflight and attach CORS headers to success and error responses.

### Authenticate and enforce RLS

- Keep gateway JWT verification enabled and obtain verified claims through Supabase's pinned `withRequiredClaims` middleware entry point. Start with `@supabase/server` 1.9.2 and lock its dependencies.
- Configure the expected project issuer and `authenticated` audience; require a nonempty subject, valid expiry, and `authenticated` role.
- Discover public verification keys automatically. Require modern asymmetric project signing keys; no copied keys, JWT secret, or PowerSync auth export.
- Use the existing database connection, with an explicit connection-string override for pooler/local configuration.
- Within each database transaction, set verified `request.jwt.claims` and assume the fixed `authenticated` role. Both settings must be transaction-local. This follows Supabase's documented [claims-and-role RLS pattern](https://github.com/supabase/server/blob/main/docs/postgres.md).
- Rely on database grants and RLS without a mandatory table allowlist. Preserve successful no-ops when PATCH or DELETE affects zero visible rows.

### Adapt Postgres and callback lifecycle

- Retain `pg` and the existing SQL implementation. Add optional pool settings and transaction initialization while preserving current Node defaults.
- Preserve full connection-string/TLS options, bound connection and statement waits, and discard connections when rollback fails.
- Classify Postgres permission failures as authorization failures.
- Await edge dead-letter callbacks; log callback failures without changing transaction outcomes. Preserve Node's existing callback scheduling.
- Retain current retry semantics. Add no deduplication store or exactly-once guarantee.

## Local acceptance and later hosted checks

Implementation completion requires:

- Existing backend tests and type checks passing across all adapters.
- Deno type checking and dependency-graph checks proving absence of MongoDB, MySQL, SQL Server, Express, and Node configuration loaders.
- Local Supabase integration tests covering authenticated CRUD, two-user RLS isolation, pooled-connection identity cleanup, multi-operation rollback, stop/skip routing, validation failures, and awaited callbacks.
- Authentication tests for missing, forged, expired, wrong-project, wrong-audience, and non-user credentials; local ES256 integration plus isolated RS256 verification tests.
- Connector compatibility using only the changed backend URL.
- Deployment preparation working without installing backend dependencies.

The hosted specification separately covers gateway behavior, signing-key rotation, pooler/TLS connectivity, concurrency, worker reuse, and deployed bundle limits. Local success must not be described as proof of hosted compatibility.

Defaults remain ordinary interactive uploads, existing batch limits, and existing client timeouts. Large-import support, other edge databases, legacy authentication, package publication, and production schema changes remain outside this version.
