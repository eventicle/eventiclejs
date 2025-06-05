import {
  EncodedEvent,
  eventClient,
  EventicleEvent,
  EventSubscriptionControl,
} from "../core/event-client";
import { getAPM, logger, withAPM } from "@eventicle/eventicle-utilities";
import { apmJoinEvent } from "../../apm";

let viewControls = {} as {
  [key: string]: EventSubscriptionControl;
};

let metrics = {} as any;

function updateRawLatency(view: RawEventView, event: EncodedEvent) {
  if (!metrics.hasOwnProperty(view.consumerGroup)) {
    metrics[view.consumerGroup] = { latest: 0 };
  }
  metrics[view.consumerGroup].latest = new Date().getTime() - event.timestamp;
}

function updateViewLatency(view: EventView, event: EventicleEvent) {
  if (!metrics.hasOwnProperty(view.consumerGroup)) {
    metrics[view.consumerGroup] = { latest: 0 };
  }
  if (!metrics[view.consumerGroup].hasOwnProperty(event.type)) {
    metrics[view.consumerGroup][event.type] = 0;
  }
  metrics[view.consumerGroup][event.type] =
    new Date().getTime() - event.createdAt;
  metrics[view.consumerGroup].latest = new Date().getTime() - event.createdAt;
}

export function getViewMetrics() {
  return metrics;
}

export async function registerView(
  view: EventView
): Promise<EventSubscriptionControl> {
  let control = await eventClient().coldHotStream({
    parallelEventCount: view.parallelEventCount,
    handler: async (event) => {
      apmJoinEvent(
        event,
        view.consumerGroup + ":" + event.type,
        "view-handle-" + view.consumerGroup,
        event.type
      );
      try {
        await view.handleEvent(event);
      } finally {
        updateViewLatency(view, event);
        await withAPM(async (apm) => apm.endTransaction());
      }
    },
    onError: (error) => {
      logger.error("Error in view", error);
    },
    groupId: view.consumerGroup,
    stream: view.streamsToSubscribe,
  });

  viewControls[view.consumerGroup] = control;

  logger.debug("Added view to the controls", viewControls);

  return control;
}

/**
 * Will register a raw event view
 *
 * This subscribes it to the appropriate event streams. For every event received, handeEvent will be called.
 *
 * Events are not processed through the {@link EventClientCodec}, and so are observed encoded as an {@link EncodedEvent}
 *
 * This can be useful if you want to persist the event in a raw form, as a binary encoded stream.
 *
 * @param view The View to subscribe to event streams
 */
export async function registerRawView(
  view: RawEventView
): Promise<EventSubscriptionControl> {
  let control = await eventClient().coldHotStream({
    rawEvents: true,
    handler: async (event) => {
      await view.handleEvent(event);
      updateRawLatency(view, event);
    },
    onError: (error) => {
      logger.error("Error in view", error);
    },
    groupId: view.consumerGroup,
    stream: view.streamsToSubscribe,
  });

  viewControls[view.consumerGroup] = control;

  logger.debug("Added view to the controls", viewControls);

  return control;
}

/**
 * Defines an event view for building read-side projections in CQRS architectures.
 * 
 * EventView implements the "Q" (Query) side of CQRS, processing domain events to build
 * optimized read models, projections, and materialized views. Views enable efficient
 * querying by maintaining denormalized data structures tailored for specific read patterns.
 * 
 * Key Features:
 * - **Event Processing**: Handles events from multiple streams
 * - **Consumer Groups**: Enables load balancing across multiple instances
 * - **Parallel Processing**: Configurable concurrency for high throughput
 * - **Cold/Hot Replay**: Processes historical events then continues with live events
 * - **Error Handling**: Built-in error recovery and monitoring
 * 
 * @example User profile projection
 * ```typescript
 * const userProfileView: EventView = {
 *   consumerGroup: 'user-profile-projection',
 *   parallelEventCount: 10,
 *   streamsToSubscribe: ['users', 'preferences'],
 *   
 *   handleEvent: async (event) => {
 *     switch (event.type) {
 *       case 'UserCreated':
 *         await db.userProfiles.create({
 *           userId: event.domainId,
 *           email: event.data.email,
 *           name: event.data.name,
 *           createdAt: new Date(event.createdAt)
 *         });
 *         break;
 *         
 *       case 'UserProfileUpdated':
 *         await db.userProfiles.update(
 *           { userId: event.domainId },
 *           { name: event.data.name }
 *         );
 *         break;
 *         
 *       case 'PreferenceSet':
 *         await db.userProfiles.update(
 *           { userId: event.data.userId },
 *           { preferences: event.data.preferences }
 *         );
 *         break;
 *     }
 *   }
 * };
 * 
 * await registerView(userProfileView);
 * ```
 * 
 * @example Analytics aggregation
 * ```typescript
 * const analyticsView: EventView = {
 *   consumerGroup: 'analytics-aggregator',
 *   parallelEventCount: 20,
 *   streamsToSubscribe: ['orders', 'payments', 'shipments'],
 *   
 *   handleEvent: async (event) => {
 *     switch (event.type) {
 *       case 'OrderCreated':
 *         await updateDailyMetrics('orders_created', event.createdAt);
 *         await updateCustomerMetrics(event.data.customerId, 'order_count');
 *         break;
 *         
 *       case 'PaymentProcessed':
 *         await updateDailyMetrics('revenue', event.createdAt, event.data.amount);
 *         await updateCustomerMetrics(event.data.customerId, 'total_spent', event.data.amount);
 *         break;
 *     }
 *   }
 * };
 * ```
 * 
 * @see {@link registerView} For view registration
 * @see {@link RawEventView} For binary event processing
 * @see {@link EventicleEvent} For event structure
 */
