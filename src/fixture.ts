import {dataStore} from "./datastore";
import {eventClient, EventicleEvent} from "./events/core/event-client";

export async function testDbPurge(): Promise<void> {
  (dataStore() as any).purge()
}
