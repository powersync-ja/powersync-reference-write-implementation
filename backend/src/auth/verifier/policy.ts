import type { JWK } from 'jose';
import type {
  AuthSupplements, Diagnostic, KeySource, ResolutionResult, ResolvedAuthConfig,
} from './types.js';
import {
  ASYMMETRIC_ALGORITHMS, httpTrust, keyUrl, nonempty, object, publicKey, strings,
} from './validation.js';

export type IssueKind = 'invalid' | 'unsupported' | 'missing';

/**
 * Shared configuration diagnostics. Include field names and corrective instructions;
 * omit configuration values.
 */
export class Diagnostics {
  readonly items: Diagnostic[] = [];
  private invalid = false;
  private unsupported = false;
  private missing = false;

  issue(kind: IssueKind, field: string, message: string): void {
    this.invalid ||= kind === 'invalid';
    this.unsupported ||= kind === 'unsupported';
    this.missing ||= kind === 'missing';
    this.items.push({ code: kind.toUpperCase(), field, message });
  }

  note(code: string, field: string, message: string): void {
    this.items.push({ code, field, message });
  }

  get failed(): boolean {
    return this.invalid || this.unsupported || this.missing;
  }

  /** Only call once `failed` is true; invalid outranks unsupported, which outranks missing. */
  failure(): ResolutionResult {
    return {
      status: this.invalid ? 'invalid' : this.unsupported ? 'unsupported' : 'missing-settings',
      diagnostics: this.items,
    };
  }
}

export interface Transport {
  allowLocalHttp: boolean;
  insecureHttpHosts: string[];
  trust: ReadonlySet<string>;
}

/** Resolves the hosts configured to serve keys over plain HTTP. */
export function transport(supplements: AuthSupplements, diagnostics: Diagnostics): Transport {
  const allowLocalHttp = supplements.allowLocalHttp === true;
  if (supplements.allowLocalHttp !== undefined && typeof supplements.allowLocalHttp !== 'boolean') {
    diagnostics.issue('invalid', 'allowLocalHttp', 'Expected a boolean.');
  }
  let insecureHttpHosts: string[] = [];
  const configured = supplements.allowInsecureHttpHosts;
  if (configured !== undefined) {
    if (!strings(configured)) {
      diagnostics.issue('invalid', 'allowInsecureHttpHosts', 'Expected an array of non-empty hostnames.');
    } else {
      const hosts = configured.map(host => host.trim().toLowerCase());
      // A scheme, port or path here would silently never match a URL hostname.
      if (hosts.some(host => host.includes('/') || host.includes('*') ||
          (host.includes(':') && !(host.startsWith('[') && host.endsWith(']'))))) {
        diagnostics.issue('invalid', 'allowInsecureHttpHosts', 'Expected bare hostnames, without a scheme, port, path or wildcard.');
      } else {
        insecureHttpHosts = [...new Set(hosts)];
        if (insecureHttpHosts.length) {
          diagnostics.note('INSECURE_HTTP_HOST_TRUSTED', 'allowInsecureHttpHosts',
            `Plain HTTP is trusted for ${insecureHttpHosts.length} explicitly listed host(s); key material from them is not transport-authenticated.`);
        }
      }
    }
  }
  return { allowLocalHttp, insecureHttpHosts, trust: httpTrust(allowLocalHttp, insecureHttpHosts) };
}

/** Shape checks for the supplements both importers understand. */
export function supplementShapes(supplements: AuthSupplements, diagnostics: Diagnostics): void {
  for (const field of ['issuer', 'instanceUrl', 'supabaseUrl', 'jwksUri'] as const) {
    if (supplements[field] !== undefined && !nonempty(supplements[field])) {
      diagnostics.issue('invalid', field, 'Expected a non-empty string.');
    }
  }
  if (supplements.provider !== undefined && !['supabase', 'generic'].includes(supplements.provider)) {
    diagnostics.issue('invalid', 'provider', 'Expected supabase or generic.');
  }
  if (supplements.audience !== undefined && (!strings(supplements.audience) || !supplements.audience.length)) {
    diagnostics.issue('invalid', 'audience', 'Expected a non-empty array of audiences.');
  }
}

/** Accepts the `string | string[]` shape self-hosted configuration and the override both allow. */
export function uriList(value: unknown): string[] | undefined {
  if (nonempty(value)) return [value];
  if (Array.isArray(value) && value.length && value.every(nonempty)) return [...value as string[]];
  return undefined;
}

/** Reads replacement JWKS URLs reachable from this backend. */
export function overrideUris(supplements: AuthSupplements, diagnostics: Diagnostics): string[] | undefined {
  if (supplements.jwksUriOverride === undefined) return undefined;
  const uris = uriList(supplements.jwksUriOverride);
  if (!uris) {
    diagnostics.issue('invalid', 'jwksUriOverride', 'Expected one JWKS URI string, or a non-empty array of them.');
    return undefined;
  }
  return [...new Set(uris)];
}

export function remoteSources(uris: readonly string[], trust: ReadonlySet<string>, diagnostics: Diagnostics, field: string): KeySource[] {
  const sources: KeySource[] = [];
  for (const uri of uris) {
    try { sources.push({ kind: 'remote', uri: keyUrl(uri, trust).href }); }
    catch { diagnostics.issue('invalid', field, 'Expected HTTPS without credentials, query or fragment; plain HTTP needs an explicit per-host opt-in.'); }
  }
  return sources;
}

/** Returns undefined for an absent or empty key list; a rejected key is reported, never skipped. */
export function inlineSource(jwks: unknown, diagnostics: Diagnostics, field: string): KeySource | undefined {
  const keys = object(jwks)?.keys;
  if (!Array.isArray(keys)) {
    diagnostics.issue('invalid', `${field}.keys`, 'Expected an array of public keys.');
    return undefined;
  }
  if (!keys.length) return undefined;
  const copied: JWK[] = [];
  for (const key of keys) {
    try { copied.push(publicKey(key)); }
    catch { diagnostics.issue('unsupported', `${field}.keys`, 'Only complete asymmetric public signature keys are supported; symmetric keys, private keys and secret references are rejected.'); }
  }
  return copied.length ? { kind: 'inline', jwks: { keys: copied } } : undefined;
}

export function algorithmPolicy(supplements: AuthSupplements, diagnostics: Diagnostics): string[] {
  const algorithms = supplements.algorithms ?? [...ASYMMETRIC_ALGORITHMS];
  if (!strings(algorithms) || !algorithms.length ||
      algorithms.some(alg => !(ASYMMETRIC_ALGORITHMS as readonly string[]).includes(alg))) {
    diagnostics.issue('unsupported', 'algorithms', 'Only the documented asymmetric signature algorithms are supported.');
  }
  return algorithms;
}

export function resolved(
  input: Omit<ResolvedAuthConfig, 'allowLocalHttp' | 'insecureHttpHosts'>,
  { allowLocalHttp, insecureHttpHosts }: Transport,
  diagnostics: Diagnostics,
): ResolutionResult {
  return {
    status: 'ready',
    config: { ...input, allowLocalHttp, insecureHttpHosts: [...insecureHttpHosts] },
    diagnostics: diagnostics.items,
  };
}