export interface EventView {
  /** 
   * Number of events to process concurrently (default varies by implementation).
   * 
   * Higher values increase throughput but may impact memory usage and database
   * connection pools. Tune based on your processing requirements.
   */
  parallelEventCount?: number,
  
  /** 
   * Unique consumer group identifier for load balancing.
   * 
   * Multiple view instances with the same consumer group will share event
   * processing, enabling horizontal scaling and fault tolerance.
   */
  consumerGroup: string;
  
  /** 
   * Event processing function called for each received event.
   * 
   * Should be idempotent as events may be redelivered during failures.
   * Typically updates read models, projections, or external systems.
   * 
   * @param event - The domain event to process
   */
  handleEvent: (event: EventicleEvent) => Promise<void>;
  
  /** 
   * List of event streams to subscribe to.
   * 
   * View will receive all events from these streams. Use specific stream
   * names to reduce processing overhead and improve performance.
   */
  streamsToSubscribe: string[];
}

/**
 * Defines a view for processing events in their raw, encoded format.
 * 
 * RawEventView enables processing events without decoding them into domain objects,
 * which is useful for scenarios requiring high performance, binary storage, or
 * custom encoding schemes. Events are processed as EncodedEvent objects containing
 * the raw buffer and metadata headers.
 * 
 * Use Cases:
 * - **High Performance**: Avoid decoding overhead for throughput-sensitive scenarios
 * - **Binary Storage**: Store events in their original encoded format
 * - **Custom Processing**: Implement custom decoding or transformation logic
 * - **Event Forwarding**: Route events to external systems without modification
 * - **Audit Trails**: Preserve exact event format for compliance requirements
 * 
 * @example Binary event archival
 * ```typescript
 * const eventArchiveView: RawEventView = {
 *   consumerGroup: 'event-archiver',
 *   streamsToSubscribe: ['users', 'orders', 'payments'],
 *   
 *   handleEvent: async (encodedEvent) => {
 *     // Store raw event data with metadata
 *     await archiveStorage.store({
 *       eventId: encodedEvent.headers.id,
 *       eventType: encodedEvent.headers.type,
 *       timestamp: encodedEvent.timestamp,
 *       rawData: encodedEvent.buffer,
 *       headers: encodedEvent.headers
 *     });
 *   }
 * };
 * 
 * await registerRawView(eventArchiveView);
 * ```
 * 
 * @example High-performance event forwarding
 * ```typescript
 * const eventForwarder: RawEventView = {
 *   consumerGroup: 'external-forwarder',
 *   streamsToSubscribe: ['public-events'],
 *   
 *   handleEvent: async (encodedEvent) => {
 *     // Forward to external webhook without decoding
 *     await httpClient.post('/webhook', {
 *       headers: {
 *         'Content-Type': 'application/octet-stream',
 *         'X-Event-Type': encodedEvent.headers.type,
 *         'X-Event-Id': encodedEvent.headers.id
 *       },
 *       body: encodedEvent.buffer
 *     });
 *   }
 * };
 * ```
 * 
 * @see {@link registerRawView} For view registration
 * @see {@link EventView} For decoded event processing
 * @see {@link EncodedEvent} For raw event structure
 */
export interface RawEventView {
  /** 
   * Unique consumer group identifier for load balancing.
   * 
   * Multiple raw view instances with the same consumer group will share event
   * processing, enabling horizontal scaling and fault tolerance.
   */
  consumerGroup: string;
  
  /** 
   * Raw event processing function called for each received encoded event.
   * 
   * Receives events in their binary format without decoding. Use this for
   * high-performance scenarios or when you need access to the raw event data.
   * 
   * @param event - The encoded event with buffer and metadata
   */
  handleEvent: (event: EncodedEvent) => Promise<void>;
  
  /** 
   * List of event streams to subscribe to.
   * 
   * View will receive all raw events from these streams. Consider the
   * performance implications of subscribing to high-volume streams.
   */
  streamsToSubscribe: string[];
}
