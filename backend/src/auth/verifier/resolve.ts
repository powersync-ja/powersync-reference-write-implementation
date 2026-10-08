import {
  algorithmPolicy, Diagnostics, inlineSource, overrideUris, remoteSources, resolved,
  supplementShapes, transport,
} from './policy.js';
import type { AuthSupplements, KeySource, ResolutionResult } from './types.js';
import { keyUrl, nonempty, object, strings } from './validation.js';

const JWKS_PATH = '/auth/v1/.well-known/jwks.json';
const PROJECT_HOST = /^([a-z0-9-]+)\.supabase\.co$/;

function supabaseBase(uri: string): string | undefined {
  try {
    const url = new URL(uri);
    return url.protocol === 'https:' && PROJECT_HOST.test(url.hostname) && !url.port &&
      !url.username && !url.password && !url.search && !url.hash && url.pathname === JWKS_PATH
      ? url.origin : undefined;
  } catch { return undefined; }
}

/** Reads only recognized connection forms; never preserves URI credentials. */
function databaseProjects(config: Record<string, unknown>): Set<string> {
  const result = new Set<string>();
  const connections = object(config.replication)?.connections;
  if (!Array.isArray(connections)) return result;
  const inspect = (hostname: unknown, username: unknown) => {
    if (typeof hostname !== 'string') return;
    const direct = /^db\.([a-z0-9-]+)\.supabase\.co$/.exec(hostname);
    if (direct) result.add(`https://${direct[1]}.supabase.co`);
    if (/^(?:[a-z0-9-]+\.)*pooler\.supabase\.com$/.test(hostname) && typeof username === 'string') {
      const pooled = /^[^.]+\.([a-z0-9-]+)$/.exec(username);
      if (pooled) result.add(`https://${pooled[1]}.supabase.co`);
    }
  };
  for (const raw of connections) {
    const connection = object(raw);
    if (!connection || connection.type !== 'postgresql') continue;
    inspect(connection.hostname, connection.username);
    if (typeof connection.uri === 'string') {
      try {
        const url = new URL(connection.uri);
        if (['postgres:', 'postgresql:'].includes(url.protocol)) inspect(url.hostname, decodeURIComponent(url.username));
      } catch { /* A redacted/unparseable connection cannot establish a project. */ }
    }
  }
  return result;
}

