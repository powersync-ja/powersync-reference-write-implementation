import app from './app.js';
import config from './config.js';
import { getPersister } from './src/persistence/persister.js';
import { ConfigurationError } from './src/errors.js';
import { initializeVerifier } from './src/auth/verifier.js';
import { AuthConfigurationError } from './src/auth/verifier/index.js';

const PORT = process.env.PORT || config.port;

// Initialize dependencies inside the startup error boundary, before accepting any traffic.
try {
  void config.batchOnFatalError;
  await getPersister();
  await initializeVerifier();
} catch (error) {
  if (error instanceof ConfigurationError || error instanceof AuthConfigurationError) {
    // Configuration errors include setup instructions; print them without a stack trace.
    console.error(`\nCannot start.\n\n${error.message}\n`);
    process.exit(1);
  }
  throw error;
}

app.listen(PORT, () => {
  console.log(`Server is running @ http://127.0.0.1:${PORT}`);
});
