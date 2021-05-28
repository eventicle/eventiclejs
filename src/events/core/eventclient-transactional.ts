



import {
  EncodedEvent,
  EventClient,
  eventClientCodec,
  EventicleEvent,
  EventSubscriptionControl, isRawEvent
} from "./event-client";
import {EventEmitter} from "events"
import {dataStore} from "../../datastore";
import logger from "../../logger";
import {listenerCount} from "cluster";


/**
 * Evernt client that wraps a delegate and integrate with the transaction manager.
 *
 * Will collect events during a transaction and emit them once the transaction commits.
 *
 * This ensures that DB changes are written before the events are sent.
 */
export function eventClientTransactional(delegate: EventClient): EventClient {
  return new EventclientTransactional(delegate)
}

class EventclientTransactional implements EventClient {

  constructor(readonly delegate: EventClient) {
    dataStore().on("transaction.start", (name, data) => {
      logger.debug("Transaction started, prepping event storage")
      data.data.events = []
    })
    dataStore().on("transaction.commit", async (name, data) => {
      logger.debug("Emitting events stored in the transactional context")
      for (let ev of data.data.events.reverse()) {
        await this.delegate.emit(ev.event, ev.stream)
      }
      data.data.events.length = 0
    })
  }

  coldHotStream(config: {
    rawEvents?: boolean,
    stream: string | string[],
    groupId?: string,
    handler: (event: EventicleEvent | EncodedEvent) => Promise<void>,
    onError: (error: any) => void
  }): Promise<EventSubscriptionControl> {
    return this.delegate.coldHotStream(config)
  };

  async clear() {
    (this.delegate as any).clear()
  }

  coldStream(stream: string, handler: (event: EventicleEvent) => Promise<void>, onError: (error: any) => void, onDone: () => void): Promise<EventSubscriptionControl> {
    return this.delegate.coldStream(stream, handler, onError, onDone)
  }

  async emit (event: EventicleEvent[] | EncodedEvent[], stream: string) {
    if (dataStore().hasTransactionData()) {
      logger.debug("Sending event in a transactional context", {
        event: event, ctx: dataStore().getTransactionData()
      })
      dataStore().getTransactionData().data.events.push({ event, stream })
    } else {
      return await this.delegate.emit(event, stream)
    }
  }

  hotStream(stream: string | string[],
                  consumerName: string,
                  handler: (event: EventicleEvent) => Promise<void>,
                  onError: (error: any) => void) {
    return this.delegate.hotStream(stream, consumerName, handler, onError)
  }

  hotRawStream(stream: string | string[], consumerName: string, handler: (event: EncodedEvent) => Promise<void>, onError: (error: any) => void): Promise<EventSubscriptionControl> {
    return this.delegate.hotRawStream(stream, consumerName, handler, onError)
  }

  isConnected(): boolean {
    return this.delegate.isConnected();
  }

  shutdown(): Promise<void> {
    return this.delegate.shutdown();
  }
}
