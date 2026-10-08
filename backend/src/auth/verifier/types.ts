import type { JSONWebKeySet } from 'jose';

export interface TokenVerifier {
  verify(token: string): Promise<{ sub: string; claims: Record<string, unknown> }>;
}

/** All values come from trusted operator configuration, never an incoming JWT. */
export interface AuthSupplements {
  issuer?: string;
  audience?: string[];
  instanceUrl?: string;
  supabaseUrl?: string;
  jwksUri?: string;
  /**
   * Replaces the configured JWKS URIs when the backend reaches the key service at a
   * different address. This override may differ from the exported configuration.
   */
  jwksUriOverride?: string | string[];
  /** Needed for a custom-domain Supabase endpoint without the supabase flag. */
  provider?: 'supabase' | 'generic';
  algorithms?: string[];
  /** Allows HTTP only for localhost/loopback key endpoints. */
  allowLocalHttp?: boolean;
  /** Hostnames trusted for plain HTTP, matched exactly. No wildcards, ports or paths. */
  allowInsecureHttpHosts?: string[];
}

export type KeySource =
  | { kind: 'remote'; uri: string }
  | { kind: 'inline'; jwks: JSONWebKeySet };

export interface ResolvedAuthConfig {
  provider: 'supabase' | 'generic';
  issuer: string;
  audience: string[];
  algorithms: string[];
  sources: KeySource[];
  allowLocalHttp: boolean;
  /** Non-loopback hostnames trusted for plain HTTP; empty unless explicitly supplemented. */
  insecureHttpHosts: string[];
}

export interface Diagnostic {
  code: string;
  field: string;
  message: string;
}

export type ResolutionResult =
  | { status: 'ready'; config: ResolvedAuthConfig; diagnostics: Diagnostic[] }
  | { status: 'missing-settings' | 'unsupported' | 'invalid'; diagnostics: Diagnostic[] };

export class AuthConfigurationError extends Error {
  readonly code = 'AUTH_CONFIGURATION';
  constructor(message = 'Invalid verifier configuration.') {
    super(message);
    this.name = 'AuthConfigurationError';
  }
}

export class InvalidTokenError extends Error {
  readonly code = 'INVALID_TOKEN';
  constructor() {
    super('Token verification failed.');
    this.name = 'InvalidTokenError';
  }
}

export class KeyFetchError extends Error {
  readonly code = 'KEY_FETCH_FAILED';
  constructor() {
    super('Unable to retrieve verification keys.');
    this.name = 'KeyFetchError';
  }
}
