import { afterEach, describe, expect, it, vi } from 'vitest';

const readConfig = async (value: string | undefined) => {
  vi.resetModules();
  vi.stubEnv('DOTENV_CONFIG_PATH', '/dev/null');
  vi.stubEnv('BATCH_ON_FATAL_ERROR', value);
  return (await import('./config.js')).default;
};

afterEach(() => vi.unstubAllEnvs());

describe('backend fatal-error policy configuration', () => {
  it('defaults to stop when unset', async () => {
    expect((await readConfig(undefined)).batchOnFatalError).toBe('stop');
  });

  it.each(['stop', 'skip'] as const)('accepts %s and captures it at startup', async (mode) => {
    const config = await readConfig(mode);
    expect(config.batchOnFatalError).toBe(mode);
    vi.stubEnv('BATCH_ON_FATAL_ERROR', mode === 'stop' ? 'skip' : 'stop');
    expect(config.batchOnFatalError).toBe(mode);
  });

  it.each(['', 'continue', 'STOP'])('rejects invalid value %j', async (value) => {
    const config = await readConfig(value);
    expect(() => config.batchOnFatalError).toThrow('BATCH_ON_FATAL_ERROR');
  });
});
