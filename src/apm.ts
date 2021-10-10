import {EventicleEvent} from "./events/core/event-client";
import {getAPM, logger} from "@eventicle/eventicle-utilities";


export function apmJoinEvent(event: EventicleEvent, name: string, type:string, subtype: string) {
  if (getAPM() && event.hasOwnProperty("apmTrace")) {
    getAPM().startTransaction(name, type, subtype, (event as any).apmTrace)
  } else {
    logger.trace("Tried joining a distributed trace on an event that has no tracing", event)
  }
}
