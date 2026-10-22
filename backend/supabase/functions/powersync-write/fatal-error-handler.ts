import type { FatalErrorHandler } from '@powersync/write-core/write/dead-letter.ts';

/**
 * Routes permanent failures; see docs/error-handling.md. onDeadLetter is awaited before the
 * response is sent, because the worker may stop afterwards. Its failures are logged and do not
 * change the result.
 */
export const fatalErrorHandler: FatalErrorHandler = {
  requiresClientHandling: () => false,
  onDeadLetter(entry) {
    console.error(
      'Fatal transaction rejected. Configure backend/supabase/functions/powersync-write/fatal-error-handler.ts.',
      entry
    );
  }
};
