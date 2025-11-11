import {
  EncodedEvent,
  eventClient,
  EventicleEvent,
  EventSubscriptionControl,
} from "../core/event-client";
import { logger } from "@eventicle/eventicle-utilities";
import { dataStore } from "../../";
import { RawEventView } from "../view";

let viewControls = {} as {
  [key: string]: EventSubscriptionControl;
};

let metrics = {} as any;

function updateLatency(view: EventAdapter, event: EventicleEvent) {
  if (!metrics.hasOwnProperty(view.name)) {
    metrics[view.name] = { latest: 0 };
  }
  if (!metrics[view.name].hasOwnProperty(event.type)) {
    metrics[view.name][event.type] = 0;
  }
  metrics[view.name][event.type] = new Date().getTime() - event.createdAt;
  metrics[view.name].latest = new Date().getTime() - event.createdAt;
}

function updateRawLatency(view: RawEventView, event: EncodedEvent) {
  if (!metrics.hasOwnProperty(view.consumerGroup)) {
    metrics[view.consumerGroup] = { latest: 0 };
  }
  metrics[view.consumerGroup].latest = new Date().getTime() - event.timestamp;
}

export function getAdapterMetrics() {
  return metrics;
}

export async function shutdownAllAdapters(): Promise<void> {
  logger.debug("Shutting down all adapters", Object.keys(viewControls));
  await Promise.all(
    Object.values(viewControls).map(control => control.close())
  );
  logger.debug("All adapters shut down");
}

/**
 * This will connect the given EventAdapter to event streams.
 *
 * An EventAdapter is a `hot` subscription, and will receive events emitted after
 * it first connects.
 *
 * If it is offline for a period, the backing event store (eg, Kafka) will allow the adapter
 * to reconnect and pick up from where it had previous processed up to.
 *
 * @param adapter
 */
export async function registerAdapter(
  adapter: EventAdapter
): Promise<EventSubscriptionControl> {
  if (!adapter.errorHandler) {
    adapter.errorHandler = async (adapter, event, error) => {
      logger.warn(
        "An unhandled Error was emitted by an adapter. Eventicle trapped this event and has consumed it",
        {
          adapter: adapter.name,
          event,
          error,
        }
      );
    };
  }

  let control = await eventClient().hotStream({
    stream: adapter.streamsToSubscribe,
    onError: (error) => {
      logger.error("Error in adapter", error);
    },
    groupId: adapter.consumerGroup,
    deleteConsumerGroupOnClose: adapter.deleteConsumerGroupOnClose,
    handler: async (event) => {
      await dataStore()
        .transaction(async () => {
          await adapter.handleEvent(event);
          updateLatency(adapter, event);
        })
        .catch((reason) => {
          adapter.errorHandler(adapter, event, reason);
        });
    },
  });

  viewControls[adapter.consumerGroup] = control;

  logger.debug("Added view to the controls", viewControls);

  return control;
}

export async function registerRawAdapter(
  view: RawEventAdapter
): Promise<EventSubscriptionControl> {
  if (!view.errorHandler) {
    view.errorHandler = async (adapter, event, error) => {
      logger.warn(
        "An unhandled Error was emitted by an adapter. Eventicle trapped this event and has consumed it",
        {
          adapter: view.name,
          event,
          error,
        }
      );
    };
  }

  let control = await eventClient().hotRawStream({
    stream: view.streamsToSubscribe,
    groupId: view.consumerGroup,
    deleteConsumerGroupOnClose: view.deleteConsumerGroupOnClose,
    handler: async (event) => {
      await dataStore()
        .transaction(async () => {
          await view.handleEvent(event);
          updateRawLatency(view, event);
        })
        .catch((reason) => {
          view.errorHandler(view, event, reason);
        });
    },
    onError: (error) => {
      logger.error("Error in adapter", error);
    }
  });

  viewControls[view.consumerGroup] = control;

  logger.debug("Added view to the controls", viewControls);

  return control;
}

