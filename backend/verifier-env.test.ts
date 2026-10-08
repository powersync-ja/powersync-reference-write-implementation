import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { supplementsFromEnv } from './src/auth/verifier/env.js';
import { AuthConfigurationError } from './src/auth/verifier/index.js';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('supplementsFromEnv', () => {
  it('supplies nothing when nothing is set, blank values included', () => {
    expect(supplementsFromEnv({})).toEqual({});
    expect(supplementsFromEnv({ AUTH_ISSUER: '', AUTH_AUDIENCE: '  ', AUTH_ALLOW_LOCAL_HTTP: ' ' })).toEqual({});
  });

  it('reads every supplement, trimming values and splitting lists on commas', () => {
    expect(
      supplementsFromEnv({
        AUTH_ISSUER: ' https://issuer.example.com ',
        AUTH_AUDIENCE: 'one, two ,,three',
        AUTH_INSTANCE_URL: 'https://instance.example.com',
        AUTH_SUPABASE_URL: 'https://x.supabase.co',
        AUTH_PROVIDER: 'supabase',
        AUTH_JWKS_URI: 'https://issuer.example.com/jwks.json',
        AUTH_JWKS_URI_OVERRIDE: 'http://host.docker.internal:3000/.well-known/jwks.json',
        AUTH_ALGORITHMS: 'RS256,ES256',
        AUTH_ALLOW_LOCAL_HTTP: 'TRUE',
        AUTH_ALLOW_INSECURE_HTTP_HOSTS: 'host.docker.internal'
      })
    ).toEqual({
      issuer: 'https://issuer.example.com',
      audience: ['one', 'two', 'three'],
      instanceUrl: 'https://instance.example.com',
      supabaseUrl: 'https://x.supabase.co',
      provider: 'supabase',
      jwksUri: 'https://issuer.example.com/jwks.json',
      jwksUriOverride: ['http://host.docker.internal:3000/.well-known/jwks.json'],
      algorithms: ['RS256', 'ES256'],
      allowLocalHttp: true,
      allowInsecureHttpHosts: ['host.docker.internal']
    });
  });

  it('keeps an explicit false, which is not the same as unset', () => {
    expect(supplementsFromEnv({ AUTH_ALLOW_LOCAL_HTTP: 'false' })).toEqual({ allowLocalHttp: false });
  });

  it('rejects values it cannot interpret, naming the variable', () => {
    expect(() => supplementsFromEnv({ AUTH_ALLOW_LOCAL_HTTP: 'yes' })).toThrow(AuthConfigurationError);
    expect(() => supplementsFromEnv({ AUTH_ALLOW_LOCAL_HTTP: 'yes' })).toThrow(/AUTH_ALLOW_LOCAL_HTTP/);
    expect(() => supplementsFromEnv({ AUTH_PROVIDER: 'okta' })).toThrow(/AUTH_PROVIDER/);
  });
});

describe('verifier configured only through the environment', () => {
  async function withGenericConfig<T>(run: (sign: (claims: { iss: string; aud: string }) => Promise<string>) => Promise<T>) {
    const directory = await mkdtemp(path.join(tmpdir(), 'powersync-verifier-env-'));
    try {
      const { privateKey, publicKey } = await generateKeyPair('RS256');
      const configPath = path.join(directory, 'auth.json');
      // A generic (non-Supabase) provider: inline keys only, so no remote fetch, and no issuer or
      // audience in the export. Those can only come from the supplements.
      await writeFile(configPath, JSON.stringify({
        config: { client_auth: { jwks: { keys: [{ ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256' }] } } }
      }));
      vi.stubEnv('POWERSYNC_CONFIG_PATH', configPath);
      vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Tests must not fetch remote keys'); }));
      const sign = ({ iss, aud }: { iss: string; aud: string }) =>
        new SignJWT({}).setProtectedHeader({ alg: 'RS256', kid: 'k1' }).setSubject('user-1').setIssuer(iss)
          .setAudience(aud).setExpirationTime('5m').sign(privateKey);
      return await run(sign);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  it('verifies a token whose issuer and audience come from AUTH_ISSUER and AUTH_AUDIENCE', async () => {
    await withGenericConfig(async (sign) => {
      vi.stubEnv('AUTH_ISSUER', 'https://issuer.example.com');
      vi.stubEnv('AUTH_AUDIENCE', 'https://instance.example.com');
      const { initializeVerifier, verifier } = await import('./src/auth/verifier.js');
      await initializeVerifier();
      await expect(verifier.verify(await sign({ iss: 'https://issuer.example.com', aud: 'https://instance.example.com' })))
        .resolves.toMatchObject({ sub: 'user-1' });
      await expect(verifier.verify(await sign({ iss: 'https://other.example.com', aud: 'https://instance.example.com' })))
        .rejects.toMatchObject({ code: 'INVALID_TOKEN' });
      await expect(verifier.verify(await sign({ iss: 'https://issuer.example.com', aud: 'https://wrong.example.com' })))
        .rejects.toMatchObject({ code: 'INVALID_TOKEN' });
    });
  });

  it('refuses to start without them and points at the environment, not at the source file', async () => {
    await withGenericConfig(async () => {
      const { initializeVerifier } = await import('./src/auth/verifier.js');
      const failure = await initializeVerifier().catch((error: unknown) => error);
      // Not toBeInstanceOf: resetModules gives the dynamically imported verifier its own copy of the class.
      expect(failure).toMatchObject({ code: 'AUTH_CONFIGURATION' });
      expect((failure as Error).message).toContain('AUTH_');
      expect((failure as Error).message).not.toContain('verifier.ts');
    });
  });
});
