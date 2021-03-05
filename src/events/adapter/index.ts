import {eventClient, EventicleEvent, EventSubscriptionControl} from "../core/event-client";
import logger from "../../logger";

let viewControls = {} as {
  [key: string]: EventSubscriptionControl
}

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

export async function registerAdapter(view: EventAdapter): Promise<EventSubscriptionControl> {
  let control = await eventClient().hotStream(view.streamsToSubscribe, view.consumerGroup, async event => {
      await view.handleEvent(event)
      updateLatency(view, event)
    },
   error => {
      logger.error("Error in adapter", error)
    })

  viewControls[view.consumerGroup] = control

  logger.debug("Added view to the controls", viewControls)

  return control
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
