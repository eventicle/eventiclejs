import {eventClient, EventicleEvent} from "../core/event-client";
import logger from "../../logger";

export async function registerView(view: EventView): Promise<void> {

  for(let s of view.streamsToSubscribe) {
    await eventClient().coldHotStream({
      handler: async event => {
        await view.handleEvent(event)
      },
      onError: error => {
        logger.error("Error in view", error)
      },
      groupId: view.consumerGroup,
      stream: view.streamsToSubscribe
    })
  }
}

export interface EventView {
  consumerGroup: string
  handleEvent: (event: EventicleEvent) => Promise<void>
  streamsToSubscribe: string[]
}
