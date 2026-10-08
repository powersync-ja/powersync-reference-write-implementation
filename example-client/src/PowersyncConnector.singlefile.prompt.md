# Updating the single-file connector

Use this prompt when the modular connector, its helpers, or `backend/powersync-reference-write-api.openapi.yaml`
changes. This file is a maintenance reference; no tooling runs it automatically.

## Regeneration prompt

Regenerate `example-client/src/PowersyncConnector.singlefile.ts` from:

- `example-client/src/PowersyncConnector.ts`
- `example-client/src/library/powersync/WriteAPIClient.ts`
- `example-client/src/library/powersync/OpenAPITransport.ts`
- `example-client/src/library/powersync/DemoConnectorConfig.ts`
- `example-client/src/library/powersync/TransactionBatching.ts`
- `backend/powersync-reference-write-api.openapi.yaml`

Preserve the modular connector's runtime behavior and follow these requirements:

1. Keep the implementation in one file, alongside the modular version.
2. Use one import from `@powersync/web`, with React Native compatibility documented.
   Use plain `fetch` with authentication headers, JSON bodies, request timeouts, and
   response status checks. Do not add dependencies, relative imports, or generated types.
3. Keep configuration constants at the top. Match the defaults in `DemoConnectorConfig.ts`.
   Constants have values, so environment-variable parsing and fallback logic are unnecessary.
4. Generate demo user IDs with `crypto.randomUUID()`. Document that platforms without
   this API need a polyfill or their own UUID generator.
5. Define API types from the current OpenAPI contract, including discriminated result
   unions and application-defined error codes. Preserve the contract's type constraints.
6. Throw `AuthenticationError` for 401/403 responses so the connector clears its cached
   token. Preserve error-message parsing and fallback handling for other failures.
7. Keep `AppSchema.ts` separate from the connector.
8. Implement transport as a private connector method. Do not add a transport injection layer.
9. Omit the unused `clientId` request option and the modular `_writeClient` cache.
   The single-file connector calls its own transport method. Preserve any future
   behavior that depends on the client ID.
10. Keep a concise header covering dependencies, editable constants, demo token setup,
    write API verification, PowerSync JWKS configuration, and identity-provider integration.
    Include the setup links because users may copy the file without its README.
11. Preserve the methods and override points: `uploadData`, `fetchCredentials`,
    `getBatchingConfig`, `onFatalTransaction`, `onRetryableError`, and `onTransportError`.
    Keep shared behavior documented consistently in both connector versions.

Write comments that explain behavior, configuration, or constraints. Avoid repeated
reassurances, all-caps warnings, metaphors, and accounts of earlier design proposals.

Update the example-client README if the file layout changes, and keep the single-import
check in `docs/test.txt` consistent. The example client remains reference code without
its own package manifest, build step, or test suite.

## Fatal-error handling

Preserve the discriminated response union. Fatal results require a boolean
`requires_client_handling` and `failed_operation`; codes accept application strings,
and details accept arbitrary JSON.

Keep runtime checks for malformed responses and the `completeAcceptedPrefix` behavior.
`onFatalTransaction` accepts `ClientHandledFatalResult` and returns
`Promise<'retain' | 'complete'>`. Call it only for client-directed failures and retain
by default. Complete the accepted prefix even when a callback fails, and never complete
past a retained transaction or malformed result.

Keep both connector versions covered by `backend/connector.test.ts`.
