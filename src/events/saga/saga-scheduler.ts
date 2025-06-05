import {EventicleEvent} from "../core/event-client";
import {Saga} from "./index";
import {handleTimerEvent, sagaHandleEvent} from "./handlers";

/**
 * Interface for advanced saga event and timer scheduling with serialization guarantees.
 * 
 * SagaScheduler provides enhanced control over saga execution by ensuring that
 * events and timers for the same saga instance are processed serially, preventing
 * race conditions in complex workflows. This is particularly important when using
 * distributed systems where multiple workers might process events concurrently.
 * 
 * Key Benefits:
 * - **Serialization**: Events and timers for the same instance are processed in order
 * - **Race Prevention**: Eliminates concurrent access to saga instance state
 * - **Consistency**: Guarantees saga state remains consistent under load
 * - **Scalability**: Allows horizontal scaling while maintaining correctness
 * 
 * @example BullMQ-based scheduler with serialization
 * ```typescript
 * export class BullMQSagaScheduler implements SagaScheduler {
 *   private queue: QueuePro;
 *   private worker: WorkerPro;
 * 
 *   async sagaHandleEvent(saga: Saga<any, any>, event: EventicleEvent, instanceId: string) {
 *     // Queue event with instance-specific group for serialization
 *     await this.queue.add('saga-event', {
 *       sagaName: saga.name,
 *       event,
 *       instanceId
 *     }, {
 *       group: { id: instanceId } // Ensures serialization per instance
 *     });
 *   }
 * 
 *   async handleTimer(saga: Saga<any, any>, name: string, data: { instanceId: string }) {
 *     // Queue timer with same group as events for serialization
 *     await this.queue.add('saga-timer', {
 *       sagaName: saga.name,
 *       timerName: name,
 *       instanceId: data.instanceId
 *     }, {
 *       group: { id: data.instanceId } // Same group ensures order
 *     });
 *   }
 * }
 * ```
 * 
 * @see {@link DefaultSagaScheduler} For simple pass-through implementation
 * @see {@link setSagaScheduler} For configuration
 */
export interface SagaScheduler {
  /**
   * Schedules saga event processing with serialization guarantees.
   * 
   * This method should ensure that events for the same saga instance
   * are processed in the order they were received, preventing race
   * conditions between concurrent event handlers.
   * 
   * @param saga - The saga definition
   * @param event - The event to process
   * @param instanceId - The unique saga instance identifier
   * 
   * @example
   * ```typescript
   * // Events will be processed serially for instance 'payment-123'
   * await scheduler.sagaHandleEvent(paymentSaga, orderCreatedEvent, 'payment-123');
   * await scheduler.sagaHandleEvent(paymentSaga, paymentProcessedEvent, 'payment-123');
   * ```
   */
  sagaHandleEvent(saga: Saga<any, any>, event: EventicleEvent, instanceId: string): Promise<void>
  
  /**
   * Schedules saga timer execution with serialization guarantees.
   * 
   * Timer execution should be serialized with event processing for the
   * same saga instance to prevent race conditions between timer callbacks
   * and event handlers.
   * 
   * @param saga - The saga definition
   * @param name - The timer name to execute
   * @param data - Timer execution data including instance ID
   * 
   * @example
   * ```typescript
   * // Timer will be processed serially with events for instance 'payment-123'
   * await scheduler.handleTimer(paymentSaga, 'timeout', { instanceId: 'payment-123' });
   * ```
   */
  handleTimer(saga: Saga<any, any>, name: string, data: { instanceId: string }): Promise<void>
}

/**
 * Default saga scheduler that executes events and timers immediately.
 * 
 * This implementation provides no serialization guarantees and is suitable
 * for development, testing, or single-instance deployments where race
 * conditions are not a concern.
 * 
 * For production systems with multiple workers or complex saga workflows,
 * consider using a more sophisticated scheduler implementation that provides
 * serialization guarantees.
 * 
 * @example
 * ```typescript
 * // Default scheduler (no serialization)
 * setSagaScheduler(new DefaultSagaScheduler());
 * 
 * // Custom scheduler with serialization
 * setSagaScheduler(new BullMQSagaScheduler(redisConfig));
 * ```
 * 
 * @see {@link SagaScheduler} For the interface contract
 * @see {@link setSagaScheduler} For configuration
 */
export class DefaultSagaScheduler implements SagaScheduler {
  sagaHandleEvent(saga: Saga<any, any>, event: EventicleEvent, instanceId: string): Promise<void> {
    return sagaHandleEvent(saga, event, instanceId)
  }

  handleTimer(saga: Saga<any, any>, name: string, data: { instanceId: string }): Promise<void> {
    return handleTimerEvent(saga, name, data);
  }
}
