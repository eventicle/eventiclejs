import {
  EncodedEvent,
  EventClient,
  eventClientCodec,
  EventicleEvent,
  EventSubscriptionControl,
  isEncodedEvent
} from "../event-client";
import {dataStore} from "@eventicle/eventicle-utilities/dist/datastore";


export type OutboxEventList = {
  stream: string
  events: EncodedEvent[]
  persistedAt: Date
}

export type OutboxEventListWithId = { id: string } & OutboxEventList;

/**
 * Interface for managing an Event Outbox system used for persisting,
 * retrieving, and removing events from a temporary storage.
 */
export interface EventOutbox {
  persist(events: OutboxEventList): Promise<void>
  readOutbox(): Promise<OutboxEventListWithId[]>
  removeOutboxEntries(events: OutboxEventListWithId[]): Promise<void>
}

/**
 * Represents a mechanism to handle and send notifications for outgoing messages stored in an outbox.
 */
export interface OutboxSender {
  notify(): Promise<void>
}

/**
 * OutboxEventClient is an implementation of the EventClient interface that manages event storage and processing
 * through an event outbox mechanism. It integrates with a persistence layer and a sender for event notification.
 * This class also delegates certain operations to an underlying EventClient instance.
 */
export class OutboxEventClient implements EventClient {

  constructor(private repo: EventOutbox, private sender: OutboxSender, private delegate: EventClient) {
  }

  async emit(event: EventicleEvent[] | EncodedEvent[], stream: string): Promise<void> {
    return dataStore().transaction(async () => {
      const events = await Promise.all(event.map(async ev => isEncodedEvent(ev)? ev: eventClientCodec().encode(ev)))
      await this.repo.persist({ events, stream, persistedAt: new Date() })
      await this.sender.notify();
    })
  }

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
    return this.delegate.coldHotStream(config)
  }

  coldStream(config: {
    stream: string,
    handler: (event: EventicleEvent) => Promise<void>,
    onError: (error: any) => void,
    onDone: () => void
  }): Promise<EventSubscriptionControl> {
    return this.delegate.coldStream(config);
  }

  hotRawStream(config: {
    parallelEventCount?: number,
    stream: string | string[],
    groupId: string,
    handler: (event: EncodedEvent) => Promise<void>,
    onError: (error: any) => void
  }): Promise<EventSubscriptionControl> {
    return this.delegate.hotRawStream(config)
  }

  hotStream(config: {
    parallelEventCount?: number,
    stream: string | string[],
    groupId: string,
    handler: (event: EventicleEvent) => Promise<void>,
    onError: (error: any) => void
  }): Promise<EventSubscriptionControl> {
    return this.delegate.hotStream(config)
  }

  isConnected(): boolean {
    return this.delegate.isConnected();
  }

  shutdown(): Promise<void> {
    return this.delegate.shutdown();
  }

}
