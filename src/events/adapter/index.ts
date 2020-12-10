import {eventClient, EventicleEvent} from "../core/event-client";
import logger from "../../logger";

let metrics = {

} as any

function updateLatency(view: EventAdapter, event: EventicleEvent) {
  if (!metrics.hasOwnProperty(view.name)) {
    metrics[view.name] = { latest: 0 }
  }
  if (!metrics[view.name].hasOwnProperty(event.type)) {
    metrics[view.name][event.type] = 0
  }
  metrics[view.name][event.type] = new Date().getTime() - event.createdAt
  metrics[view.name].latest = new Date().getTime() - event.createdAt
}

export function getAdapterMetrics() {
  return metrics
}

export async function registerAdapter(view: EventAdapter): Promise<void> {
  await eventClient().hotStream(view.streamsToSubscribe, view.consumerGroup, async event => {
      await view.handleEvent(event)
      updateLatency(view, event)
    },
   error => {
      logger.error("Error in adapter", error)
    })
}

/**
 * An adapter is an observer on an event stream.
 *
 * It only operates on hot event data, and will never attempt to replay everything
 */
export interface EventAdapter {
  name: string
  consumerGroup: string
  handleEvent: (event: EventicleEvent) => Promise<void>
  streamsToSubscribe: string[]
}
