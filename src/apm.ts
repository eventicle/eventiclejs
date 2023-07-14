import { EventicleEvent } from "./events/core/event-client";
import { getAPM, logger } from "@eventicle/eventicle-utilities";

/**
 * Will join the APM transaction that is stamped in the event header - `apmTrace`
 *
 * This will generate a new span within the APM transaction.
 *
 * @param event the event to join the APM trace on
 * @param name The name of the APM transaction
 * @param type the APM type
 * @param subtype the APM subtype
 */
export function apmJoinEvent(
  event: EventicleEvent,
  name: string,
  type: string,
  subtype: string
) {
  getAPM().startTransaction(name, type, subtype, (event as any).apmTrace);
}
