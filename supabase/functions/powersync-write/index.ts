import { pipeline } from '@supabase/middleware';
import { withCors } from '@supabase/middleware/cors';
import { withRequiredClaims } from '@supabase/server/middleware/required-claims';
import { FunctionConfigError } from './config.ts';
import { handleWrite } from './handler.ts';

const handle = pipeline(
  [
    withCors({ allowedHeaders: ['authorization', 'content-type', 'apikey', 'x-client-info'] }),
    // The signature is checked against this project's keys, which only this project's Auth signs
    // with, so the issuer is not pinned separately.
    withRequiredClaims({ audience: 'authenticated' })
  ],
  async (req, ctx) => {
    try {
      return await handleWrite(req, ctx.jwtClaims as Record<string, unknown>);
    } catch (error) {
      console.error('Write request failed:', error);
      const text = error instanceof FunctionConfigError ? error.message : 'Internal server error';
      return Response.json({ message: text }, { status: 500 });
    }
  }
);

export default { fetch: handle };
