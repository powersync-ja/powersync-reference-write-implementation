import {
  algorithmPolicy, Diagnostics, inlineSource, overrideUris, remoteSources, resolved,
  supplementShapes, transport, uriList,
} from './policy.js';
import type { AuthSupplements, KeySource, ResolutionResult } from './types.js';
import { nonempty, object, strings } from './validation.js';

/**
 * Pure import of a self-hosted PowerSync service configuration.
 *
 * Input is the parsed `service.yaml` with `!env` references already resolved by the caller: this
 * module reads no files, parses no YAML and never consults `process.env`.
 *
 * Self-hosted differs from Cloud in ways that cannot be inferred, which is why it has its own
 * entry point rather than detection:
 *
 * - `client_auth.audience` is the complete accepted audience list. Cloud `additional_audiences`
 *   are additions to an always-accepted instance domain, so `instanceUrl` has no meaning here.
 * - `client_auth.jwks_uri` may be a single URI or an array of them.
 * - Supabase Auth activates only on an explicit `supabase` flag. A Supabase database alone
 *   configures nothing, so this importer never infers a provider from the connection.
 *
 * PowerSync itself does not check `iss`, so the resulting verifier is deliberately stricter than
 * the instance it mirrors: the expected issuer must come from trusted application settings.
 */
export function resolveSelfHostedAuth(config: unknown, supplements: AuthSupplements = {}): ResolutionResult {
  const diagnostics = new Diagnostics();
  const service = object(config);
  if (!service) return { status: 'invalid', diagnostics: [{ code: 'INVALID', field: 'service', message: 'Pass the parsed service configuration object, with !env references already resolved.' }] };
  const auth = object(service.client_auth);
  if (!auth) {
    return {
      status: service.client_auth === undefined ? 'missing-settings' : 'invalid',
      diagnostics: [{
        code: service.client_auth === undefined ? 'MISSING' : 'INVALID', field: 'client_auth',
        message: 'Expected a client_auth section configuring JWT verification keys.',
      }],
    };
  }
  const trust = transport(supplements, diagnostics);
  supplementShapes(supplements, diagnostics);

  // Supabase here means a per-source `authenticated` audience layered over client_auth.audience.
  // That is a second claim policy in one verifier, which this module deliberately does not model.
  if (auth.supabase !== undefined && typeof auth.supabase !== 'boolean') diagnostics.issue('invalid', 'client_auth.supabase', 'Expected a boolean.');
  if (auth.supabase === true) diagnostics.issue('unsupported', 'client_auth.supabase', 'Self-hosted Supabase Auth applies an "authenticated" audience to its own keys, separate from client_auth.audience; a single-policy verifier cannot represent that. Configure the Supabase JWKS endpoint explicitly, or import a Cloud configuration with resolvePowerSyncAuth.');
  if (auth.supabase_jwt_secret !== undefined) diagnostics.issue('unsupported', 'client_auth.supabase_jwt_secret', 'Legacy shared-secret configuration is unsupported; configure asymmetric signing keys.');
  if (supplements.provider === 'supabase' || nonempty(supplements.supabaseUrl)) diagnostics.issue('unsupported', 'provider', 'Supabase supplements apply to Cloud imports; a self-hosted deployment configures its Supabase JWKS endpoint explicitly.');

  // additional_audiences is supported only by the Cloud importer.
  if (auth.additional_audiences !== undefined) diagnostics.issue('unsupported', 'client_auth.additional_audiences', 'This is a Cloud field; a self-hosted configuration lists its complete audience under client_auth.audience.');
  if (auth.allow_temporary_tokens !== undefined) diagnostics.issue('unsupported', 'client_auth.allow_temporary_tokens', 'This is a Cloud field and has no self-hosted equivalent.');
  if (nonempty(supplements.instanceUrl)) diagnostics.issue('invalid', 'instanceUrl', 'Self-hosted client_auth.audience is already the complete audience policy; there is no implicit instance-domain audience to add.');
  if (nonempty(supplements.jwksUri)) diagnostics.issue('invalid', 'jwksUri', 'A self-hosted configuration states its own key endpoints; use jwksUriOverride to set the ones this consumer should read.');

  const issuer = nonempty(supplements.issuer) ? supplements.issuer : undefined;
  if (!issuer) diagnostics.issue('missing', 'issuer', 'Supply the expected JWT issuer from trusted provider settings; a self-hosted configuration does not record one.');

  const configured = auth.audience === undefined ? undefined : auth.audience;
  if (configured !== undefined && !strings(configured)) diagnostics.issue('invalid', 'client_auth.audience', 'Expected an array of non-empty audiences.');
  const configuredAudience = strings(configured) ? [...new Set(configured)] : [];
  const explicitAudience = strings(supplements.audience) && supplements.audience.length ? [...new Set(supplements.audience)] : undefined;
  let audience = configuredAudience;
  if (explicitAudience) {
    if (configuredAudience.length &&
        (configuredAudience.some(aud => !explicitAudience.includes(aud)) || explicitAudience.some(aud => !configuredAudience.includes(aud)))) {
      diagnostics.issue('invalid', 'audience', 'Explicit audiences conflict with the complete audience list in client_auth.audience.');
    } else audience = explicitAudience;
  }
  if (!audience.length) diagnostics.issue('missing', 'audience', 'Supply client_auth.audience, or an explicit intended audience list; a token audience is always required.');

  if (auth.jwks_uri !== undefined && !uriList(auth.jwks_uri)) diagnostics.issue('invalid', 'client_auth.jwks_uri', 'Expected one JWKS URI string, or a non-empty array of them.');
  const override = overrideUris(supplements, diagnostics);
  if (override) diagnostics.note('JWKS_URI_OVERRIDDEN', 'jwksUriOverride', `The configured key endpoint was replaced by ${override.length} explicitly supplied URI(s); the issuer and audience policy is unchanged.`);
  const uris = override ?? uriList(auth.jwks_uri) ?? [];
  const sources: KeySource[] = remoteSources([...new Set(uris)], trust.trust, diagnostics, override ? 'jwksUriOverride' : 'client_auth.jwks_uri');
  // Endpoint overrides leave inline keys unchanged.
  if (auth.jwks !== undefined) {
    const inline = inlineSource(auth.jwks, diagnostics, 'client_auth.jwks');
    if (inline) sources.push(inline);
  }
  if (!sources.length) diagnostics.issue('missing', 'client_auth.jwks_uri', 'No supported verification keys found; configure a JWKS URI or asymmetric public keys.');

  // Warn when this verifier allows HTTP hosts but the service blocks local JWKS addresses.
  // The operator should confirm that both use the intended key endpoint.
  if (auth.block_local_jwks === true && (trust.allowLocalHttp || trust.insecureHttpHosts.length)) {
    diagnostics.note('LOCAL_JWKS_BLOCKED_BY_SERVICE', 'client_auth.block_local_jwks',
      'The service blocks local JWKS addresses while this verifier trusts plain HTTP hosts; confirm both are reading the same key endpoint.');
  }

  const algorithms = algorithmPolicy(supplements, diagnostics);
  if (diagnostics.failed) return diagnostics.failure();
  return resolved({ provider: 'generic', issuer: issuer!, audience, algorithms: [...algorithms], sources }, trust, diagnostics);
}
