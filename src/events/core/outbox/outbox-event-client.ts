import {
  EncodedEvent,
  EventClient,
  eventClientCodec,
  EventicleEvent,
  EventSubscriptionControl,
  isEncodedEvent
} from "../event-client";
import {dataStore} from "@eventicle/eventicle-utilities/dist/datastore";
import {logger} from "@eventicle/eventicle-utilities";


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

  /**
   * Stop sending and release the transport.
   *
   * Implementations must stop any periodic flush, wait for a flush already in
   * progress, and only then release the connection. Called by
   * {@link OutboxEventClient.shutdown}.
   *
   * Optional so that existing `OutboxSender` implementations keep compiling. A
   * sender without it leaks its flush loop past shutdown, which is the defect
   * this exists to close, so implement it.
   */
  disconnect?(): Promise<void>
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

  /**
   * Shut the client down: the sender first, then the wrapped delegate.
   *
   * This previously shut down only the delegate. The sender's 400ms flush
   * interval therefore survived `shutdown()` completely and kept flushing until
   * the process was killed on its exit timer. A flush caught by that kill can
   * have published to Kafka and lost the `DELETE` that records it, so the rows
   * are re-sent on restart.
   *
   * Sender before delegate: the sender is the outbound path and must stop
   * producing before the consumers behind the delegate go away. A sender that
   * fails to stop cleanly must not prevent the delegate from shutting down, so
   * its failure is logged and re-raised only after the delegate has had its
   * turn.
   *
   * The caller is responsible for ordering: run this *after* the HTTP server has
   * closed. `notify()` throws once the sender is disconnected, so any request
   * still in flight would see its emit fail.
   */
  async shutdown(): Promise<void> {
    let senderError: unknown;

    if (this.sender.disconnect) {
      try {
        await this.sender.disconnect();
      } catch (error) {
        senderError = error;
        logger.error("Outbox sender failed to disconnect during shutdown", error);
      }
    } else {
      logger.warn(
        "Outbox sender does not implement disconnect(). Its flush loop, if any, will " +
        "outlive shutdown and may be killed mid-transaction on process exit."
      );
    }

    await this.delegate.shutdown();

    if (senderError) {
      throw senderError;
    }
  }

}
