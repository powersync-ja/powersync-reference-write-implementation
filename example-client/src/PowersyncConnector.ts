import { v4 as uuid } from 'uuid';

// Requires @powersync/web or @powersync/react-native >=1.26.0 for getCrudTransactions().
import type { AbstractPowerSyncDatabase, CrudTransaction, PowerSyncBackendConnector } from '@powersync/web';
import {
  WriteAPIClient,
  type TransactionResult,
  type ClientHandledFatalResult
} from './library/powersync/WriteAPIClient';
import { AuthenticationError, createOpenAPIClient, type OpenAPIClient } from './library/powersync/OpenAPITransport';
import {
  DEFAULT_BATCHING_CONFIG,
  readDemoConfig,
  USER_ID_STORAGE_KEY,
  type BatchingConfig,
  type DemoConfig
} from './library/powersync/DemoConnectorConfig';
import { completeAcceptedPrefix, sleep } from './library/powersync/TransactionBatching';

export class PowersyncConnector implements PowerSyncBackendConnector {
  // Called by PowerSync to upload queued local changes to the write API.
  async uploadData(database: AbstractPowerSyncDatabase): Promise<void> {
    const batching = this.getBatchingConfig();
    return this.uploadTransactionBatch(database, batching);
  }

  // Returns credentials for the PowerSync sync connection, reusing the write API token.
  // The write API accepts tokens your PowerSync instance trusts. See docs/auth-verifiers.md.
  async fetchCredentials() {
    return {
      endpoint: this.config.powersyncUrl,
      token: await this.getAuthToken()
    };
  }

  readonly config: DemoConfig;
  readonly userId: string;
  readonly apiClient: OpenAPIClient;

  private _clientId: string | null;
  private _writeClient: WriteAPIClient | null;
  private _authToken: string | null;

  constructor() {
    let userId = localStorage.getItem(USER_ID_STORAGE_KEY);
    if (!userId) {
      userId = uuid();
      localStorage.setItem(USER_ID_STORAGE_KEY, userId);
    }
    this.userId = userId;
    this._clientId = null;
    this._writeClient = null;
    this._authToken = null;

    this.config = readDemoConfig();

    this.apiClient = createOpenAPIClient(this.config.backendUrl, {
      timeoutMs: this.config.requestTimeoutMs,
      getAuthToken: () => this.getAuthToken()
    });
  }

  // Replace with your auth provider's session token (e.g. Supabase `session.access_token`).
  // The demo reads a fixed token from VITE_POWERSYNC_TOKEN.
  private async fetchAuthToken(): Promise<string> {
    if (!this.config.authToken) {
      throw new Error('No auth token. Set VITE_POWERSYNC_TOKEN or replace fetchAuthToken().');
    }
    return this.config.authToken;
  }

  /**
   * Returns the cached token shared by sync and write requests.
   * Fetches a token on first use or after {@link onTransportError} clears the cache.
   */
  private async getAuthToken(): Promise<string> {
    if (!this._authToken) {
      this._authToken = await this.fetchAuthToken();
    }
    return this._authToken;
  }

  /**
   * The batching config to use for the current upload. Reads the env-derived default; override to
   * make batching dynamic (e.g. shrink batch size after a fatal error, adjust for network conditions).
   */
  protected getBatchingConfig(): BatchingConfig {
    return this.config.batching || DEFAULT_BATCHING_CONFIG;
  }

  private async getWriteClient(database: AbstractPowerSyncDatabase): Promise<WriteAPIClient> {
    if (!this._writeClient) {
      this._writeClient = new WriteAPIClient({
        transport: this.apiClient.transport,
        userId: this.userId,
        clientId: this._clientId!
      });
    }
    return this._writeClient;
  }

  /**
   * Called only for client-directed fatal errors. Retaining blocks later uploads and may call
   * this hook again. Return 'complete' to explicitly discard the failed transaction.
   * See docs/error-handling.md for user interaction and notification deduplication guidance.
   */
  protected async onFatalTransaction(
    transaction: CrudTransaction,
    result: ClientHandledFatalResult
  ): Promise<'retain' | 'complete'> {
    console.error('Client handling required:', result.failedOperation.error_code, result.message);
    return 'retain';
  }

  /**
   * Handles a backend `retryable_error` result. Waits for retryAfterMs, if supplied,
   * then throws so PowerSync retains the transaction and retries the upload.
   * Overrides must also throw to keep the transaction queued.
   */
  protected async onRetryableError(result: Extract<TransactionResult, { status: 'retryable_error' }>): Promise<never> {
    await sleep(result.retryAfterMs ?? 0);
    throw new Error(result.message ?? 'Retryable error');
  }

  /**
   * Handles network errors, timeouts, and non-2xx responses through {@link onRetryableError}.
   * Clears the cached token on {@link AuthenticationError} so the next upload fetches a new one.
   * Override to handle transport failures separately from backend retryable results.
   */
  protected async onTransportError(error: unknown): Promise<never> {
    if (error instanceof AuthenticationError) {
      this._authToken = null;
    }

    const message = error instanceof Error ? error.message : String(error);
    return this.onRetryableError({ status: 'retryable_error', message });
  }

  private async uploadTransactionBatch(database: AbstractPowerSyncDatabase, batching: BatchingConfig): Promise<void> {
    const batch: CrudTransaction[] = [];
    let operations = 0;

    for await (const transaction of database.getCrudTransactions()) {
      // Take the transaction, then test the bounds. Testing first would either split a transaction
      // that alone exceeds maxOperations, or stall the queue on it forever.
      batch.push(transaction);
      operations += transaction.crud.length;

      if (batch.length >= batching.maxTransactions || operations >= batching.maxOperations) {
        break;
      }
    }

    if (batch.length === 0) return;

    this._clientId = await database.getClientId();
    const writeClient = await this.getWriteClient(database);

    let results: TransactionResult[];
    try {
      ({ results } = await writeClient.processTransactionBatch(batch));
    } catch (error) {
      await this.onTransportError(error);
      return;
    }

    await completeAcceptedPrefix(
      batch,
      results,
      (index, result) => this.onFatalTransaction(batch[index], result),
      (result) => this.onRetryableError(result)
    );
  }
}
