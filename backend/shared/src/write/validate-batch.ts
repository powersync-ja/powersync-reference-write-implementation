import validateTransactionBatch from '../generated/transaction-batch-validator.ts';
import type { TransactionBatch } from './processor.ts';

interface ValidationError {
  instancePath: string;
  keyword: string;
  message?: string;
  params: { allowedValues?: unknown[] };
}

export type BatchValidationResult = { valid: true; transactions: TransactionBatch } | { valid: false; message: string };

/**
 * Validates a parsed request body against the OpenAPI TransactionBatch schema without
 * express-openapi-validator. Messages follow its request/body/... wording.
 */
export function validateBatchBody(body: unknown): BatchValidationResult {
  if (validateTransactionBatch(body)) {
    return { valid: true, transactions: (body as { transactions: TransactionBatch }).transactions };
  }
  const [error] = (validateTransactionBatch as unknown as { errors: ValidationError[] }).errors;
  let message = `request/body${error.instancePath} ${error.message ?? 'is invalid'}`;
  if (error.keyword === 'enum' && error.params.allowedValues) message += `: ${error.params.allowedValues.join(', ')}`;
  return { valid: false, message };
}
