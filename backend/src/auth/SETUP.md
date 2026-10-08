# Configuring token verification

The default `backend/src/auth/verifier.ts` reads a PowerSync Cloud JSON export, resolves
its authentication settings, and builds a verifier. It may need additional trusted
settings, such as the expected issuer or audience.

The backend does not issue tokens. It accepts only tokens signed by keys this configuration
trusts, normally the same provider your PowerSync instance trusts.

## Choose an integration

- **PowerSync Cloud:** use the export and supplements below. Supabase with asymmetric
  signing keys is supported by this path.
- **Self-hosted PowerSync:** adapt the loader to use `resolveSelfHostedAuth`, as shown below.
  The default loader does not read YAML or detect self-hosted configuration automatically.
- **Custom provider:** preserve the startup and request exports when replacing the verifier.
  See [Supabase and Clerk integration](../../../docs/auth-verifiers.md).

Use Node.js 24 and pnpm 9 for local development and tests. Install backend dependencies
with `pnpm --dir backend install` from the repository root. The export commands also require
the [PowerSync CLI](https://docs.powersync.com/tools/cli).

## PowerSync Cloud export

From the repository root, export directly to the path the backend expects:

```sh
powersync login
powersync fetch config --instance-id="<instance-id>" --output=json > backend/powersync-config.json
```

Alternatively, run `powersync link cloud --instance-id="<instance-id>"` once, then omit the
instance flag on later exports. If your installed CLI also requires organization or project
IDs, pass `--org-id` and `--project-id`; use `powersync fetch config --help` to inspect its flags.
The [export command](https://github.com/powersync-ja/powersync-cli/blob/main/cli/src/commands/fetch/config.ts)
prints JSON when `--output=json` is supplied.

Pass the complete response with its top-level `config` object. Keep it out of version control;
it can contain database settings and secret references. This repository ignores
`powersync-config*.json` and excludes them from Docker images.

Re-export and restart the backend after changing auth settings. The resolver may inspect
replication settings to identify a Supabase project. If it infers Supabase from a database
connection, verify separately that your PowerSync instance accepts those tokens too.

### Supplements

Supplements are environment variables, not source edits. Set them in the root `.env` (shared
defaults) or `.env.local` (this machine; gitignored), or in `backend/.env` when running on the host.
For a generic provider, for example:

```sh
AUTH_ISSUER=https://issuer.example.com
AUTH_INSTANCE_URL=https://your-instance.powersync.example.com
```

Use your provider's actual issuer and your actual PowerSync instance URL. Instead of
`AUTH_INSTANCE_URL`, you can set `AUTH_AUDIENCE` to a comma-separated list of the intended
accepted audiences, including any exported `additional_audiences`.

Standard hosted Supabase configurations usually need no supplements. For a custom domain
or ambiguous project detection, set `AUTH_PROVIDER=supabase` and `AUTH_SUPABASE_URL` as directed
by the resolver. Unset or blank variables are simply not supplied.

| Variable | Supplement |
| --- | --- |
| `AUTH_ISSUER` | `issuer` |
| `AUTH_AUDIENCE` | `audience` (comma-separated) |
| `AUTH_INSTANCE_URL` | `instanceUrl` |
| `AUTH_SUPABASE_URL` | `supabaseUrl` |
| `AUTH_PROVIDER` | `provider`: `supabase` or `generic` |
| `AUTH_JWKS_URI` | `jwksUri` |
| `AUTH_JWKS_URI_OVERRIDE` | `jwksUriOverride` (comma-separated) |
| `AUTH_ALGORITHMS` | `algorithms` (comma-separated) |
| `AUTH_ALLOW_LOCAL_HTTP` | `allowLocalHttp`: `true` or `false` |
| `AUTH_ALLOW_INSECURE_HTTP_HOSTS` | `allowInsecureHttpHosts` (comma-separated) |

A value the loader cannot interpret (such as `AUTH_ALLOW_LOCAL_HTTP=yes`) stops startup with a
message naming the variable. The table of when each is needed is in `verifier.ts`; the parsing is
in `verifier/env.ts`. Restart the backend after changing any of them.

For JWKS URLs, distinguish two settings:

- `AUTH_JWKS_URI` supplies a missing endpoint; it cannot conflict with the exported endpoint.
- `AUTH_JWKS_URI_OVERRIDE` replaces remote endpoints when the backend needs a different address.
  It leaves inline public keys unchanged.

HTTPS is required by default. For local development, `AUTH_ALLOW_LOCAL_HTTP=true` permits
loopback HTTP endpoints. Other HTTP hosts require exact names in `AUTH_ALLOW_INSECURE_HTTP_HOSTS`.

## File paths and startup

| Run mode | Environment file | Default auth file |
| --- | --- | --- |
| Docker Compose | Root `.env`, then `.env.local` (both loaded into the container; `.env` alone also feeds Compose interpolation) | `backend/powersync-config.json` on the host |
| `pnpm --dir backend dev` or `start` | `backend/.env` | `backend/powersync-config.json` |

For Compose, `POWERSYNC_CONFIG_PATH` in the root `.env` selects an absolute host path. Compose
mounts that file at `/run/secrets/powersync-config.json` and sets the container's variable to
the mounted path. A missing source file prevents the container from starting.

For local execution, the default path is relative to the verifier module. A custom
`POWERSYNC_CONFIG_PATH` is resolved from the process working directory, normally `backend/`.
For example, from the repository root:

```sh
POWERSYNC_CONFIG_PATH=/absolute/path/to/powersync-config.json pnpm --dir backend start
```

Startup calls `initializeVerifier()` before listening. Invalid configuration produces
`Cannot start.` and setup instructions. Remote JWKS endpoints are contacted on demand during
verification, so startup does not test their availability. Configuration and inline keys are
cached per process; restart after changing them. Remote keys refresh according to the cache policy.

## Local demo authentication

For the manual HTTP checks, create `backend/powersync-config.json` with this content:

```json
{
  "config": {
    "client_auth": {
      "jwks_uri": "http://127.0.0.1:6060/api/auth/keys"
    }
  }
}
```

This is a local test configuration using the Cloud export format, not an export from an instance.
Set the supplements in the environment file for your run mode:

```sh
AUTH_ISSUER=powersync-dev
AUTH_AUDIENCE=powersync-dev
AUTH_ALLOW_LOCAL_HTTP=true
```

Also set `JWT_ISSUER=powersync-dev` and `POWERSYNC_URL=powersync-dev` there (the demo token
endpoint mints with those). Generate a signing pair with `pnpm --dir backend generate-keys` and copy
both values into that same environment file. The loopback JWKS URL works inside the backend
container and for a local backend on port 6060. Adjust it if you change the backend's port.

This setup tests writes without a sync connection. To sync with a real PowerSync instance,
configure that instance to trust the demo keys and accept the token's audience. The instance
must reach its configured JWKS URL; a cloud instance cannot use your backend's loopback URL.
Set the client's sync URL to the real instance URL. The client's sync URL and the token's
`aud` are separate settings, even when they have the same value.

## Self-hosted PowerSync

Use the configuration that runs your PowerSync service. Parse its YAML and resolve `!env`
references in your own loading code, or save the already-resolved configuration as JSON.
The repository does not include a YAML parser or a service configuration file.

For the JSON approach, save the resolved service configuration in `backend/powersync-config.json`.
It has `client_auth` at the top level, without the Cloud `config` wrapper. For example:

```json
{
  "client_auth": {
    "jwks_uri": "https://issuer.example.com/.well-known/jwks.json",
    "audience": ["powersync-app"]
  }
}
```

Adapt `backend/src/auth/verifier.ts` as follows:

1. Import `resolveSelfHostedAuth` in place of `resolvePowerSyncAuth` from `./verifier/index.js`.
2. Keep file loading, JSON parsing, diagnostic handling, and `createTokenVerifier(result.config)`.
3. Replace the resolver call with `resolveSelfHostedAuth(dump, supplementsFromEnv())`.
4. Set `AUTH_ISSUER` to your expected issuer, for example `https://issuer.example.com`. Leave the
   Cloud-only `AUTH_INSTANCE_URL`, `AUTH_JWKS_URI`, `AUTH_PROVIDER` and `AUTH_SUPABASE_URL` unset.
5. Update the loader's file-error messages to refer to your service JSON instead of a Cloud export.
   Keep the `initializeVerifier` and `verifier` exports used by the application.

The existing Compose mount can carry this JSON file after the loader is adapted. Rebuild the
image, or restart the development process, after changing the loader.

`client_auth.audience` is the complete audience list for this resolver. Use `jwksUriOverride`
when the backend needs a different endpoint address. The resolver does not support the
self-hosted `supabase: true` mode's separate audience policy. For Supabase, omit that flag
and configure `client_auth.jwks_uri` and `client_auth.audience: ["authenticated"]` directly;
supply the project's `/auth/v1` issuer. See [PowerSync's manual configuration](https://docs.powersync.com/configuration/auth/supabase-auth#manual-jwks-configuration).

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
`aud` need the custom integration in [the provider guide](../../../docs/auth-verifiers.md).

Authentication does not restrict writes. Add [authorization](../../../docs/authorization.md)
using trusted identity and permissions, and configure sync access separately.
