import {dataStore} from "./datastore";

export async function testDbPurge(): Promise<void> {
  (dataStore() as any).purge()
}
