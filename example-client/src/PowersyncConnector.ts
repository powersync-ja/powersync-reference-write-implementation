import { v4 as uuid } from 'uuid';

// Requires @powersync/web >=2.6.0 or @powersync/react-native >=2.4.0 for Authenticator and MutationUploader.
import type { Authenticator, CommonPowerSyncDatabase, CrudTransaction, MutationUploader } from '@powersync/web';
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

/**
 * Uploads queued local changes to the write API. Pass {@link upload} to `connect()`:
 *
 *   db.connect({ powerSyncEndpoint, authenticator, upload: new PowersyncConnector({ authenticator }).upload });
 */
export class PowersyncConnector {
  // Called by PowerSync to upload queued local changes to the write API.
  readonly upload: MutationUploader = ({ database }) => {
    const batching = this.getBatchingConfig();
    return this.uploadTransactionBatch(database, batching);
  };

  readonly config: DemoConfig;
  readonly userId: string;
  readonly apiClient: OpenAPIClient;

  private readonly authenticator: Authenticator;
  private _clientId: string | null;
  private _writeClient: WriteAPIClient | null;

  /**
   * @param authenticator Supplies the bearer token for write API requests. Pass the authenticator you
   * use for sync, or a separate one if writes need a different token. The write API accepts tokens
   * your PowerSync instance trusts. See docs/auth/providers.md.
   */
  constructor({ authenticator }: { authenticator: Authenticator }) {
    this.authenticator = authenticator;
    let userId = localStorage.getItem(USER_ID_STORAGE_KEY);
    if (!userId) {
      userId = uuid();
      localStorage.setItem(USER_ID_STORAGE_KEY, userId);
    }
    this.userId = userId;
    this._clientId = null;
    this._writeClient = null;

    this.config = readDemoConfig();

    this.apiClient = createOpenAPIClient(this.config.backendUrl, {
      timeoutMs: this.config.requestTimeoutMs,
      getAuthToken: () => this.authenticator.resolveCredentials({})
    });
  }

  /**
   * The batching config to use for the current upload. Reads the env-derived default; override to
   * make batching dynamic (e.g. shrink batch size after a fatal error, adjust for network conditions).
   */
  protected getBatchingConfig(): BatchingConfig {
    return this.config.batching || DEFAULT_BATCHING_CONFIG;
  }

  private async getWriteClient(database: CommonPowerSyncDatabase): Promise<WriteAPIClient> {
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
   * Handles a write API `retryable_error` result. Waits for retryAfterMs, if supplied,
   * then throws so PowerSync retains the transaction and retries the upload.
   * Overrides must also throw to keep the transaction queued.
   */
  protected async onRetryableError(result: Extract<TransactionResult, { status: 'retryable_error' }>): Promise<never> {
    await sleep(result.retryAfterMs ?? 0);
    throw new Error(result.message ?? 'Retryable error');
  }

  /**
   * Handles network errors, timeouts, and non-2xx responses through {@link onRetryableError}.
   * On {@link AuthenticationError}, calls the authenticator's `invalidateCredentials()` so the next
   * upload gets a new token. Override to handle transport failures separately from write API
   * retryable results.
   */
  protected async onTransportError(error: unknown): Promise<never> {
    if (error instanceof AuthenticationError) {
      this.authenticator.invalidateCredentials?.();
    }

    const message = error instanceof Error ? error.message : String(error);
    return this.onRetryableError({ status: 'retryable_error', message });
  }

  private async uploadTransactionBatch(database: CommonPowerSyncDatabase, batching: BatchingConfig): Promise<void> {
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
