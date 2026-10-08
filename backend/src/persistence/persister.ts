import config from '../../config.js';
import { factories } from './persister-factories.js';
import { ConfigurationError } from '../errors.js';
import type { Persister } from '../types.js';

let substituted: Persister | null = null;
let fromConfig: Promise<Persister> | null = null;

export const setPersister = (persister: Persister): void => {
  substituted = persister;
};

export const resetPersister = (): void => {
  substituted = null;
};

export const getPersister = async (): Promise<Persister> => {
  if (substituted) {
    return substituted;
  }

  if (!fromConfig) {
    fromConfig = createConfiguredPersister().catch((error: unknown) => {
      // Don't cache a failure, a transient connection problem should not be permanent.
      fromConfig = null;
      throw error;
    });
  }

  return fromConfig;
};

const createConfiguredPersister = async (): Promise<Persister> => {
  const factory = factories[config.database.type];
  if (!factory) {
    const supported = Object.keys(factories).sort().join(', ');
    throw new ConfigurationError(
      `DATABASE_TYPE is "${config.database.type}", which is not a database this backend supports.\n\n` +
        `Supported: ${supported}\n\n` +
        `Set it in .env.`
    );
  }
  if (!config.database.uri) {
    throw new ConfigurationError(
      `DATABASE_URI is not set, so there is no source database to write to.\n\n` +
        `Set it in .env to a database you already run:\n\n` +
        `  DATABASE_URI=postgres://user:password@host:5432/database`
    );
  }

  return factory(config.database.uri);
};
