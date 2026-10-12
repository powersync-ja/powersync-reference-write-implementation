# Deferred hosted Supabase verification

Status: test specification only. No hosted tests or deployments have been performed. Local integration is the agreed implementation completion gate; this document describes a later, separately requested verification run.

## Prerequisites

- Local acceptance criteria in [implementation-plan.md](implementation-plan.md) pass.
- Use a dedicated Supabase test project with modern asymmetric Auth signing keys and a confirmed deployment target. Do not modify a production project's signing keys, schema, roles, or policies for these tests.
- Record the implementation commit, Deno and Supabase CLI versions, dependency lockfile, deployment method, region, and signing algorithm. Keep credentials and tokens out of recorded evidence.
- Configure the chosen database endpoint with TLS verification and the function's bounded connection settings. Record whether it uses the transaction pooler.
- Create two ordinary test users, A and B. Prepare disposable tables with explicit grants and ownership RLS policies using auth.uid(); include a policy using auth.jwt() to verify claim propagation. Include a constraint suitable for forcing a later operation to fail.
- Keep administrative database inspection separate from calls to the upload endpoint. Administrative inspection establishes actual persisted state after requests.

## Deployment and client contract

Deploy powersync-write using the documented repository workflow with gateway JWT verification enabled. Record the reported artifact size where available; compare it with the limit for the actual deployment method. A deno info report alone is not a deployed bundle measurement.

Use this connector base URL:

```text
https://<project-ref>.supabase.co/functions/v1/powersync-write
```

Existing connectors append `/api/data`. Confirm the resulting endpoint accepts the unchanged batch envelope and returns ordered transaction results. Test browser OPTIONS without a token and CORS headers on both success and handler-generated errors. Record gateway-generated errors separately because application middleware cannot rewrite responses emitted before the function runs.

## Authentication cases

| Case | Expected evidence |
| --- | --- |
| Valid A and B user tokens | Requests reach the write handler under the correct verified identity. |
| Missing token, malformed token, bad signature, expired token | Rejected; no database changes. |
| Token from another project or wrong audience | Rejected; no database changes. |
| API key without a user token | Rejected by the user boundary even if the gateway accepts the credential. |
| Non-user role, empty subject, missing expiry | Rejected by the applicable gateway/application checks. Use controlled fixtures; do not loosen production validation to construct them. |
| JWKS unavailable | No writes; record the actual HTTP failure and verify the connector retains queued work. |

Exercise ES256 and RS256 on suitably configured disposable projects or controlled test configurations. If only one can be tested in the selected project, record the other as untested rather than inferring coverage from local unit tests.

For rotation, rotate keys only in the disposable project. Confirm a newly issued token works, observe behavior during the documented overlap period, and test retired-key behavior after relevant cache windows. Record gateway and SDK outcomes independently. Never log full JWTs or signing material.

## Persistence and RLS cases

1. A creates, updates, and deletes its own rows. Verify persisted values and expected claim-dependent policies.
2. A attempts to insert or upsert a row owned by B. Expect policy rejection and a fatal transaction result; verify no partial changes.
3. A PATCHes or DELETEs B's invisible row. Expect the selected successful no-op behavior; verify B's row is unchanged.
4. Submit a transaction whose first operation succeeds and later operation violates a constraint. Verify the entire transaction rolls back and the reported operation index refers to the original upload order.
5. Alternate A and B over repeated requests and concurrent requests. Verify no claims/role leakage on pooled connections, including reuse after a failed transaction.
6. Test a table without the required authenticated grants. Expect authorization classification, not a successful privileged write.
7. Verify mapping and a custom authorizer hook. A denied transaction must produce no writes; a mapper-skipped operation must preserve indexing of later failures.

The function must use fixed transaction-local role switching and verified claims for every transaction. Existing-row policies must be enforced by PostgreSQL, not inferred from a submitted owner field.

## Batch, errors, and callback lifecycle

- Exercise a successful batch, default stop on fatal failure, skip after a backend-directed fatal failure, and stopping after retryable or client-directed failures. Verify all remaining results are not_attempted.
- Test an empty transaction, an empty batch, 50 transactions, 51 transactions, malformed CRUD entries, and malformed JSON against the documented contract.
- Introduce a controlled connection/query failure in test infrastructure. Check retryable classification, rollback/connection disposal, and successful recovery on a later request.
- Use an asynchronous test dead-letter hook and verify it completes before the edge response. Make it throw and verify logging without changing the transaction's fatal result. This test does not establish durable delivery.
- Simulate loss of a response after a possible commit. Verify connector retry behavior and document replay ambiguity; exactly-once application is outside scope.

## Worker reuse and workload

Run ordinary representative uploads, then a bounded concurrency test using both users. Record request sizes, operations per transaction, p50/p95 latency, timeouts, errors, and observed connection counts where available. Include cold starts and requests after an idle interval.

Verify pool/acquisition/query limits work and the selected workload normally fits the existing client timeout. Do not extrapolate this into a guarantee for arbitrary large transactions or offline backlogs. Do not increase concurrency without a test-project resource budget.

## Evidence and completion

Record each case as pass, fail, or not run with sanitized response bodies, expected/actual database state, and relevant logs. Identify which layer rejected requests: gateway, auth helper, handler validation, authorization hook, or database. Link failures to follow-up work; distinguish observed results from assumptions.

Use a dated results file under this directory when the run actually happens. Hosted support is verified only for the tested configuration; do not retroactively label these planned cases as completed.

Remove only test-created rows, tables, users, hooks, and deployments after the run, using the fixture inventory. Restore temporary test configuration where appropriate. Do not remove unrelated project resources.
