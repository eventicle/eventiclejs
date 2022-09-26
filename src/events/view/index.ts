import {EncodedEvent, eventClient, EventicleEvent, EventSubscriptionControl} from "../core/event-client";
import {logger} from "@eventicle/eventicle-utilities";

let viewControls = {} as {
  [key: string]: EventSubscriptionControl
}

let metrics = {

} as any

function updateRawLatency(view: RawEventView, event: EncodedEvent) {
  if (!metrics.hasOwnProperty(view.consumerGroup)) {
    metrics[view.consumerGroup] = { latest: 0 }
  }
  metrics[view.consumerGroup].latest = new Date().getTime() - event.timestamp
}

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

export async function registerView(view: EventView): Promise<EventSubscriptionControl> {
  let control = await eventClient().coldHotStream({
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

  viewControls[view.consumerGroup] = control

  logger.debug("Added view to the controls", viewControls)

  return control
}

/**
 * Will register a raw event view
 *
 * This subscribes it to the appropriate event streams. For every event received, handeEvent will be called.
 *
 * Events are not processed through the {@link EventClientCodec}, and so are observed encoded as an {@link EncodedEvent}
 *
 * This can be useful if you want to persist the event in a raw form, as a binary encoded stream.
 *
 * @param view The View to subscribe to event streams
 */
export async function registerRawView(view: RawEventView): Promise<EventSubscriptionControl> {
  let control = await eventClient().coldHotStream({
    rawEvents: true,
    handler: async event => {
      await view.handleEvent(event)
      updateRawLatency(view, event)
    },
    onError: error => {
      logger.error("Error in view", error)
    },
    groupId: view.consumerGroup,
    stream: view.streamsToSubscribe
  })

  viewControls[view.consumerGroup] = control

  logger.debug("Added view to the controls", viewControls)

  return control
}

export interface EventView {
  consumerGroup: string
  handleEvent: (event: EventicleEvent) => Promise<void>
  streamsToSubscribe: string[]
}

export interface RawEventView {
  consumerGroup: string
  handleEvent: (event: EncodedEvent) => Promise<void>
  streamsToSubscribe: string[]
}
