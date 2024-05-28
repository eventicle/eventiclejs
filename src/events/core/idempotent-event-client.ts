import {EncodedEvent, EventClient, EventicleEvent, EventSubscriptionControl, isEncodedEvent} from "./event-client";

import {ProcessedEventRepo} from "./processed-event-repo";
import {logger} from "@eventicle/eventicle-utilities";
import {maybeRenderError} from "@eventicle/eventicle-utilities/dist/logger-util";
import {dataStore} from "@eventicle/eventicle-utilities/dist/datastore";


export class IdempotentEventClient implements EventClient {
  constructor(private delegate: EventClient, private idempotentRepo: ProcessedEventRepo) {}

  coldHotStream(config: {
    rawEvents: true;
    stream: string | string[];
    groupId: string;
    handler: (event: EncodedEvent) => Promise<void>;
    onError: (error: any) => void
  } | {
    rawEvents: false;
    stream: string | string[];
    groupId: string;
    handler: (event: EventicleEvent) => Promise<void>;
    onError: (error: any) => void
  } | {
    stream: string | string[];
    groupId: string;
    handler: (event: EventicleEvent) => Promise<void>;
    onError: (error: any) => void
  }): Promise<EventSubscriptionControl> {
    return this.delegate.coldHotStream({
      ...config,
      handler: async event => {
        // return dataStore().transaction(async () =>{
          return this.idempotentlyProcessEvent(config.groupId, event, config.handler)
        // })
      }
    });
  }

  coldStream(config: {
    stream: string,
    handler: (event: EventicleEvent) => Promise<void>,
    onError: (error: any) => void,
    onDone: () => void
  }): Promise<EventSubscriptionControl> {
    /*
     * cold streams don't require event process tracking.
     * They are used for 1 shot replays, not for ongoing event replay that might include duplication handling.
     * Due to their nature, its normal for this to be called multiple times on the same event data, and then expect a full replay.
     */
    return this.delegate.coldStream(config);
  }

  emit(event: EventicleEvent[] | EncodedEvent[], stream: string): Promise<void> {
    return this.delegate.emit(event, stream);
  }

  hotRawStream(config: {
    parallelEventCount?: number,
    stream: string | string[],
    groupId: string,
    handler: (event: EncodedEvent) => Promise<void>,
    onError: (error: any) => void
  }): Promise<EventSubscriptionControl> {
    return this.delegate.hotRawStream({...config, handler: async (event) => {
      // return dataStore().transaction(async () =>{
        return this.idempotentlyProcessEvent(config.groupId, event, config.handler)
      // })
    }});
  }

  hotStream(config: {
    parallelEventCount?: number,
    stream: string | string[],
    groupId: string,
    handler: (event: EventicleEvent) => Promise<void>,
    onError: (error: any) => void
  }): Promise<EventSubscriptionControl> {
    return this.delegate.hotStream({ ...config, handler: async (event) => {
        // return dataStore().transaction(async () =>{
          return this.idempotentlyProcessEvent(config.groupId, event, config.handler)
        // })
      }});
  }

  isConnected(): boolean {
    return this.delegate.isConnected();
  }

  shutdown(): Promise<void> {
    return this.delegate.shutdown();
  }

  async idempotentlyProcessEvent<T>(consumerName: string, event: EventicleEvent | EncodedEvent, exec: (event: EventicleEvent | EncodedEvent) => Promise<T>): Promise<T> {
    if (await this.idempotentRepo.isEventProcessed(consumerName, event)) {
      if (isEncodedEvent(event)) {
        logger.warn(`Duplicate event observed, this will be dropped`, {eventId: event.key, consumerName})
      } else {
        logger.warn(`Duplicate event observed, this will be dropped`, {eventId: event.id, consumerName})
      }
      return;
    }
    let ret: T
    try {
      ret = await exec(event)
    } catch (e) {
      logger.warn(`Failed to process event in stream`, event)
      throw e
    }
    try {
      await this.idempotentRepo.markEventProcessed(consumerName, event)
    } catch(e) {
      logger.warn("Failed to persist processed event to repo ", {
        error: maybeRenderError(e),
        event
      } )
    }
    return ret
  }
}
