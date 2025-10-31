/**
 * Low level event stream client
 */
import * as uuid from "uuid"
import {getApmTraceparent} from "@eventicle/eventicle-utilities";

let EVENT_SOURCE = "unknown-service"

export function setEventSourceName(name: string) {
  EVENT_SOURCE = name
}

export function eventSourceName(): string {
  return EVENT_SOURCE
}

export function isRawEvent(event: EncodedEvent | EventicleEvent): event is EncodedEvent {
  return event.hasOwnProperty("buffer")
}

/**
 * Represents an event in its encoded, wire-ready format.
 * 
 * EncodedEvent is the transport representation of an EventicleEvent, containing
 * the serialized event data as a buffer along with metadata headers. This format
 * is used by EventClient implementations for efficient network transmission and
 * storage.
 * 
 * @example
 * ```typescript
 * const encodedEvent: EncodedEvent = {
 *   buffer: Buffer.from(JSON.stringify(eventData)),
 *   key: 'user-123',
 *   timestamp: Date.now(),
 *   headers: {
 *     type: 'UserCreated',
 *     domainId: 'user-123',
 *     id: 'event-456',
 *     source: 'user-service'
 *   }
 * };
 * ```
 * 
 * @see {@link EventicleEvent} For the domain event representation
 * @see {@link EventClientCodec} For encoding/decoding between formats
 */
export interface EncodedEvent {
  /** Serialized event data as binary buffer */
  buffer: Buffer
  /** Partitioning key for event streaming (typically domainId) */
  key: string
  /** Event creation timestamp in milliseconds */
  timestamp: number,
  /** Event metadata headers for routing and processing */
  headers: { [key: string]: any }
}

/**
 * Codec interface for converting between domain events and wire format.
 * 
 * EventClientCodec provides the serialization/deserialization layer between
 * EventicleEvent (domain representation) and EncodedEvent (wire representation).
 * Different implementations can provide JSON, Avro, Protocol Buffers, or custom
 * encoding schemes.
 * 
 * The codec is responsible for:
 * - Serializing event payloads and metadata
 * - Handling distributed tracing headers
 * - Version compatibility and schema evolution
 * - Compression and encryption (if needed)
 * 
 * @example
 * ```typescript
 * class CustomCodec implements EventClientCodec {
 *   async encode(event: EventicleEvent): Promise<EncodedEvent> {
 *     return {
 *       buffer: Buffer.from(JSON.stringify(event)),
 *       key: event.domainId,
 *       timestamp: event.createdAt,
 *       headers: { type: event.type, version: '1.0' }
 *     };
 *   }
 * 
 *   async decode(encoded: EncodedEvent): Promise<EventicleEvent> {
 *     return JSON.parse(encoded.buffer.toString());
 *   }
 * }
 * ```
 * 
 * @see {@link EventClientJsonCodec} For the default JSON implementation
 * @see {@link AvroCodec} For Avro-based schema evolution support
 */
export interface EventClientCodec {
  /**
   * Converts a domain event into its wire-ready encoded format.
   * 
   * @param event - The domain event to encode
   * @returns Promise resolving to the encoded event ready for transmission
   */
  encode: (event: EventicleEvent) => Promise<EncodedEvent>
  
  /**
   * Converts an encoded event back into its domain representation.
   * 
   * @param encoded - The encoded event received from the wire
   * @returns Promise resolving to the decoded domain event
   */
  decode: (encoded: EncodedEvent) => Promise<EventicleEvent>
}

/**
 * `EventClientJsonCodec` is an implementation of the `EventClientCodec` interface
 * responsible for encoding and decoding events to and from JSON format.
 * This codec helps in transforming event objects to encoded representations
 * suitable for transport or storage and back to event objects.
 *
 * The codec embeds tracing information where applicable, ensuring traceability
 * across services using traceparent headers.
 *
 * Methods:
 * - `decode(encoded: EncodedEvent): Promise<EventicleEvent>`: Converts an `EncodedEvent` object containing a JSON representation
 *   of an event back into an `EventicleEvent` object. If the encoded event contains
 *   a `traceparent` header, it is added to the resulting event object.
 *
 * - `encode(event: EventicleEvent): Promise<EncodedEvent>`: Converts an `EventicleEvent` object into an `EncodedEvent` object
 *   with a serialized JSON representation. The encoded event includes metadata such as timestamps, keys, headers, and optional
 *   traceparent information for observability.
 */
export class EventClientJsonCodec implements EventClientCodec {
  decode(encoded: EncodedEvent): Promise<EventicleEvent> {
    const addTrace = (ev: EventicleEvent) => {
      if (encoded.headers.traceparent && encoded.headers.traceparent.toString().length > 0) {
        (ev as any).apmTrace = encoded.headers.traceparent.toString();
      }
      return ev
    }

    let content = addTrace(JSON.parse(encoded.buffer.toString("utf8")))
    return Promise.resolve(content);
  }

