import { dataStore } from "./";

/**
 * Purge the datastore.
 *
 * This cannot be recovered, and should only be used in testing.
 *
 * If not supported by the datastore, will throw an Error.
 */
export async function testDbPurge(): Promise<void> {
  (dataStore() as any).purge();
}
