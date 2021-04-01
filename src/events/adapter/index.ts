import {eventClient, EventicleEvent, EventSubscriptionControl} from "../core/event-client";
import logger from "../../logger";
import {dataStore} from "../../datastore";

let viewControls = {} as {
  [key: string]: EventSubscriptionControl
}

let metrics = {} as any

function updateLatency(view: EventAdapter, event: EventicleEvent) {
  if (!metrics.hasOwnProperty(view.name)) {
    metrics[view.name] = {latest: 0}
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

  if (!view.errorHandler) {
    view.errorHandler = async (adapter, event, error) => {
      logger.warn("An unhandled Error was emitted by an adapter. Eventicle trapped this event and has consumed it", {
        adapter: view.name, event, error
      })
    }
  }

  let control = await eventClient().hotStream(view.streamsToSubscribe, view.consumerGroup, async event => {
      await dataStore().transaction(async () => {
        await view.handleEvent(event)
        updateLatency(view, event)
      }).catch(reason => {
        view.errorHandler(view, event, reason)
      })
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
  errorHandler?: (adapter: EventAdapter, event: EventicleEvent, error: Error) => Promise<void>
}