  encode(event: EventicleEvent): Promise<EncodedEvent> {
    let traceparent
    if (event.hasOwnProperty("apmTrace")) {
      traceparent = (event as any).apmTrace
    } else {
      traceparent = getApmTraceparent()
    }

    return Promise.resolve({
      timestamp: event.createdAt,
      key: event.domainId || event.id,
      headers: {
        type: event.type,
        domainId: event.domainId || "",
        id: event.id || uuid.v4(),
        source: event.source || "",
        causedById: event.causedById || "",
        causedByType: event.causedByType || "",
        createdAt: `${event.createdAt}`,
        traceparent: traceparent || ""
      },
      buffer: Buffer.from(JSON.stringify(event), "utf8")
    });
  }
}

/**
 * Core event interface representing something that happened in the system.
 * 
 * EventicleEvent is the fundamental building block of event-driven architectures
 * in Eventicle. Events are immutable facts about state changes that occurred,
 * providing the foundation for event sourcing, CQRS, and saga coordination.
 * 
 * @template T - The type of the event payload data
 * 
 * @example Basic event
 * ```typescript
 * const userCreated: EventicleEvent<{email: string, name: string}> = {
 *   type: 'UserCreated',
 *   domainId: 'user-123',
 *   data: {
 *     email: 'john@example.com',
 *     name: 'John Doe'
 *   }
 * };
 * ```
 * 
 * @example Event with causation tracking
 * ```typescript
 * const orderShipped: EventicleEvent = {
 *   type: 'OrderShipped',
 *   domainId: 'order-456',
 *   causedById: 'payment-789',
 *   causedByType: 'PaymentProcessed',
 *   data: { trackingNumber: 'TRK123456' }
 * };
 * ```
 * 
 * Key Properties:
 * - **Immutable**: Events cannot be changed once created
 * - **Causally Linked**: Events can reference what caused them
 * - **Timestamped**: Automatic timestamp assignment
 * - **Traceable**: Support for distributed tracing
 * - **Typed**: Strong typing for event payloads
 */
export interface EventicleEvent<T = any> {
  /** Unique identifier for this event (auto-generated if not provided) */
  id?: string
  /** Event type name (e.g., 'UserCreated', 'OrderShipped') */
  type: string
  /** Source system or service that generated this event */
  source?: string
  /** ID of the event that caused this event (for causation tracking) */
  causedById?: string
  /** Type of the event that caused this event */
  causedByType?: string
  /** Event stream name (often matches aggregate type) */
  stream?: string
  /** Domain entity ID this event relates to */
  domainId?: string
  /** Event creation timestamp in milliseconds (auto-generated if not provided) */
  createdAt?: number
  /** The event payload containing the actual event data */
  data: T
}

/**
 * Control interface for managing event stream subscriptions.
 * 
 * Provides lifecycle management for active event subscriptions,
 * allowing graceful shutdown and resource cleanup.
 * 
 * @example
 * ```typescript
 * const subscription = await eventClient.hotStream({
 *   stream: 'orders',
 *   groupId: 'order-processor',
 *   handler: async (event) => {
 *     await processOrder(event);
 *   }
 * });
 * 
 * // Later, when shutting down
 * await subscription.close();
 * ```
 */
export interface EventSubscriptionControl {
  /** Closes the subscription and releases associated resources */
  close: () => Promise<void>
}

/**
 * Core interface for event streaming clients in Eventicle.
 * 
 * EventClient provides the fundamental operations for working with event streams:
 * publishing events, subscribing to streams, and replaying historical events.
 * Different implementations support various backends like Kafka, Redis, or in-memory
 * storage for development and testing.
 * 
 * Stream Types:
 * - **Hot Streams**: Only new events (live subscription)
 * - **Cold Streams**: Historical events from the beginning
 * - **Cold-Hot Streams**: Historical events followed by live subscription
 * 
 * @example Basic usage
 * ```typescript
 * // Emit events
 * await eventClient.emit([{
 *   type: 'UserCreated',
 *   domainId: 'user-123',
 *   data: { email: 'john@example.com' }
 * }], 'users');
 * 
 * // Subscribe to live events
 * const subscription = await eventClient.hotStream({
 *   stream: 'users',
 *   groupId: 'user-processor',
 *   handler: async (event) => {
 *     console.log('New user:', event.data.email);
 *   }
 * });
 * ```
 * 
 * @see {@link eventClientInMemory} For development/testing
 * @see {@link eventClientOnKafka} For production Kafka implementation
 * @see {@link eventClientOnDatastore} For PostgreSQL-backed storage
 */