/** Pure import: input is a trusted, parsed `powersync fetch config --output=json` response. */
export function resolvePowerSyncAuth(dump: unknown, supplements: AuthSupplements = {}): ResolutionResult {
  const diagnostics = new Diagnostics();
  const config = object(object(dump)?.config);
  if (!config) return { status: 'invalid', diagnostics: [{ code: 'INVALID', field: 'config', message: 'Pass the parsed complete CLI JSON response containing a config object.' }] };
  const auth = config.client_auth === undefined ? {} : object(config.client_auth);
  if (!auth) return { status: 'invalid', diagnostics: [{ code: 'INVALID', field: 'config.client_auth', message: 'Expected an auth configuration object.' }] };
  const trust = transport(supplements, diagnostics);
  supplementShapes(supplements, diagnostics);
  if (auth.supabase !== undefined && typeof auth.supabase !== 'boolean') diagnostics.issue('invalid', 'config.client_auth.supabase', 'Expected a boolean.');
  if (auth.jwks_uri !== undefined && !nonempty(auth.jwks_uri)) diagnostics.issue('invalid', 'config.client_auth.jwks_uri', 'Expected one JWKS URI string in a Cloud export.');
  if (auth.supabase_jwt_secret !== undefined) diagnostics.issue('unsupported', 'config.client_auth.supabase_jwt_secret', 'Legacy shared-secret configuration is unsupported; export an asymmetric-only configuration.');
  if (auth.audience !== undefined) diagnostics.issue('unsupported', 'config.client_auth.audience', 'This importer expects Cloud additional_audiences; pass a self-hosted service configuration to resolveSelfHostedAuth instead.');
  if (auth.allow_temporary_tokens !== undefined && typeof auth.allow_temporary_tokens !== 'boolean') diagnostics.issue('invalid', 'config.client_auth.allow_temporary_tokens', 'Expected a boolean.');
  if (auth.allow_temporary_tokens === true) diagnostics.note('TEMPORARY_TOKENS_EXCLUDED', 'config.client_auth.allow_temporary_tokens', 'PowerSync temporary tokens are not accepted by this verifier; only the configured asymmetric provider keys are used.');

  let uri = nonempty(auth.jwks_uri) ? auth.jwks_uri : undefined;
  if (nonempty(supplements.jwksUri)) {
    if (uri && uri !== supplements.jwksUri) diagnostics.issue('invalid', 'jwksUri', 'Supplement conflicts with the exported JWKS URI; use jwksUriOverride to deliberately replace it.');
    else uri = supplements.jwksUri;
  }
  const detectedBase = uri ? supabaseBase(uri) : undefined;
  // Empty exports can still identify a Supabase project through replication settings.
  // This is an inference about the intended write provider, not evidence of active sync auth.
  const exportedKeys = object(auth.jwks)?.keys;
  const keysAbsent = auth.jwks === undefined || (Array.isArray(exportedKeys) && exportedKeys.length === 0);
  const canInferFromDatabase = auth.supabase === undefined && auth.jwks_uri === undefined && keysAbsent &&
    auth.supabase_jwt_secret === undefined && auth.allow_temporary_tokens !== true &&
    supplements.provider === undefined && supplements.issuer === undefined &&
    supplements.jwksUri === undefined && supplements.supabaseUrl === undefined;
  let inferredBase: string | undefined;
  if (canInferFromDatabase) {
    const projects = databaseProjects(config);
    if (projects.size === 1) {
      inferredBase = [...projects][0];
      diagnostics.note('SUPABASE_INFERRED_FROM_DATABASE', 'config.replication.connections',
        'Auth settings are empty; Supabase Auth was inferred from the database connection. This does not confirm PowerSync accepts the same tokens. Set provider to generic to disable this inference.');
    } else if (projects.size > 1) {
      diagnostics.issue('missing', 'supabaseUrl', 'Empty auth settings reference multiple Supabase projects; explicitly select the intended project URL.');
    }
  }
  const isSupabase = auth.supabase === true || !!detectedBase || !!inferredBase || supplements.provider === 'supabase' || nonempty(supplements.supabaseUrl);
  if (isSupabase && supplements.provider === 'generic') diagnostics.issue('invalid', 'provider', 'Generic provider conflicts with Supabase Auth settings.');

  let base = detectedBase ?? inferredBase;
  if (nonempty(supplements.supabaseUrl)) {
    try {
      const url = keyUrl(supplements.supabaseUrl, trust.trust);
      if (url.pathname !== '/') throw new Error();
      if (base && base !== url.origin) diagnostics.issue('invalid', 'supabaseUrl', 'Project URL conflicts with the configured Supabase JWKS endpoint.');
      else base = url.origin;
    } catch { diagnostics.issue('invalid', 'supabaseUrl', 'Expected a Supabase project base URL without a path.'); }
  }
  if (isSupabase && !base && nonempty(supplements.issuer)) {
    try {
      const url = keyUrl(supplements.issuer, trust.trust);
      if (url.pathname === '/auth/v1') base = url.origin;
    } catch { /* The missing project diagnostic below explains the required supplement. */ }
  }
  if (auth.supabase === true) {
    const projects = databaseProjects(config);
    if (!base && projects.size === 1) base = [...projects][0];
    else if (!base && projects.size > 1) diagnostics.issue('missing', 'supabaseUrl', 'Multiple Supabase projects found; explicitly select the intended project URL.');
    else if (base && projects.size === 1 && !projects.has(base) && PROJECT_HOST.test(new URL(base).hostname)) diagnostics.issue('invalid', 'supabaseUrl', 'Auth project conflicts with the automatically detected database project.');
  }
  let issuer = nonempty(supplements.issuer) ? supplements.issuer : undefined;
  if (isSupabase) {
    if (!base) diagnostics.issue('missing', 'supabaseUrl', 'Supply the Supabase project URL, or a standard /auth/v1 issuer, to resolve Supabase Auth.');
    else {
      const expectedIssuer = `${base}/auth/v1`;
      if (issuer && issuer !== expectedIssuer) diagnostics.issue('invalid', 'issuer', 'Issuer conflicts with the resolved Supabase project.');
      issuer = expectedIssuer;
      const expectedUri = `${base}${JWKS_PATH}`;
      if (uri && uri !== expectedUri) diagnostics.issue('invalid', 'jwksUri', 'Supabase and the configured JWKS endpoint imply different sources; configure one issuer policy explicitly.');
      else uri = expectedUri;
    }
  }
  if (!issuer) diagnostics.issue('missing', 'issuer', 'Supply the expected JWT issuer from trusted provider settings.');

  const additional = auth.additional_audiences === undefined ? [] : auth.additional_audiences;
  if (!strings(additional)) diagnostics.issue('invalid', 'config.client_auth.additional_audiences', 'Expected an array of non-empty audiences.');
  const configuredAudience = new Set<string>(strings(additional) ? additional : []);
  if (isSupabase) configuredAudience.add('authenticated');
  if (nonempty(supplements.instanceUrl)) {
    try { keyUrl(supplements.instanceUrl, trust.trust); configuredAudience.add(supplements.instanceUrl); }
    catch { diagnostics.issue('invalid', 'instanceUrl', 'Expected an HTTPS instance URL (or explicitly enabled loopback HTTP).'); }
  }
  const explicitAudience = strings(supplements.audience) ? supplements.audience : undefined;
  let audience = [...configuredAudience];
  if (explicitAudience?.length) {
    const complete = isSupabase || nonempty(supplements.instanceUrl);
    if (audience.some(aud => !explicitAudience.includes(aud)) ||
        (complete && explicitAudience.some(aud => !configuredAudience.has(aud)))) {
      diagnostics.issue('invalid', 'audience', 'Explicit audiences conflict with inferred/configured audiences; supply the missing instance URL instead.');
    } else audience = [...new Set(explicitAudience)];
  }
  if (!isSupabase && !supplements.instanceUrl && !explicitAudience) diagnostics.issue('missing', 'instanceUrl', 'Supply the PowerSync instance URL, or an explicit intended audience list; additional_audiences alone is not the default audience.');
  if (!audience.length) diagnostics.issue('missing', 'audience', 'An intended JWT audience is required.');

  const override = overrideUris(supplements, diagnostics);
  if (override) diagnostics.note('JWKS_URI_OVERRIDDEN', 'jwksUriOverride', `The configured key endpoint was replaced by ${override.length} explicitly supplied URI(s); the issuer and audience policy is unchanged.`);
  const configuredUris = override ?? (uri ? [uri] : []);
  const sources: KeySource[] = remoteSources(configuredUris, trust.trust, diagnostics, override ? 'jwksUriOverride' : 'jwksUri');
  // Endpoint overrides leave inline keys unchanged.
  if (auth.jwks !== undefined) {
    const inline = inlineSource(auth.jwks, diagnostics, 'config.client_auth.jwks');
    if (inline) sources.push(inline);
  }
  if (!sources.length) diagnostics.issue(auth.allow_temporary_tokens === true ? 'unsupported' : 'missing', 'jwksUri', 'No supported verification keys found; supply a JWKS URI or configure asymmetric public keys.');

  const algorithms = algorithmPolicy(supplements, diagnostics);
  if (diagnostics.failed) return diagnostics.failure();
  return resolved({
    provider: isSupabase ? 'supabase' : 'generic', issuer: issuer!, audience,
    algorithms: [...algorithms], sources,
  }, trust, diagnostics);
}
