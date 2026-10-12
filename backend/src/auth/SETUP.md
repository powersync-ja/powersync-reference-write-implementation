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
| `AUTH_PROVIDER=supabase`, `AUTH_SUPABASE_URL` | Supabase behind a custom domain, or when project detection is ambiguous. Standard hosted Supabase usually needs none. |
| `AUTH_JWKS_URI` | The export has no key endpoint. It cannot override a different exported URI. |
| `AUTH_JWKS_URI_OVERRIDE` | The exported endpoint is written from the PowerSync service's network view (for example `http://backend:6060/...`) and your backend reaches the keys at a different address. Inline public keys are unchanged. |
| `AUTH_ALLOW_LOCAL_HTTP`, `AUTH_ALLOW_INSECURE_HTTP_HOSTS` | Plain HTTP key endpoints. HTTPS is required by default; `AUTH_ALLOW_LOCAL_HTTP=true` permits loopback, and other hosts must be named exactly (no wildcards). |
| `AUTH_ALGORITHMS` | A narrower asymmetric allowlist than the RS/PS/ES/EdDSA default. |

A value the loader cannot interpret (such as `AUTH_ALLOW_LOCAL_HTTP=yes`) stops startup with a
message naming the variable. Restart the backend after changing any of them.

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