/**
 * Defines an event adapter for real-time event processing and integration.
 * 
 * EventAdapter provides a hot-subscription pattern for processing live events as they
 * occur, without replaying historical data. Unlike EventView which processes both
 * historical and live events, adapters focus on real-time integration scenarios
 * like external system synchronization, notifications, and live data feeds.
 * 
 * Key Characteristics:
 * - **Hot Subscription Only**: Processes new events, never replays history
 * - **External Integration**: Designed for pushing data to external systems
 * - **Transactional**: Each event is processed within a database transaction
 * - **Error Handling**: Built-in error recovery and monitoring
 * - **Consumer Groups**: Supports load balancing across multiple instances
 * 
 * @example External system synchronization
 * ```typescript
 * const crmSyncAdapter: EventAdapter = {
 *   name: 'crm-synchronizer',
 *   consumerGroup: 'crm-sync',
 *   streamsToSubscribe: ['users', 'contacts'],
 *   
 *   handleEvent: async (event) => {
 *     switch (event.type) {
 *       case 'UserCreated':
 *         await crmClient.createContact({
 *           externalId: event.domainId,
 *           email: event.data.email,
 *           name: event.data.name,
 *           source: 'app'
 *         });
 *         break;
 *         
 *       case 'UserUpdated':
 *         await crmClient.updateContact(event.domainId, {
 *           email: event.data.email,
 *           name: event.data.name
 *         });
 *         break;
 *     }
 *   },
 *   
 *   errorHandler: async (adapter, event, error) => {
 *     await errorTracking.report({
 *       adapter: adapter.name,
 *       eventType: event.type,
 *       eventId: event.id,
 *       error: error.message,
 *       timestamp: new Date()
 *     });
 *   }
 * };
 * 
 * await registerAdapter(crmSyncAdapter);
 * ```
 * 
 * @example Real-time notifications
 * ```typescript
 * const notificationAdapter: EventAdapter = {
 *   name: 'push-notifications',
 *   consumerGroup: 'notifications',
 *   streamsToSubscribe: ['orders', 'payments'],
 *   
 *   handleEvent: async (event) => {
 *     const userId = event.data.userId || event.data.customerId;
 *     if (!userId) return;
 *     
 *     let message: string;
 *     switch (event.type) {
 *       case 'OrderShipped':
 *         message = `Your order ${event.data.orderNumber} has been shipped!`;
 *         break;
 *       case 'PaymentFailed':
 *         message = 'Payment failed. Please update your payment method.';
 *         break;
 *       default:
 *         return;
 *     }
 *     
 *     await pushNotificationService.send(userId, {
 *       title: 'Order Update',
 *       message,
 *       data: { eventId: event.id, type: event.type }
 *     });
 *   }
 * };
 * ```
 * 
 * @see {@link registerAdapter} For adapter registration
 * @see {@link EventView} For read-model projections with history replay
 * @see {@link RawEventAdapter} For binary event processing
 */
export interface EventAdapter {
  /** 
   * Unique adapter identifier for monitoring and debugging.
   * 
   * Should be descriptive of the adapter's purpose (e.g., 'crm-sync', 'email-notifications').
   */
  name: string;
  
  /** 
   * Consumer group identifier for load balancing and failure recovery.
   * 
   * Multiple adapter instances with the same consumer group will share event
   * processing, enabling horizontal scaling and fault tolerance.
   */
  consumerGroup: string;
  
  /** 
   * Event processing function called for each live event.
   * 
   * Should be idempotent as events may be redelivered during failures.
   * Typically integrates with external systems or triggers side effects.
   * 
   * @param event - The domain event to process
   */
  handleEvent: (event: EventicleEvent) => Promise<void>;
  
  /**
   * List of event streams to monitor for live events.
   *
   * Adapter will receive all new events from these streams. Use specific
   * stream names to reduce noise and improve performance.
   */
  streamsToSubscribe: string[];

  /**
   * When true, deletes the Kafka consumer group when the adapter is closed.
   *
   * Useful for ephemeral adapters with dynamic consumer groups (e.g., UUID-based)
   * to prevent accumulation of stale consumer groups in Kafka.
   */
  deleteConsumerGroupOnClose?: boolean;

