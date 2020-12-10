import {eventClient, EventicleEvent} from "../core/event-client";
import logger from "../../logger";

let metrics = {

} as any

function updateViewLatency(view: EventView, event: EventicleEvent) {
  if (!metrics.hasOwnProperty(view.consumerGroup)) {
    metrics[view.consumerGroup] = { latest: 0 }
  }
  if (!metrics[view.consumerGroup].hasOwnProperty(event.type)) {
    metrics[view.consumerGroup][event.type] = 0
  }
  metrics[view.consumerGroup][event.type] = new Date().getTime() - event.createdAt
  metrics[view.consumerGroup].latest = new Date().getTime() - event.createdAt
}

export function getViewMetrics() {
  return metrics
}

export async function registerView(view: EventView): Promise<void> {
  await eventClient().coldHotStream({
    handler: async event => {
      await view.handleEvent(event)
      updateViewLatency(view, event)
    },
    onError: error => {
      logger.error("Error in view", error)
    },
    groupId: view.consumerGroup,
    stream: view.streamsToSubscribe
  })
}

export interface EventView {
  consumerGroup: string
  handleEvent: (event: EventicleEvent) => Promise<void>
  streamsToSubscribe: string[]
}
