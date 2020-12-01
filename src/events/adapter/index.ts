import {eventClient, EventicleEvent} from "../core/event-client";
import logger from "../../logger";

export async function registerAdapter(view: EventAdapter): Promise<void> {
  await eventClient().coldHotStream({
    handler: async event => {
      await view.handleEvent(event)
    },
    onError: error => {
      logger.error("Error in adapter", error)
    },
    groupId: view.consumerGroup,
    stream: view.streamsToSubscribe
  })
}

/**
 * An adapter is an observer on an event stream.
 *
 * It only operates on hot event data, and will never attempt to replay everything
 */
export interface EventAdapter {
  consumerGroup: string
  handleEvent: (event: EventicleEvent) => Promise<void>
  streamsToSubscribe: string[]
}
