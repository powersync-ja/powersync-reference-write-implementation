# Supabase and Clerk authentication

The write API verifies bearer tokens through `TokenVerifier` and stores `{ sub, claims }`
on `req.auth`. Its default verifier is configured from a PowerSync Cloud export; see
[auth setup](../backend/src/auth/SETUP.md).

Choose a token format accepted by both the write API and your PowerSync instance.
If you use separate tokens for sync and writes, both must identify the same user in `sub`.

## Supabase

Use the existing verifier with a PowerSync Cloud export configured for asymmetric Supabase
Auth. Follow [PowerSync's Supabase setup](https://docs.powersync.com/configuration/auth/supabase-auth),
then export the configuration as described in the [setup guide](../backend/src/auth/SETUP.md).
The resolver derives the issuer, audience, and JWKS URL for standard hosted projects.
For custom domains or ambiguous project detection, set the `AUTH_*` supplements reported at startup
(see the setup guide).

This backend rejects legacy HS256 secrets. Projects using them must migrate to
[Supabase signing keys](https://supabase.com/docs/guides/auth/signing-keys) before using this
verifier. Re-export the PowerSync configuration after removing legacy secret settings.

In the connector you copied into your app, replace the body of `getAuthToken()` with:

```ts
private async getAuthToken(): Promise<string> {
  const { data, error } = await supabase.auth.getSession();
  if (error) throw error;
  const token = data.session?.access_token;
  if (!token) throw new Error('Not signed in');
  return token;
}
```

Import your application's initialized Supabase client as `supabase`. This example uses
[getSession](https://supabase.com/docs/reference/javascript/auth-getsession) in the client
application to obtain a token; the write API still verifies it on the server.

Both connector versions call `getAuthToken()` for writes and from `fetchCredentials()`.
Keep that shared path when using the same Supabase token for sync. Remove the unused demo
`fetchAuthToken()` method, `_authToken` cache, and its reset in `onTransportError()`.
The provider SDK manages the session. The demo UUID stored in `userId` does not establish
identity on the backend; use the provider user ID in your application's ownership fields.

## Clerk

There are two integration paths:

- Use a [Clerk JWT template](https://clerk.com/docs/guides/sessions/jwt-templates) containing
  an `aud` accepted by PowerSync. Configure the Cloud export's JWKS and the write verifier's
  `AUTH_ISSUER`/`AUTH_AUDIENCE` supplements. This can use the default verifier and one token for sync and writes.
- Use Clerk session tokens for writes and a separate template token for sync. This requires a
  custom write verifier because the default verifier requires `aud`.

### One template token for sync and writes

Configure the template with the PowerSync audience and configure PowerSync to trust Clerk's
JWKS, following [custom authentication](https://docs.powersync.com/configuration/auth/custom).
Export that configuration and set the expected Clerk issuer and PowerSync audience in
`AUTH_ISSUER` and `AUTH_AUDIENCE` (root `.env` or `.env.local`).

Replace `getAuthToken()` in the copied connector with:

```ts
private async getAuthToken(): Promise<string> {
  const token = await clerk.session?.getToken({ template: 'powersync' });
  if (!token) throw new Error('Not signed in');
  return token;
}
```

`clerk` is your initialized client SDK, and `powersync` is the template name chosen in your
application. Remove the demo token method and cache as described for Supabase. The existing
`fetchCredentials()` will use the template token too.

### Session tokens for writes

For browser applications using Clerk session tokens, validate the expected issuer and allowed
`azp` origins. See [Clerk's verification guide](https://clerk.com/docs/guides/sessions/manual-jwt-verification).
The example below requires `azp`; applications whose tokens omit it need a policy appropriate
to their client platform.

Replace the contents of `backend/src/auth/verifier.ts` with this implementation. It preserves
both exports required by the application: `initializeVerifier()` for startup and `verifier`
for request middleware.

```ts
import 'dotenv/config';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { AuthConfigurationError } from './verifier/index.js';
import type { TokenVerifier } from './types.js';

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new AuthConfigurationError(`Set ${name} in the backend environment.`);
  return value;
}

async function loadVerifier(): Promise<TokenVerifier> {
  const issuer = requiredEnv('AUTH_ISSUER');
  const allowedOrigins = requiredEnv('AUTH_AUTHORIZED_PARTIES')
    .split(',').map((value) => value.trim()).filter(Boolean);
  if (!allowedOrigins.length) {
    throw new AuthConfigurationError('Set AUTH_AUTHORIZED_PARTIES to the allowed browser origins.');
  }
  let jwksUrl: URL;
  try {
    jwksUrl = new URL(requiredEnv('AUTH_JWKS_URI'));
    if (jwksUrl.protocol !== 'https:' || jwksUrl.username || jwksUrl.password) throw new Error();
  } catch {
    throw new AuthConfigurationError('Set AUTH_JWKS_URI to the HTTPS Clerk JWKS URL.');
  }
  const keys = createRemoteJWKSet(jwksUrl);
  return {
    async verify(token) {
      const { payload } = await jwtVerify(token, keys, {
        issuer,
        algorithms: ['RS256'],
        requiredClaims: ['exp', 'sub', 'iss', 'azp']
      });
      if (!payload.sub?.trim() || typeof payload.azp !== 'string' || !allowedOrigins.includes(payload.azp)) {
        throw new Error('Invalid subject or authorized party');
      }
      return { sub: payload.sub, claims: payload };
    }
  };
}

let initialized: Promise<TokenVerifier> | undefined;
export function initializeVerifier(): Promise<TokenVerifier> {
  return (initialized ??= loadVerifier());
}

export const verifier: TokenVerifier = {
  async verify(token) {
    return (await initializeVerifier()).verify(token);
  }
};
```

Set these values in `backend/.env` for local execution:

```dotenv
AUTH_JWKS_URI=https://<your-frontend-api>.clerk.accounts.dev/.well-known/jwks.json
AUTH_ISSUER=https://<your-frontend-api>.clerk.accounts.dev
AUTH_AUTHORIZED_PARTIES=http://localhost:5173,https://yourapp.com
```

For Docker, add these variables to `services.backend.environment` in `docker-compose.yaml`
and set their values in the root `.env`. Compose does not forward arbitrary root `.env` values.
This custom verifier does not read a PowerSync export, so remove the `POWERSYNC_CONFIG_PATH`
entry and its bind mount from Compose for this integration. Rebuild after replacing the verifier.

Use separate retrieval methods in the copied connector:

```ts
private async getAuthToken(): Promise<string> {
  const token = await clerk.session?.getToken();
  if (!token) throw new Error('Not signed in');
  return token;
}

async fetchCredentials() {
  const token = await clerk.session?.getToken({ template: 'powersync' });
  if (!token) throw new Error('Not signed in');
  return { endpoint: this.config.powersyncUrl, token };
}
```

The `endpoint` expression above is for the modular connector; use `POWERSYNC_URL` in the
single-file connector. Configure the template and PowerSync JWKS as in the one-token path.
Remove the demo token method and cache. If configuring `createOpenAPIClient` directly, its
callback option is named `getAuthToken`, and `timeoutMs` controls write request timeouts.
These retrieval methods are private, so edit your copied connector rather than subclassing them.

## Authorization

A valid token establishes identity. Add [authorization checks](authorization.md) and configure
PowerSync sync streams or rules for that same user ID. Do not grant permissions from
user-editable profile claims such as Supabase `user_metadata`.

## Verification

Start the configured backend and obtain a token through your signed-in client:

```bash
TOKEN='paste-a-current-token-here'
curl -i -X POST http://localhost:6060/api/data \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"transactions":[{"crud":[]}]}'
```

With the default authorizer and a reachable database, expect HTTP 200 with
`{"results":[{"status":"success"}]}` and a log identifying the provider's user ID.
This empty transaction checks authentication and transaction handling without writing a row.
If you added authorization rules, use a transaction they permit.

Repeat with no bearer header, an expired token, a wrong issuer, and a wrong signing key;
expect 401. For the Clerk session verifier, also test a disallowed or missing `azp`.
Finally, verify a real write and the resulting sync update using the same user identity.
