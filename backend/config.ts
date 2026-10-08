import 'dotenv/config';
import { ConfigurationError } from './src/errors.js';

const batchOnFatalError = process.env.BATCH_ON_FATAL_ERROR ?? 'stop';

const config = {
  // Validate lazily so startup can report configuration errors without an import-time stack trace.
  get batchOnFatalError(): 'stop' | 'skip' {
    if (batchOnFatalError !== 'stop' && batchOnFatalError !== 'skip') {
      throw new ConfigurationError('Set BATCH_ON_FATAL_ERROR in .env to "stop" or "skip".');
    }
    return batchOnFatalError;
  },
  port: process.env.PORT ? parseInt(process.env.PORT) : 6060,
  database: {
    type: process.env.DATABASE_TYPE || 'postgres',
    uri: process.env.DATABASE_URI
  }
};

export default config;
