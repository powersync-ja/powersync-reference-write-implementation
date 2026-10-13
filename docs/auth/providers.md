# Supabase and Clerk

Backend settings that are specific to these providers. For everything else, see
[auth setup](setup.md).

In the connector you copied, return the provider's token from the private `getAuthToken()`
method (writes) and `fetchCredentials()` (sync), and remove the demo token cache. If sync and
writes use different tokens, both must carry the same user ID in `sub`.

## Supabase

Use a PowerSync Cloud export configured for asymmetric Supabase Auth, following
[PowerSync's Supabase setup](https://docs.powersync.com/configuration/auth/supabase-auth). The
issuer, audience and JWKS URL are derived for standard hosted projects; a custom domain needs
`AUTH_PROVIDER` and `AUTH_SUPABASE_URL` (see [auth setup](setup.md#variables)).

Legacy HS256 secrets are rejected. Migrate to
[Supabase signing keys](https://supabase.com/docs/guides/auth/signing-keys) and re-export.

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

**A session token** has no `aud`. The backend instead checks `azp`, the origin of the app that
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

In the connector, `getAuthToken()` returns `clerk.session.getToken()` for session tokens and
`fetchCredentials()` returns `getToken({ template: '<name>' })`.
