import {eventClient, EventicleEvent} from "../core/event-client";
import logger from "../../logger";

export async function registerView(view: EventView): Promise<void> {

  for(let s of view.streamsToSubscribe) {
    // todo infer the consumer group from some process information ...
    await eventClient().coldHotStream({
      handler: async event => {
        await view.handleEvent(event)
      },
      onError: error => {
        logger.error("Error in view", error)
      },
      groupId: "",
      stream: s
    })
  }
}

export interface EventView {
  handleEvent: (event: EventicleEvent) => Promise<void>
  streamsToSubscribe: string[]
}
