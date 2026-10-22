import createClient from 'openapi-fetch';
import type { paths } from '../../generated/api';
import type { WriteAPITransport } from './WriteAPIClient';

export interface OpenAPIClient {
  transport: WriteAPITransport;
}

export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

/** Thrown when the backend rejects a request as unauthenticated/unauthorized (401/403). */
export class AuthenticationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthenticationError';
  }
}

export interface OpenAPIClientOptions {
  timeoutMs?: number;
  /**
   * Supplies the bearer token for each request. Called lazily per request, so a token refreshed
   * elsewhere (e.g. after an AuthenticationError) is picked up on the very next call.
   */
  getAuthToken?: () => Promise<string>;
}

export function createOpenAPIClient(baseUrl: string, options: OpenAPIClientOptions = {}): OpenAPIClient {
  const { timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS, getAuthToken } = options;
  const client = createClient<paths>({ baseUrl });

  if (getAuthToken) {
    client.use({
      async onRequest({ request }: { request: Request }) {
        const token = await getAuthToken();
        request.headers.set('Authorization', `Bearer ${token}`);
        return request;
      }
    });
  }

  return {
    transport: {
      async postTransactionBatch(body) {
        const { data, error, response } = await client.POST('/api/data', {
          body,
          signal: AbortSignal.timeout(timeoutMs)
        });
        if (error) {
          if (response.status === 401 || response.status === 403) {
            throw new AuthenticationError(`Authentication failed (${response.status}) posting transaction batch`);
          }
          throw new Error(`Failed to post transaction batch: ${error.message}`);
        }
        return data;
      }
    }
  };
}
