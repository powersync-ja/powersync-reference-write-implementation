/**
 * Helpers for tests against the local Supabase stack. Start it with `supabase start` and
 * `supabase functions serve`, then run `deno task test` from supabase/functions/powersync-write.
 */
import pg from 'pg';

export const FUNCTION_URL =
  Deno.env.get('POWERSYNC_TEST_FUNCTION_URL') ?? 'http://127.0.0.1:54321/functions/v1/powersync-write';
export const DATA_URL = `${FUNCTION_URL}/api/data`;
export const LOCAL_ISSUER = 'http://127.0.0.1:54321/auth/v1';

/** Local Supavisor in transaction mode ([db.pooler] in supabase/config.toml), like the hosted transaction pooler. */
export const POOLER_URL = 'postgresql://postgres.pooler-dev:postgres@127.0.0.1:54329/postgres';

/** Administrative connection for checking persisted state. Never used for writes under test. */
export const admin = new pg.Pool({ connectionString: 'postgresql://postgres:postgres@127.0.0.1:54322/postgres', max: 2 });

async function run(command: string, args: string[]): Promise<string> {
  const output = await new Deno.Command(command, { args, stdout: 'piped', stderr: 'piped' }).output();
  if (!output.success) throw new Error(`${command} ${args.join(' ')} failed: ${new TextDecoder().decode(output.stderr)}`);
  return new TextDecoder().decode(output.stdout).trim();
}

let status: Promise<Record<string, string>> | undefined;
export const localStatus = () =>
  (status ??= run('supabase', ['status', '-o', 'json']).then((text) => JSON.parse(text.slice(text.indexOf('{')))));

export interface TestUser {
  id: string;
  token: string;
}

/** Signs up a fresh user through Supabase Auth and returns its access token. */
export async function signUp(label: string): Promise<TestUser> {
  const { API_URL, PUBLISHABLE_KEY } = await localStatus();
  const email = `${label}-${crypto.randomUUID()}@example.com`;
  const response = await fetch(`${API_URL}/auth/v1/signup`, {
    method: 'POST',
    headers: { apikey: PUBLISHABLE_KEY, 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'test-password-1' })
  });
  const body = await response.json();
  if (!response.ok) throw new Error(`Sign-up failed: ${JSON.stringify(body)}`);
  return { id: body.user.id, token: body.access_token };
}

/**
 * Signs a token with the local project's signing key. Defaults to a valid user token; pass
 * claims to override or (with null) remove them.
 */
export async function mintToken(claims: Record<string, unknown> = {}, flags: string[] = []): Promise<string> {
  const payload = { iss: LOCAL_ISSUER, aud: 'authenticated', ...claims };
  const args = ['gen', 'bearer-jwt', '--payload', JSON.stringify(payload), ...flags];
  if (!flags.includes('--role')) args.push('--role', 'authenticated');
  return (await run('supabase', args)).split('\n').at(-1)!;
}

export interface WriteResponse {
  status: number;
  headers: Headers;
  body: any;
}

export async function postBody(token: string | null, body: string, url = DATA_URL): Promise<WriteResponse> {
  const headers: Record<string, string> = { 'content-type': 'application/json', origin: 'http://app.test' };
  if (token !== null) headers.authorization = `Bearer ${token}`;
  const response = await fetch(url, { method: 'POST', headers, body });
  const text = await response.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Gateway errors may be plain text.
  }
  return { status: response.status, headers: response.headers, body: parsed };
}

export const post = (token: string | null, body: unknown) => postBody(token, JSON.stringify(body));

export const put = (table: string, id: string, op_data: Record<string, unknown>) => ({ op: 'PUT', table, id, op_data });
export const patch = (table: string, id: string, op_data: Record<string, unknown>) => ({ op: 'PATCH', table, id, op_data });
export const del = (table: string, id: string) => ({ op: 'DELETE', table, id });
export const batch = (...transactions: unknown[][]) => ({ transactions: transactions.map((crud) => ({ crud })) });

export async function listRow(id: string): Promise<{ name: string; owner_id: string } | undefined> {
  const { rows } = await admin.query('select name, owner_id from public.lists where id = $1', [id]);
  return rows[0];
}

export async function todoRow(id: string): Promise<{ description: string; completed: number } | undefined> {
  const { rows } = await admin.query('select description, completed from public.todos where id = $1', [id]);
  return rows[0];
}
