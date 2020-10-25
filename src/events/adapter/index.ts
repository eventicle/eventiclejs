import {eventClient, EventicleEvent} from "../core/event-client";
import logger from "../../logger";

export async function registerAdapter(view: EventAdapter): Promise<void> {

  for(let s of view.streamsToSubscribe) {
    await eventClient().hotStream(s, view.consumerGroup, async event => {
        await view.handleEvent(event)
      }, error => {
        logger.error("Error in view", error)
      })
  }
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
