import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
});

it('shares initialized keys and verifies tokens after the config file is removed', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'powersync-verifier-'));
  try {
    const { privateKey, publicKey } = await generateKeyPair('ES256');
    const configPath = path.join(directory, 'auth.json');
    await writeFile(configPath, JSON.stringify({
      config: {
        client_auth: {
          jwks_uri: 'https://test-auth.supabase.co/auth/v1/.well-known/jwks.json',
          jwks: { keys: [{ ...await exportJWK(publicKey), kid: 'test-key', alg: 'ES256' }] }
        }
      }
    }));
    vi.stubEnv('POWERSYNC_CONFIG_PATH', configPath);
    const fetch = vi.fn(() => { throw new Error('Tests must not fetch remote keys'); });
    vi.stubGlobal('fetch', fetch);
    const { initializeVerifier, verifier } = await import('./src/auth/verifier.js');
    const initializing = initializeVerifier();
    expect(initializeVerifier()).toBe(initializing);
    await initializing;
    await rm(configPath);

    const token = await new SignJWT({})
      .setProtectedHeader({ alg: 'ES256', kid: 'test-key' })
      .setSubject('test-user')
      .setIssuer('https://test-auth.supabase.co/auth/v1')
      .setAudience('authenticated')
      .setExpirationTime('5m')
      .sign(privateKey);
    await expect(verifier.verify(token)).resolves.toMatchObject({ sub: 'test-user' });
    await expect(verifier.verify('not-a-token')).rejects.toMatchObject({ code: 'INVALID_TOKEN' });
    expect(fetch).not.toHaveBeenCalled();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