  /**
   * Optional custom error handler for event processing failures.
   * 
   * If not provided, a default handler logs the error and continues processing.
   * Use this for custom error reporting, retry logic, or dead letter queues.
   * 
   * @param adapter - The adapter that encountered the error
   * @param event - The event that failed to process
   * @param error - The error that occurred
   */
  errorHandler?: (
    adapter: EventAdapter,
    event: EventicleEvent,
    error: Error
  ) => Promise<void>;
}

/**
 * Defines an adapter for processing live events in their raw, encoded format.
 * 
 * RawEventAdapter enables real-time processing of events without decoding overhead,
 * ideal for high-performance scenarios, binary forwarding, or custom encoding schemes.
 * Like EventAdapter, it only processes live events without historical replay.
 * 
 * Use Cases:
 * - **High-Throughput Processing**: Minimize latency by avoiding decode operations
 * - **Binary Event Forwarding**: Route events to external systems without modification
 * - **Custom Encoding**: Implement specialized decoding or transformation logic
 * - **Performance-Critical Integrations**: Real-time data feeds with minimal overhead
 * 
 * @example High-performance event streaming
 * ```typescript
 * const streamingAdapter: RawEventAdapter = {
 *   name: 'real-time-stream',
 *   consumerGroup: 'streaming-service',
 *   streamsToSubscribe: ['high-frequency-events'],
 *   
 *   handleEvent: async (encodedEvent) => {
 *     // Forward raw event to WebSocket clients
 *     await websocketServer.broadcast({
 *       eventType: encodedEvent.headers.type,
 *       timestamp: encodedEvent.timestamp,
 *       data: encodedEvent.buffer
 *     });
 *   },
 *   
 *   errorHandler: async (adapter, event, error) => {
 *     metrics.increment('streaming.errors', {
 *       adapter: adapter.name,
 *       eventType: event.headers.type
 *     });
 *   }
 * };
 * 
 * await registerRawAdapter(streamingAdapter);
 * ```
 * 
 * @see {@link registerRawAdapter} For adapter registration
 * @see {@link EventAdapter} For decoded event processing
 * @see {@link EncodedEvent} For raw event structure
 */
export interface RawEventAdapter {
  /** 
   * Unique adapter identifier for monitoring and debugging.
   * 
   * Should be descriptive of the adapter's purpose (e.g., 'binary-forwarder', 'raw-analytics').
   */
  name: string;
  
  /** 
   * Consumer group identifier for load balancing and failure recovery.
   * 
   * Multiple adapter instances with the same consumer group will share event
   * processing, enabling horizontal scaling and fault tolerance.
   */
  consumerGroup: string;
  
  /** 
   * Raw event processing function called for each live encoded event.
   * 
   * Receives events in their binary format without decoding. Should be idempotent
   * as events may be redelivered during failures.
   * 
   * @param event - The encoded event with buffer and metadata
   */
  handleEvent: (event: EncodedEvent) => Promise<void>;
  
  /**
   * List of event streams to monitor for live events.
   *
   * Adapter will receive all new raw events from these streams. Consider the
   * performance implications of subscribing to high-volume streams.
   */
  streamsToSubscribe: string[];

  /**
   * When true, deletes the Kafka consumer group when the adapter is closed.
   *
   * Useful for ephemeral adapters with dynamic consumer groups (e.g., UUID-based)
   * to prevent accumulation of stale consumer groups in Kafka.
   */
  deleteConsumerGroupOnClose?: boolean;

  /**
   * Optional custom error handler for event processing failures.
   * 
   * If not provided, a default handler logs the error and continues processing.
   * Use this for custom error reporting, retry logic, or dead letter queues.
   * 
   * @param adapter - The adapter that encountered the error
   * @param event - The encoded event that failed to process
   * @param error - The error that occurred
   */
  errorHandler?: (
    adapter: RawEventAdapter,
    event: EncodedEvent,
    error: Error
  ) => Promise<void>;
}
