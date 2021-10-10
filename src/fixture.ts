import {dataStore} from "./";

export async function testDbPurge(): Promise<void> {
  (dataStore() as any).purge()
}
