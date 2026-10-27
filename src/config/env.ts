import { existsSync } from 'node:fs';

/**
 * Loads ./.env into process.env when the file exists. Values are never logged or returned.
 * Uses Node's built-in parser (process.loadEnvFile, Node >= 20.12), so there is no dotenv dependency.
 */
export function loadDotEnv(path = '.env'): void {
  if (!existsSync(path)) return;
  try {
    process.loadEnvFile(path);
  } catch {
    // unreadable or malformed file: leave process.env as is; `npm run check-env` reports what is missing
  }
}
