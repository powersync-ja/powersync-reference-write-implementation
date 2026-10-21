# Authentication setup

Details for the auth step in the [README](../../README.md#2-configure-authentication). The
backend gets its verification settings from a PowerSync config file (the default) or from
environment variables alone (`AUTH_MODE=env`). Set variables in `.env` or `.env.local` (or
`backend/.env` when running on the host).

This page applies to the Express backend. The [Supabase Edge Function](../../backend/supabase/README.md)
verifies Supabase Auth tokens with the keys the platform provides and needs none of these settings.

## Config file (default)

The file is `backend/standalone/config/powersync-config.json`. It is either a PowerSync Cloud export or the
`client_auth` section of a self-hosted service config; the backend recognises which from its shape.
Keep it out of version control: it can contain database settings and secret references. This
repository ignores `powersync-config*.json` and excludes it from Docker images.

**PowerSync Cloud.** Export your instance's config with the [PowerSync CLI](https://docs.powersync.com/tools/cli),
so the same tokens work for the read and write paths:

```sh
powersync login
powersync fetch config --instance-id="<instance-id>" --output=json > backend/standalone/config/powersync-config.json
```

Alternatively, run `powersync link cloud --instance-id="<instance-id>"` once, then omit the
instance flag on later exports. If your CLI also requires `--org-id` and `--project-id`, see
`powersync fetch config --help`. Save the complete response, with its top-level `config` object,
and re-export after changing auth settings. The backend may infer a Supabase project from the
replication settings; if it does, verify separately that your PowerSync instance accepts those
tokens too. Usual variables: `AUTH_ISSUER` and `AUTH_INSTANCE_URL`, or `AUTH_PROVIDER` /
`AUTH_SUPABASE_URL` for Supabase on a custom domain.

**Self-hosted PowerSync.** Save your service config with `client_auth` at the top level, with
inline keys (`jwks`) or a key endpoint (`jwks_uri`) and your audience list:

```json
{
  "client_auth": {
    "jwks_uri": "https://issuer.example.com/.well-known/jwks.json",
    "audience": ["powersync-app"]
  }
}
```

PowerSync never checks `iss`, so also set `AUTH_ISSUER`. Do not set the Cloud-only variables
marked below.

## Environment variables only

Set `AUTH_MODE=env` and the backend reads no file. It suits any provider with a JWKS endpoint,
such as Clerk, Auth0 or Supabase (see [Supabase and Clerk](providers.md)):

```sh
AUTH_MODE=env
AUTH_ISSUER=https://issuer.example.com
AUTH_AUDIENCE=powersync-app
AUTH_JWKS_URI=https://issuer.example.com/.well-known/jwks.json
```

These three are required (the audience unless `AUTH_REQUIRE_AUDIENCE=false`). Inline public keys
cannot be given through variables; use a config file for them.

## Variables

Invalid values stop startup with a message naming the variable. Lists are comma-separated, and
unset or blank means not set.

| Variable | Applies to | Meaning |
| --- | --- | --- |
| `AUTH_MODE` | all | `file` (default) or `env`. |
| `AUTH_ISSUER` | all | Expected token issuer. Required except for standard Supabase. PowerSync never checks `iss`, so it comes from your settings, not the file. |
| `AUTH_AUDIENCE` | all | Accepted audiences, the complete list. Required in `env` mode. For a Cloud export, an alternative to `AUTH_INSTANCE_URL`; it must include any exported `additional_audiences`. |
| `AUTH_JWKS_URI` | `env` | Required. Your provider's key endpoint. |
| `AUTH_INSTANCE_URL` | Cloud export | Your PowerSync instance URL, the default audience for generic providers. The export does not contain it. |
| `AUTH_PROVIDER=supabase`, `AUTH_SUPABASE_URL` | Cloud export | Supabase behind a custom domain, or when project detection is ambiguous. Standard hosted Supabase needs neither. |
| `AUTH_REQUIRE_AUDIENCE`, `AUTH_AUTHORIZED_PARTIES` | `env`, self-hosted file | For tokens without `aud` (Clerk session tokens): set `AUTH_REQUIRE_AUDIENCE=false` and list the accepted `azp` origins. Dropping the audience requires the `azp` list; with an audience, the list adds a further check. |
| `AUTH_JWKS_URI_OVERRIDE` | all | Read keys from this address instead, when the backend reaches the key endpoint differently than PowerSync does (for example a Docker network name). |
| `AUTH_ALLOW_LOCAL_HTTP`, `AUTH_ALLOW_INSECURE_HTTP_HOSTS` | all | Plain-HTTP key endpoints. HTTPS is required by default; `AUTH_ALLOW_LOCAL_HTTP=true` permits loopback, and other hosts must be named exactly (no wildcards). |
| `AUTH_ALGORITHMS` | all | A narrower asymmetric allowlist than the RS/PS/ES/EdDSA default. |
| `POWERSYNC_CONFIG_DIR` | file | Docker Compose only: host directory holding `powersync-config.json` (default `backend/standalone/config`). |
| `POWERSYNC_CONFIG_PATH` | file | Running on the host: path to the file, instead of `backend/standalone/config/powersync-config.json`. |

## Verification behavior

The built-in verifier requires a valid signature, an allowed asymmetric algorithm, matching
issuer and audience, `exp`, and a non-empty `sub`. It also checks `nbf` when present.
It returns `{ sub, claims }` or throws:

| Error | Meaning and current handling |
| --- | --- |
| `AuthConfigurationError` | Invalid settings; normal startup fails before listening. |
| `InvalidTokenError` | Invalid signature or claims, or no matching key. Middleware returns 401. |
| `KeyFetchError` | JWKS retrieval failed. Middleware currently returns 401 for this too. |

Remote JWKS defaults are a 5-second fetch timeout, 10-minute cache, and 30-second refresh
cooldown. Pass `VerifierOptions` to `createTokenVerifier` to change them. Inline key rotation
requires updating the file and restarting.

The built-in resolver supports one issuer and one audience policy per verifier. It rejects
symmetric keys, private keys, legacy Supabase secrets, and configurations with no supported
verification keys. PowerSync temporary tokens are excluded from config exports; for
[development tokens](development-tokens.md), use `AUTH_MODE=env` instead. Tokens without `aud`, such as Clerk
session tokens, are supported only through `AUTH_REQUIRE_AUDIENCE=false` with `AUTH_AUTHORIZED_PARTIES`;
see [Supabase and Clerk](providers.md).

Authentication does not restrict writes. Add [authorization](authorization.md)
using trusted identity and permissions, and configure sync access separately.
