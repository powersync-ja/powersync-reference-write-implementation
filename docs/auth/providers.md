# Supabase and Clerk

This page covers provider-specific backend settings and the connector change for each. The
backend setup itself is in [auth setup](setup.md); any provider that publishes a JWKS endpoint
works the same way.

Choose a token format accepted by both the write API and your PowerSync instance.
If you use separate tokens for sync and writes, both must identify the same user in `sub`.

## Supabase

Use the existing verifier with a PowerSync Cloud export configured for asymmetric Supabase
Auth. Follow [PowerSync's Supabase setup](https://docs.powersync.com/configuration/auth/supabase-auth),
then export the configuration as described in the [setup guide](setup.md).
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

There are two token choices. Either way the backend uses `AUTH_MODE=env`; see
[auth setup](setup.md#environment-variables-only).

- A [Clerk JWT template](https://clerk.com/docs/guides/sessions/jwt-templates) containing an `aud`
  accepted by PowerSync, used for both sync and writes.
- Clerk session tokens for writes and a separate template token for sync. Session tokens carry no
  `aud`.

### One template token for sync and writes

Configure the template with the PowerSync audience and configure PowerSync to trust Clerk's
JWKS, following [custom authentication](https://docs.powersync.com/configuration/auth/custom).
Then set the following in the root `.env` or `.env.local`:

```dotenv
AUTH_MODE=env
AUTH_ISSUER=https://<your-frontend-api>.clerk.accounts.dev
AUTH_AUDIENCE=<the template's aud>
AUTH_JWKS_URI=https://<your-frontend-api>.clerk.accounts.dev/.well-known/jwks.json
```

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

Session tokens have no `aud`, so instead of an audience the backend checks the `azp` claim, the
origin of the app that obtained the token. See [Clerk's verification guide](https://clerk.com/docs/guides/sessions/manual-jwt-verification).
Turn the audience check off and list your allowed origins:

```dotenv
AUTH_MODE=env
AUTH_ISSUER=https://<your-frontend-api>.clerk.accounts.dev
AUTH_JWKS_URI=https://<your-frontend-api>.clerk.accounts.dev/.well-known/jwks.json
AUTH_REQUIRE_AUDIENCE=false
AUTH_AUTHORIZED_PARTIES=http://localhost:5173,https://yourapp.com
```

`AUTH_REQUIRE_AUDIENCE=false` is accepted only together with `AUTH_AUTHORIZED_PARTIES`: without
either check, any token from your Clerk instance would be valid. Tokens with a missing or
unlisted `azp` are rejected. Applications whose tokens omit `azp` need a custom verifier suited to
their client platform.

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
expect 401. For Clerk session tokens, also test a disallowed or missing `azp`.
Finally, verify a real write and the resulting sync update using the same user identity.
