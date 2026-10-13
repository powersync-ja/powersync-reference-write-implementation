# Authentication setup

Details for the auth step in the [README](../../README.md#2-configure-authentication). The
export commands require the [PowerSync CLI](https://docs.powersync.com/tools/cli).

## PowerSync Cloud export


The export commands require the [PowerSync CLI](https://docs.powersync.com/tools/cli).

From the repository root, export directly to the path the backend expects:

```sh
powersync login
powersync fetch config --instance-id="<instance-id>" --output=json > backend/config/powersync-config.json
```

To use a different directory with Docker Compose, set `POWERSYNC_CONFIG_DIR` in the root `.env`;
the file inside must be named `powersync-config.json`.

Alternatively, run `powersync link cloud --instance-id="<instance-id>"` once, then omit the
instance flag on later exports. If your installed CLI also requires organization or project
IDs, pass `--org-id` and `--project-id`; use `powersync fetch config --help` to inspect its flags.

Pass the complete response with its top-level `config` object. Keep it out of version control;
it can contain database settings and secret references. This repository ignores
`powersync-config*.json` and excludes them from Docker images.

Re-export after changing auth settings. The resolver may inspect
replication settings to identify a Supabase project. If it infers Supabase from a database
connection, verify separately that your PowerSync instance accepts those tokens too.

### Supplements

What the export cannot tell the verifier comes from `AUTH_*` environment variables, not from
source edits. Set them in the root `.env` (shared defaults) or `.env.local` (this machine;
gitignored), or in `backend/.env` when running on the host. Start with none and let the startup
diagnostics tell you what is missing. List values are comma-separated; unset or blank means not
supplied. For a generic provider, for example:

```sh
AUTH_ISSUER=https://issuer.example.com
AUTH_INSTANCE_URL=https://your-instance.powersync.example.com
```

| Variable | When you need it |
| --- | --- |
| `AUTH_ISSUER` | Any generic (non-Supabase) provider. PowerSync never validates `iss`, so the expected issuer comes from your own settings, not the export. |
| `AUTH_INSTANCE_URL` | Generic Cloud imports: your PowerSync instance URL is the default audience, and the export does not contain it. |
| `AUTH_AUDIENCE` | Instead of `AUTH_INSTANCE_URL`, to state the accepted audiences explicitly. Must include any exported `additional_audiences`. |
| `AUTH_MODE=self-hosted` | No PowerSync Cloud export; see [self-hosted](#self-hosted-powersync-or-any-other-provider). |
| `AUTH_PROVIDER=supabase`, `AUTH_SUPABASE_URL` | Supabase behind a custom domain, or when project detection is ambiguous. Standard hosted Supabase usually needs none. |
| `AUTH_JWKS_URI` | The export has no key endpoint. It cannot override a different exported URI. |
| `AUTH_JWKS_URI_OVERRIDE` | The exported endpoint is written from the PowerSync service's network view (for example `http://backend:6060/...`) and your backend reaches the keys at a different address. Inline public keys are unchanged. |
| `AUTH_ALLOW_LOCAL_HTTP`, `AUTH_ALLOW_INSECURE_HTTP_HOSTS` | Plain HTTP key endpoints. HTTPS is required by default; `AUTH_ALLOW_LOCAL_HTTP=true` permits loopback, and other hosts must be named exactly (no wildcards). |
| `AUTH_ALGORITHMS` | A narrower asymmetric allowlist than the RS/PS/ES/EdDSA default. |

A value the loader cannot interpret (such as `AUTH_ALLOW_LOCAL_HTTP=yes`) stops startup with a
message naming the variable.

## Auth file location and startup

The default auth file is `backend/config/powersync-config.json`. Which environment file the backend
reads depends on how you run it; see the [README](../../README.md#1-configure-the-database).

With Docker Compose, `POWERSYNC_CONFIG_DIR` in the root `.env` selects the host directory holding
`powersync-config.json` (default `backend/config/`). Compose mounts that directory read-only at
`/app/config` and sets the container's `POWERSYNC_CONFIG_PATH` to the file inside it. A
missing file stops the backend with a setup message, except in `AUTH_MODE=self-hosted`, which
ignores it.

For local execution, the default path is relative to the verifier module. A custom
`POWERSYNC_CONFIG_PATH` is resolved from the process working directory, normally `backend/`.
For example, from the repository root:

```sh
POWERSYNC_CONFIG_PATH=/absolute/path/to/powersync-config.json pnpm --dir backend start
```

Startup calls `initializeVerifier()` before listening. Invalid configuration produces
`Cannot start.` and setup instructions. Remote JWKS endpoints are contacted on demand, so startup
does not test their availability. Configuration and inline keys are cached per process; restart
after changing them. Remote keys refresh according to the cache policy.

## Self-hosted PowerSync (or any other provider)

Set `AUTH_MODE=self-hosted` to configure the verifier from environment variables alone. No
export file is read and no code needs editing. Copy the values from the `client_auth` section of
your PowerSync service configuration, in the root `.env`, `.env.local`, or `backend/.env`:

```sh
AUTH_MODE=self-hosted
AUTH_ISSUER=https://issuer.example.com
AUTH_AUDIENCE=powersync-app
AUTH_JWKS_URI=https://issuer.example.com/.well-known/jwks.json
```

| Variable | Meaning |
| --- | --- |
| `AUTH_JWKS_URI` | Required. Your provider's key endpoint (`client_auth.jwks_uri`). |
| `AUTH_ISSUER` | Required. PowerSync never checks `iss`, so state the issuer you expect. |
| `AUTH_AUDIENCE` | Required. The complete accepted audience list, comma-separated (`client_auth.audience`). |
| `AUTH_JWKS_URI_OVERRIDE` | Optional. Read keys from this address instead, when the backend reaches the provider differently than PowerSync does. |

The other `AUTH_*` variables for HTTP trust and algorithms apply as well. `AUTH_INSTANCE_URL`,
`AUTH_SUPABASE_URL` and `AUTH_PROVIDER=supabase` are Cloud-only and are rejected in this mode.

Inline public keys (`client_auth.jwks`) cannot be given through variables. If your provider
publishes no key endpoint, adapt `backend/src/auth/verifier.ts` to call `resolveSelfHostedAuth`
with a service configuration that contains them. The resolver does not support the self-hosted
`supabase: true` mode's separate audience policy. For Supabase, set `AUTH_JWKS_URI` to the
project's `/auth/v1/.well-known/jwks.json`, `AUTH_AUDIENCE=authenticated` and `AUTH_ISSUER` to
the project's `/auth/v1` URL. See [PowerSync's manual configuration](https://docs.powersync.com/configuration/auth/supabase-auth#manual-jwks-configuration).

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
verification keys. PowerSync temporary tokens are excluded. Clerk session tokens without
`aud` need the custom integration in [the provider guide](verifiers.md).

Authentication does not restrict writes. Add [authorization](authorization.md)
using trusted identity and permissions, and configure sync access separately.
