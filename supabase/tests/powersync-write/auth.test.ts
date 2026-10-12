import { assertEquals } from '@std/assert';
import { pipeline } from '@supabase/middleware';
import { withRequiredClaims } from '@supabase/server/middleware/required-claims';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { userIdentity } from '../../functions/powersync-write/handler.ts';
import { admin, batch, listRow, localStatus, mintToken, post, put, signUp } from './helpers.ts';

Deno.test({
  name: 'rejects credentials that are not a valid user token for this project',
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    const user = await signUp('auth');
    const { PUBLISHABLE_KEY, ANON_KEY, SERVICE_ROLE_KEY } = await localStatus();
    const [header, payload] = user.token.split('.');
    const tampered = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/')));
    tampered.sub = crypto.randomUUID();
    const forgedPayload = btoa(JSON.stringify(tampered)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

    const cases: Record<string, string | null | (() => Promise<string>)> = {
      'missing token': null,
      'malformed token': 'not-a-jwt',
      'bad signature': `${header}.${forgedPayload}.${user.token.split('.')[2]}`,
      expired: () => mintToken({ sub: user.id }, ['--exp', '2020-01-01T00:00:00Z']),
      'missing expiry': () => mintToken({ sub: user.id, exp: null }),
      'another project': () => mintToken({ sub: user.id, iss: 'https://other-project.supabase.co/auth/v1' }),
      'wrong audience': () => mintToken({ sub: user.id, aud: 'other' }),
      'empty subject': () => mintToken({ sub: '' }),
      'anon role': () => mintToken({ sub: user.id }, ['--role', 'anon']),
      'service role': () => mintToken({ sub: user.id }, ['--role', 'service_role']),
      'anon key': ANON_KEY,
      'service role key': SERVICE_ROLE_KEY,
      'publishable API key': PUBLISHABLE_KEY
    };

    for (const [name, credential] of Object.entries(cases)) {
      await t.step(name, async () => {
        const token = typeof credential === 'function' ? await credential() : credential;
        const list = crypto.randomUUID();
        const res = await post(token, batch([put('lists', list, { name })]));
        assertEquals(res.status, 401, JSON.stringify(res.body));
        assertEquals(await listRow(list), undefined);
      });
    }

    await t.step('accepts a locally signed user token', async () => {
      const list = crypto.randomUUID();
      const res = await post(await mintToken({ sub: user.id }), batch([put('lists', list, { name: 'minted' })]));
      assertEquals(res.body, { results: [{ status: 'success' }] });
      assertEquals((await listRow(list))?.owner_id, user.id);
    });

    await admin.end();
  }
});

Deno.test('verifies RS256 project keys with the same issuer, audience, and role checks', async () => {
  const issuer = 'https://example-project.supabase.co/auth/v1';
  const keys = await generateKeyPair('RS256', { extractable: true });
  const other = await generateKeyPair('RS256', { extractable: true });
  const jwk = { ...(await exportJWK(keys.publicKey)), kid: 'rsa-1', alg: 'RS256', use: 'sig' };
  const handle = pipeline([withRequiredClaims({ jwks: { keys: [jwk] }, issuer, audience: 'authenticated' })], async (_req, ctx) => {
    const auth = userIdentity(ctx.jwtClaims as Record<string, unknown>);
    return auth ? Response.json({ sub: auth.sub }) : new Response(null, { status: 401 });
  });
  const sign = ({ key = keys.privateKey, iss = issuer, aud = 'authenticated', exp = '5m', role = 'authenticated' } = {}) =>
    new SignJWT({ role })
      .setProtectedHeader({ alg: 'RS256', kid: 'rsa-1' })
      .setIssuer(iss)
      .setAudience(aud)
      .setSubject('user-1')
      .setExpirationTime(exp)
      .sign(key);
  const call = async (token: string) =>
    (await handle(new Request('http://localhost/powersync-write/api/data', { headers: { authorization: `Bearer ${token}` } }))).status;

  assertEquals(await call(await sign()), 200);
  assertEquals(await call(await sign({ key: other.privateKey })), 401);
  assertEquals(await call(await sign({ iss: 'https://other.supabase.co/auth/v1' })), 401);
  assertEquals(await call(await sign({ aud: 'anon' })), 401);
  assertEquals(await call(await sign({ exp: '-1m' })), 401);
  assertEquals(await call(await sign({ role: 'service_role' })), 401);
});

Deno.test('userIdentity requires a subject, a future expiry, and the authenticated role', () => {
  const exp = Math.floor(Date.now() / 1000) + 60;
  assertEquals(userIdentity({ sub: 'u', exp, role: 'authenticated' })?.sub, 'u');
  assertEquals(userIdentity({ sub: '', exp, role: 'authenticated' }), null);
  assertEquals(userIdentity({ exp, role: 'authenticated' }), null);
  assertEquals(userIdentity({ sub: 'u', role: 'authenticated' }), null);
  assertEquals(userIdentity({ sub: 'u', exp: exp - 120, role: 'authenticated' }), null);
  assertEquals(userIdentity({ sub: 'u', exp, role: 'anon' }), null);
  assertEquals(userIdentity({ sub: 'u', exp }), null);
});
