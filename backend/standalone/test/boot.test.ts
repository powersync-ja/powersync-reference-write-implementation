import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import net from 'node:net';

/**
 * Tests startup failures in a separate process. Invalid configuration should produce
 * setup instructions and exit before the server starts listening.
 */

const testDir = path.dirname(fileURLToPath(import.meta.url));
const backendDir = path.join(testDir, '..', '..');
const authFixture = path.join(testDir, 'test-fixtures', 'auth-config.json');
let fixturesDir: string;

beforeAll(async () => {
  fixturesDir = await mkdtemp(path.join(tmpdir(), 'powersync-boot-'));
  await writeFile(path.join(fixturesDir, 'malformed.json'), '{"secret": "do-not-print-this",');
  await writeFile(path.join(fixturesDir, 'invalid.json'), '{}');
  await writeFile(path.join(fixturesDir, 'unsupported.json'), JSON.stringify({
    config: { client_auth: { supabase_jwt_secret: 'do-not-print-this' } }
  }));
});

afterAll(async () => {
  await rm(fixturesDir, { recursive: true, force: true });
});

interface Boot {
  code: number | null;
  output: string;
  /** True if it started listening or was still running when we gave up. */
  stillRunning: boolean;
}

const bootWith = (env: Record<string, string>): Promise<Boot> =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'standalone/index.ts'], {
      cwd: backendDir,
      // An ephemeral port cannot collide with a real backend. Auth never uses developer config.
      env: { ...process.env, PORT: '0', BATCH_ON_FATAL_ERROR: 'stop', POWERSYNC_CONFIG_PATH: authFixture, ...env }
    });

    let output = '';
    let started = false;
    child.stdout.on('data', (d) => {
      output += d;
      if (output.includes('Server is running')) {
        started = true;
        child.kill('SIGTERM');
      }
    });
    child.stderr.on('data', (d) => (output += d));

    // Kill a process that has not exited by the deadline so the test cannot leave a server running.
    const deadline = setTimeout(() => {
      child.kill('SIGKILL');
      resolve({ code: null, output, stillRunning: true });
    }, 20000);

    child.on('close', (code) => {
      clearTimeout(deadline);
      resolve({ code, output, stillRunning: started });
    });
  });

/**
 * Answers the Postgres wire protocol just enough to accept a connection and run `SELECT 1`,
 * so startup can verify the database without a real server.
 */
const message = (type: string, body: Buffer = Buffer.alloc(0)) => {
  const header = Buffer.alloc(5);
  header.write(type, 0);
  header.writeInt32BE(body.length + 4, 1);
  return Buffer.concat([header, body]);
};
const startFakePostgres = () =>
  new Promise<net.Server>((resolve) => {
    const server = net.createServer((socket) => {
      socket.on('error', () => {});
      socket.on('data', (data) => {
        if (data[0] === 'Q'.charCodeAt(0)) {
          socket.write(Buffer.concat([message('C', Buffer.from('SELECT 1\0')), message('Z', Buffer.from('I'))]));
        } else {
          const authOk = Buffer.alloc(4);
          socket.write(Buffer.concat([message('R', authOk), message('Z', Buffer.from('I'))]));
        }
      });
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });

describe('refusing to start on bad configuration', () => {
  it.each([
    ['missing.json', 'Cannot read'],
    ['malformed.json', 'Invalid JSON'],
    ['invalid.json', 'Unrecognized PowerSync auth configuration'],
    ['unsupported.json', 'config.client_auth.supabase_jwt_secret:']
  ])('reports auth configuration errors for %s before listening', async (file, diagnostic) => {
    const { code, output, stillRunning } = await bootWith({
      DATABASE_URI: 'postgres://u:p@127.0.0.1:5432/test',
      DATABASE_TYPE: 'postgres',
      POWERSYNC_CONFIG_PATH: path.join(fixturesDir, file)
    });
    expect(stillRunning).toBe(false);
    expect(code).toBe(1);
    expect(output).toContain('Cannot start.');
    expect(output).toContain(diagnostic);
    expect(output).toContain('POWERSYNC_CONFIG_PATH');
    expect(output).toContain('docs/auth/setup.md');
    expect(output).not.toContain('do-not-print-this');
    expect(output).not.toMatch(/^\s+at .+/m);
  });

  it('refuses to start when the database cannot be reached', async () => {
    const { code, output, stillRunning } = await bootWith({
      DATABASE_URI: 'postgres://u:p@127.0.0.1:1/test',
      DATABASE_TYPE: 'postgres'
    });
    expect(stillRunning).toBe(false);
    expect(code).toBe(1);
    expect(output).toContain('Cannot start.');
    expect(output).toContain('DATABASE_URI');
    expect(output).not.toMatch(/^\s+at .+/m);
  }, 40000);

  it('starts with the test auth configuration without fetching remote keys', async () => {
    const database = await startFakePostgres();
    const { port } = database.address() as net.AddressInfo;
    const { output, stillRunning } = await bootWith({
      DATABASE_URI: `postgres://u:p@127.0.0.1:${port}/test`,
      DATABASE_TYPE: 'postgres'
    }).finally(() => database.close());
    expect(stillRunning).toBe(true);
    expect(output).toContain('Server is running');
    expect(output).not.toContain('Cannot start.');
  });

  it('rejects an invalid fatal-error policy before database initialization', async () => {
    const { code, output, stillRunning } = await bootWith({
      BATCH_ON_FATAL_ERROR: 'continue',
      DATABASE_URI: '',
      DATABASE_TYPE: 'postgres'
    });
    expect(stillRunning).toBe(false);
    expect(code).not.toBe(0);
    expect(output).toContain('BATCH_ON_FATAL_ERROR');
    expect(output).toContain('stop');
    expect(output).toContain('skip');
    expect(output).toContain('.env');
    expect(output).not.toContain('DATABASE_URI');
    expect(output).not.toMatch(/^\s+at .+/m);
  }, 40000);

  it('explains that no connection string is configured, and exits non-zero', async () => {
    const { code, output, stillRunning } = await bootWith({
      DATABASE_URI: '',
      DATABASE_TYPE: 'postgres'
    });

    expect(stillRunning).toBe(false);
    expect(code).not.toBe(0);
    expect(output).toContain('DATABASE_URI');
    // Point the user to the configuration file.
    expect(output.toLowerCase()).toContain('.env');
    // Match stack frames without depending on function names.
    expect(output).not.toMatch(/^\s+at .+/m);
  }, 40000);

  it('names the supported databases when the type is not one of them', async () => {
    const { code, output, stillRunning } = await bootWith({
      DATABASE_URI: 'postgres://u:p@h:5432/d',
      DATABASE_TYPE: 'cassandra'
    });

    expect(stillRunning).toBe(false);
    expect(code).not.toBe(0);
    expect(output).toContain('cassandra');
    for (const supported of ['postgres', 'mongodb', 'mysql', 'mssql']) {
      expect(output).toContain(supported);
    }
    expect(output).not.toMatch(/^\s+at .+/m);
  }, 40000);
});