export interface EventClient {
  /**
   * Publishes events to the specified stream.
   * 
   * Events are processed atomically and will be available to subscribers
   * after successful emission. The method supports both domain events
   * (EventicleEvent) and pre-encoded events (EncodedEvent).
   * 
   * @param event - Array of events to publish (domain or encoded format)
   * @param stream - Target stream name for the events
   * 
   * @example
   * ```typescript
   * await eventClient.emit([{
   *   type: 'OrderCreated',
   *   domainId: 'order-123',
   *   data: { customerId: 'cust-456', total: 99.99 }
   * }], 'orders');
   * ```
   */
  emit: (event: EventicleEvent[] | EncodedEvent[], stream: string) => Promise<void>
  /**
   * Replays historical events from the beginning of a stream.
   * 
   * Cold streams process all existing events in the stream from the start,
   * then complete. This is useful for building projections, migrating data,
   * or analyzing historical event patterns.
   * 
   * @param config - Cold stream configuration
   * @param config.stream - Stream name to replay
   * @param config.parallelEventCount - Number of events to process concurrently
   * @param config.handler - Function called for each event
   * @param config.onError - Error handler for processing failures
   * @param config.onDone - Callback when replay is complete
   * 
   * @example
   * ```typescript
   * await eventClient.coldStream({
   *   stream: 'orders',
   *   parallelEventCount: 10,
   *   handler: async (event) => {
   *     await updateProjection(event);
   *   },
   *   onError: (error) => console.error('Replay error:', error),
   *   onDone: () => console.log('Replay complete')
   * });
   * ```
   */
  coldStream: (config: {
    stream: string,
    parallelEventCount?: number,
    handler: (event: EventicleEvent) => Promise<void>,
    onError: (error: any) => void,
    onDone: () => void
  }) => Promise<EventSubscriptionControl>
  /**
   * Subscribes to live events from one or more streams.
   * 
   * Hot streams only receive new events published after the subscription
   * is established. Multiple subscribers with the same groupId will share
   * the event processing load (consumer group pattern).
   * 
   * @param config - Hot stream configuration
   * @param config.stream - Stream name(s) to subscribe to
   * @param config.groupId - Consumer group ID for load balancing
   * @param config.parallelEventCount - Concurrent event processing limit
   * @param config.handler - Function called for each new event
   * @param config.onError - Error handler for processing failures
   * 
   * @example Single stream
   * ```typescript
   * await eventClient.hotStream({
   *   stream: 'orders',
   *   groupId: 'order-processor',
   *   handler: async (event) => {
   *     await processOrder(event);
   *   },
   *   onError: (error) => console.error('Processing error:', error)
   * });
   * ```
   * 
   * @example Multiple streams
   * ```typescript
   * await eventClient.hotStream({
   *   stream: ['orders', 'payments', 'shipments'],
   *   groupId: 'fulfillment-processor',
   *   handler: async (event) => {
   *     await handleFulfillmentEvent(event);
   *   }
   * });
   * ```
   */
  hotStream: (config: {
    parallelEventCount?: number,
    stream: string | string[],
    groupId: string,
    handler: (event: EventicleEvent) => Promise<void>,
    onError: (error: any) => void,
    deleteConsumerGroupOnClose?: boolean
  }) => Promise<EventSubscriptionControl>

  /**
   * Only play hot data.
   */
  hotRawStream: (config: {
    parallelEventCount?: number,
    stream: string | string[],
    groupId: string,
    handler: (event: EncodedEvent) => Promise<void>,
    onError: (error: any) => void,
    deleteConsumerGroupOnClose?: boolean
  }) => Promise<EventSubscriptionControl>


  /**
   * Play from persisted storage the continue from in memory
   */
  coldHotStream: (config: {
    parallelEventCount?: number,
    rawEvents: true,
    stream: string | string[],
    groupId: string,
    handler: (event: EncodedEvent) => Promise<void>,
    onError: (error: any) => void
  } | {
    parallelEventCount?: number,
    rawEvents: false,
    stream: string | string[],
    groupId: string,
    handler: (event: EventicleEvent) => Promise<void>,
    onError: (error: any) => void
  } | {
    parallelEventCount?: number,
    stream: string | string[],
    groupId: string,
    handler: (event: EventicleEvent) => Promise<void>,
    onError: (error: any) => void
  }) => Promise<EventSubscriptionControl>

  shutdown: () => Promise<void>
  isConnected: () => boolean
}

let EVENT_CLIENT: EventClient
let EVENT_CODEC: EventClientCodec = new EventClientJsonCodec()

export function setEventClientCodec(cl: EventClientCodec) {
  EVENT_CODEC = cl
}

export function setEventClient(cl: EventClient) {
  EVENT_CLIENT = cl
}

export function eventClient(): EventClient {
  return EVENT_CLIENT
}

export function eventClientCodec(): EventClientCodec {
  return EVENT_CODEC
}

export function isEncodedEvent(event: EventicleEvent | EncodedEvent): event is EncodedEvent {
  return "key" in event
}
