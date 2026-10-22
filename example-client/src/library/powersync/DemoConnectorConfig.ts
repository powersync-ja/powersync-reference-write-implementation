import { DEFAULT_REQUEST_TIMEOUT_MS } from './OpenAPITransport';

/**
 * Bounds on a transaction batch.
 */
export type BatchingConfig = {
  maxTransactions: number;
  maxOperations: number;
};

export type DemoConfig = {
  backendUrl: string;
  powersyncUrl: string;
  /** Token for sync and writes; replace with your auth provider's session token. */
  authToken: string;
  /** `null` uploads one transaction per attempt, which is the default. */
  batching: BatchingConfig | null;
  /** Abort a write API request that takes longer than this. */
  requestTimeoutMs: number;
};

export const USER_ID_STORAGE_KEY = 'ps_user_id';

export const DEFAULT_MAX_OPERATIONS = 1000;

export const DEFAULT_BATCHING_CONFIG: BatchingConfig = {
  maxTransactions: 1,
  maxOperations: DEFAULT_MAX_OPERATIONS
};

export const readBatchingConfig = (): BatchingConfig | null => {
  const maxTransactions = Number(import.meta.env.VITE_BATCH_MAX_TRANSACTIONS ?? '');

  if (!Number.isInteger(maxTransactions) || maxTransactions < 1) {
    return null;
  }

  const maxOperations = Number(import.meta.env.VITE_BATCH_MAX_OPERATIONS ?? '');

  return {
    maxTransactions,
    maxOperations: Number.isInteger(maxOperations) && maxOperations > 0 ? maxOperations : DEFAULT_MAX_OPERATIONS
  };
};

export const readDemoConfig = (): DemoConfig => {
  const requestTimeoutMs = Number(import.meta.env.VITE_REQUEST_TIMEOUT_MS ?? '');

  return {
    backendUrl: import.meta.env.VITE_BACKEND_URL,
    powersyncUrl: import.meta.env.VITE_POWERSYNC_URL,
    authToken: import.meta.env.VITE_POWERSYNC_TOKEN ?? '',
    batching: readBatchingConfig(),
    requestTimeoutMs:
      Number.isInteger(requestTimeoutMs) && requestTimeoutMs > 0 ? requestTimeoutMs : DEFAULT_REQUEST_TIMEOUT_MS
  };
};
