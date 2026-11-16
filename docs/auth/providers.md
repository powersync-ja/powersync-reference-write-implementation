# Supabase and Clerk

Express backend settings that are specific to these providers. For everything else, see
[auth setup](setup.md).

In your app, replace the demo `Authenticator` from the [example client](../../example-client/README.md#configure-and-connect)
with one whose `resolveCredentials()` returns the provider's token. The connector uses it for
writes and PowerSync uses it for sync. Keep the demo's token cache, which `invalidateCredentials()`
clears: the SDK isn't guaranteed to cache tokens. If sync and writes use different tokens, pass the
connector its own authenticator. Both tokens must carry the same user ID in `sub`.

## Supabase

Use a PowerSync Cloud export configured for asymmetric Supabase Auth, following
[PowerSync's Supabase setup](https://docs.powersync.com/configuration/auth/supabase-auth). The
issuer, audience and JWKS URL are derived for standard hosted projects; a custom domain needs
`AUTH_PROVIDER` and `AUTH_SUPABASE_URL` (see [auth setup](setup.md#variables)).

Legacy HS256 secrets are rejected. Migrate to
[Supabase signing keys](https://supabase.com/docs/guides/auth/signing-keys) and re-export.

The Express backend's Postgres adapter exposes the verified token claims through
`request.jwt.claims`, which Supabase's `auth.uid()` and `auth.jwt()` helpers can read. It does
not switch database roles: RLS applies only when the connection role is subject to RLS and
the policies apply to that role. See [Postgres row-level security](authorization.md#postgres-row-level-security).
The [Supabase Edge Function](../../backend/supabase/README.md) additionally switches to the
`authenticated` role, so it can use the grants and RLS policies configured for signed-in
Supabase users. It needs none of the Express backend's authentication settings.

## Clerk

Clerk publishes a JWKS endpoint, so use `AUTH_MODE=env`. Which settings you need depends on the
token you send to the write API.

**A [JWT template](https://clerk.com/docs/guides/sessions/jwt-templates) token** carries an
`aud`, so one token can serve sync and writes. Set the template's `aud` as the audience:

```dotenv
AUTH_MODE=env
AUTH_ISSUER=https://<your-frontend-api>.clerk.accounts.dev
AUTH_AUDIENCE=<the template's aud>
AUTH_JWKS_URI=https://<your-frontend-api>.clerk.accounts.dev/.well-known/jwks.json
```

**A session token** has no `aud`. The Express backend instead checks `azp`, the origin of the app that
obtained the token. You still need a template token for sync.

```dotenv
AUTH_MODE=env
AUTH_ISSUER=https://<your-frontend-api>.clerk.accounts.dev
AUTH_JWKS_URI=https://<your-frontend-api>.clerk.accounts.dev/.well-known/jwks.json
AUTH_REQUIRE_AUDIENCE=false
AUTH_AUTHORIZED_PARTIES=http://localhost:5173,https://yourapp.com
```

`AUTH_REQUIRE_AUDIENCE=false` is accepted only with `AUTH_AUTHORIZED_PARTIES`; without either
check, any token from your Clerk instance would be valid. Tokens with a missing or unlisted
`azp` are rejected, so apps whose tokens omit it need a custom verifier.

With session tokens for writes, use two authenticators: pass `connect()` one whose
`resolveCredentials()` returns `clerk.session.getToken({ template: '<name>' })`, and pass the
connector one that returns `clerk.session.getToken()`. Give each its own token cache.
