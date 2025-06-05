import {eventClient, EventicleEvent, EventSubscriptionControl} from "../core/event-client";
import {dataStore, Record, scheduler} from "../../";
import {logger} from "@eventicle/eventicle-utilities";
import {maybeRenderError} from "@eventicle/eventicle-utilities/dist/logger-util";
import {checkSagaEventHandlers, SAGA_METRICS, startSagaInstance} from "./handlers";
import {DefaultSagaScheduler, SagaScheduler} from "./saga-scheduler";

export function getSagaMetrics() {
  return SAGA_METRICS
}

interface StartHandlerConfig<T extends EventicleEvent, Y, TimeoutNames> {
  /**
   * Only start a saga instance if this function returns true
   *
   * @param event
   */
  matches?: (event: T) => Promise<boolean>

  /**
   * Obtain a lock during the processing of this event.
   * Defaults to no lock
   */
  withLock?: (instance: SagaInstance<TimeoutNames, Y>, event: T) => string
}

interface HandlerConfig<T extends EventicleEvent, Y, TimeoutNames> {
  /**
   * Obtain a lock during the processing of this event.
   * Defaults to no lock
   */
  withLock?: (instance: SagaInstance<TimeoutNames, Y>, event: T) => string

  /**
   * Given an event, describe how to find a saga instance that can handle it.
   * @param ev
   */
  matchInstance: (ev: T) => {
    instanceProperty: keyof Y,
    value: any
  }
}

interface NotifySub {
  id?: number
  instanceId?: string
  eventType: string
  filterProp: string
  filterVal: string
}

/**
 * Represents a single running instance of a saga workflow.
 * 
 * SagaInstance contains the runtime state and execution context for a specific
 * saga execution. Each instance tracks its data, manages timers, and provides
 * methods for saga lifecycle management.
 * 
 * @template TimeoutNames - Union type of timer names this saga can schedule
 * @template T - Type of the saga's persistent data
 * 
 * @example
 * ```typescript
 * interface PaymentData {
 *   orderId: string;
 *   amount: number;
 *   attempts: number;
 * }
 * 
 * type PaymentTimers = 'timeout' | 'retry';
 * 
 * // In saga handler
 * async function handleOrderCreated(
 *   instance: SagaInstance<PaymentTimers, PaymentData>,
 *   event: OrderCreatedEvent
 * ) {
 *   instance.set('orderId', event.data.orderId);
 *   instance.set('amount', event.data.amount);
 *   instance.set('attempts', 0);
 * 
 *   // Schedule timeout
 *   instance.upsertTimer('timeout', {
 *     isCron: false,
 *     timeout: 300000 // 5 minutes
 *   });
 * }
 * ```
 * 
 * @see {@link Saga} For the saga definition
 * @see {@link SagaScheduler} For timer execution
 */
export class SagaInstance<TimeoutNames, T> {

  /** Timers pending removal in the next persistence cycle */
  readonly timersToRemove: TimeoutNames[] = []
  
  /** Timers pending addition in the next persistence cycle */
  readonly timersToAdd: {
    name: TimeoutNames, config: {
      isCron: true
      crontab: string
    } | {
      isCron: false
      timeout: number
    }
  }[] = []

  constructor(readonly internalData: any, readonly record?: Record) {
  }

  /**
   * Retrieves a piece of data from the saga instance state.
   * 
   * @param name - The key of the data to retrieve
   * @returns The value associated with the key
   * 
   * @example
   * ```typescript
   * const orderId = instance.get('orderId');
   * const attempts = instance.get('attempts');
   * ```
   */
  get<K extends keyof T>(name: K): T[K] {
    return this.internalData[name]
  }

  /**
   * Sets a piece of data in the saga instance state.
   * 
   * The value must be JSON-serializable as saga state is persisted.
   * The 'id' field is protected and cannot be modified.
   * 
   * @param name - The key to set
   * @param value - The value to store (must be JSON-serializable)
   * 
   * @throws Error if attempting to set the 'id' field
   * 
   * @example
   * ```typescript
   * instance.set('status', 'processing');
   * instance.set('retryCount', 3);
   * instance.set('lastError', { code: 'TIMEOUT', message: 'Request timed out' });
   * ```
   */
  set(name: keyof T, value: any) {
    if (name == "id") throw new Error("SETTING ID IS FORBIDDEN")
    this.internalData[name] = value
  }

  lastEvent(): EventicleEvent {
    return null
  }

  /**
   * Create (or overwrite) a timer to call. Can be either a simple timer (millis to wait), or a cron timer.
   *
   * If the timer is no longer wanted, it must be removed by calling {@see removeTimer}
   *
   * @param name The timer to call
   * @param config
   *
   * @example
   * ```
   *
   * export function sagaWithTimeouts() {
   *   return saga<"ShortTimeout" | "PollEveryDay", never>(
   *     "sagaWithTimeouts"
   *   )
   *     .subscribeStreams(["payments"])
   *     .startOn("payment.created", {}, async (instance, event) => {
   *       instance.upsertTimer("ShortTimeout", {
   *         isCron: false,
   *         timeout: 5000,    // wait for 5s and then call.
   *       });
   *       instance.upsertTimer("PollEveryDay", {
   *         isCron: true,
   *         crontab: "0 4 * * *" // will run every day at 4am
   *       });
   *     })
   *     .onTimer("ShortTimeout", async (instance) => {
   *       // this will fire 5000ms after the auction created event arrives
   *       instance.endSaga();
   *     });
   *     .onTimer("PollEveryDay", async (instance) => {
   *       // this will fire every day at 4am
   *       console.log("Running at 4am ... ")
   *     });
   * }
   * ```
   */
  upsertTimer(name: TimeoutNames, config: {
    isCron: true
    crontab: string
  } | {
    isCron: false
    timeout: number
  }) {
    this.timersToAdd.push({name, config})
  }

  removeTimer(name: TimeoutNames) {
    this.timersToRemove.push(name)
  }

  /**
   * Marks the saga instance as completed and schedules it for cleanup.
   * 
   * Once a saga is ended, it will not receive any more events or timer
   * callbacks. The instance data can optionally be preserved for debugging
   * or audit purposes.
   * 
   * @param preserveInstanceData - Whether to keep instance data after completion
   * 
   * @example
   * ```typescript
   * // End saga and clean up data
   * instance.endSaga();
   * 
   * // End saga but preserve data for audit
   * instance.endSaga(true);
   * ```
   */
  endSaga(preserveInstanceData: boolean = false) {
    this.internalData.ended = true
    this.internalData.preserveInstanceData = preserveInstanceData
  }
}

/**
 * Defines a long-running business process that coordinates across events and time.
 * 
 * Sagas implement the Saga pattern for managing complex workflows that span multiple
 * aggregates, external services, and time-based operations. They provide stateful
 * event processing with support for timers, error handling, and process coordination.
 * 
 * @template TimeoutNames - Union type of timer names this saga can schedule
 * @template InstanceData - Type of the saga's persistent state data
 * 
 * Key Features:
 * - **Stateful Processing**: Maintains state across multiple events
 * - **Timer Support**: Schedule delays and recurring operations
 * - **Error Handling**: Custom error handling and compensation logic
 * - **Event Correlation**: Match events to specific saga instances
 * - **Parallel Processing**: Configurable concurrency for high throughput
 * 
 * @example Payment processing saga
 * ```typescript
 * interface PaymentData {
 *   orderId: string;
 *   amount: number;
 *   attempts: number;
 * }
 * 
 * type PaymentTimers = 'timeout' | 'retry';
 * 
 * export function paymentSaga() {
 *   return saga<PaymentTimers, PaymentData>('PaymentSaga')
 *     .subscribeStreams(['orders', 'payments'])
 *     .startOn('OrderCreated', {}, async (instance, event) => {
 *       instance.set('orderId', event.data.orderId);
 *       instance.set('amount', event.data.amount);
 *       instance.set('attempts', 0);
 *       
 *       // Process payment
 *       await processPayment(event.data);
 *       
 *       // Set timeout
 *       instance.upsertTimer('timeout', {
 *         isCron: false,
 *         timeout: 300000 // 5 minutes
 *       });
 *     })
 *     .on('PaymentSucceeded', {
 *       matchInstance: (event) => ({
 *         instanceProperty: 'orderId',
 *         value: event.data.orderId
 *       })
 *     }, async (instance, event) => {
 *       instance.removeTimer('timeout');
 *       instance.endSaga();
 *     })
 *     .onTimer('timeout', async (instance) => {
 *       const attempts = instance.get('attempts');
 *       if (attempts < 3) {
 *         instance.set('attempts', attempts + 1);
 *         await retryPayment(instance.get('orderId'));
 *       } else {
 *         await failPayment(instance.get('orderId'));
 *         instance.endSaga();
 *       }
 *     });
 * }
 * ```
 * 
 * @see {@link SagaInstance} For instance state management
 * @see {@link registerSaga} For saga registration
 * @see {@link SagaScheduler} For advanced scheduling
 */
export class Saga<TimeoutNames, InstanceData> {

  streams: string[]
  streamSubs: EventSubscriptionControl[] = []

  parallelEventCount: number = 50

  starts: Map<string, {
    config: StartHandlerConfig<any, InstanceData, TimeoutNames>,
    handle: (saga: SagaInstance<TimeoutNames, InstanceData>, event: EventicleEvent) => Promise<void>
  }> = new Map()
  eventHandler: Map<string, {
    config: HandlerConfig<any, InstanceData, TimeoutNames>,
    handle: (saga: SagaInstance<TimeoutNames, InstanceData>, event: EventicleEvent) => Promise<void>
  }> = new Map()
  errorHandler: (saga, event: EventicleEvent, error: Error) => Promise<void> = async (saga, event, error) => {
    logger.warn("An untrapped error occurred in a saga, Eventicle trapped this event and has consumed it", {
      saga, event, message: error?.message
    })
    logger.error("Saga error", maybeRenderError(error))
  }

  timerHandler: Map<TimeoutNames, {
    handle: (saga: SagaInstance<TimeoutNames, InstanceData>) => Promise<void>
  }> = new Map

  constructor(readonly name: string) {
  }

  parallelEvents(val: number): Saga<TimeoutNames, InstanceData> {
    this.parallelEventCount = val
    return this
  }

  subscribeStreams(streams: string[]): Saga<TimeoutNames, InstanceData> {
    this.streams = streams
    return this
  }

  /**
   * Register a handler for a timer triggered saga step.
   *
   * This will be called on the timer.
   *
   * No event is present.
   *
   * @param name The name of the timer
   * @param handle the async function to execute.
   */
  onTimer(name: TimeoutNames, handle: (saga: SagaInstance<TimeoutNames, InstanceData>) => Promise<void>): Saga<TimeoutNames, InstanceData> {
    this.timerHandler.set(name, {handle})
    return this
  }

  /**
   * Registers an event handler that can start new saga instances.
   * 
   * When the specified event type is received and no existing saga instance
   * matches, a new saga instance will be created and the handler called.
   * Only one startOn handler per event type is allowed.
   * 
   * @param eventName - The event type that can start new saga instances
   * @param config - Configuration for instance creation
   * @param handler - The function to execute when starting a new instance
   * 
   * @example
   * ```typescript
   * saga.startOn('OrderCreated', {
   *   matches: async (event) => event.data.requiresPayment,
   *   withLock: (instance, event) => `payment-${event.data.orderId}`
   * }, async (instance, event) => {
   *   instance.set('orderId', event.data.orderId);
   *   await initiatePayment(event.data);
   * });
   * ```
   */
  startOn<T extends EventicleEvent>(eventName: string, config: StartHandlerConfig<T, InstanceData, TimeoutNames>, handler: (saga: SagaInstance<TimeoutNames, InstanceData>, event: T) => Promise<void>): Saga<TimeoutNames, InstanceData> {
    if (this.starts.has(eventName)) {
      throw new Error(`Event has been double registered in Saga startsOn ${this.name}: ${eventName}`)
    }
    this.starts.set(eventName, {config, handle: handler})
    return this
  }

  /**
   * Registers an event handler for existing saga instances.
   * 
   * When the specified event type is received, the handler will be called
   * on any existing saga instances that match the event based on the
   * matchInstance configuration.
   * 
   * @param eventName - The event type to handle
   * @param config - Configuration for instance matching and locking
   * @param handler - The function to execute for matching instances
   * 
   * @example
   * ```typescript
   * saga.on('PaymentCompleted', {
   *   matchInstance: (event) => ({
   *     instanceProperty: 'orderId',
   *     value: event.data.orderId
   *   }),
   *   withLock: (instance, event) => `payment-${event.data.orderId}`
   * }, async (instance, event) => {
   *   instance.set('paymentId', event.data.paymentId);
   *   instance.removeTimer('timeout');
   *   await completeOrder(instance.get('orderId'));
   *   instance.endSaga();
   * });
   * ```
   */
  on<T extends EventicleEvent>(eventName: string, config: HandlerConfig<T, InstanceData, TimeoutNames>, handler: (saga: SagaInstance<TimeoutNames, InstanceData>, event: T) => Promise<void>): Saga<TimeoutNames, InstanceData> {
    if (this.eventHandler.has(eventName)) {
      throw new Error(`Event has been double registered in Saga.on ${this.name}: ${eventName}`)
    }
    this.eventHandler.set(eventName, {config, handle: handler})
    return this
  }

  onError(handler: (saga, event: EventicleEvent, error: Error) => Promise<void>): Saga<TimeoutNames, InstanceData> {
    this.errorHandler = handler
    return this
  }
}

export const SAGAS: Saga<any, any>[] = []

export async function removeAllSagas(): Promise<void> {

  SAGAS.forEach(value => {
    logger.info("REMOVING ALL SAGAS NOW: " + value.name, value.streamSubs.length)
    value.streamSubs.forEach(sub => sub.close())

  })
  SAGAS.length = 0
}

export let sagaScheduler: SagaScheduler = new DefaultSagaScheduler()

export function setSagaScheduler(scheduler: SagaScheduler) {
  sagaScheduler = scheduler
}



export async function registerSaga<TimeoutNames, Y>(saga: Saga<TimeoutNames, Y>): Promise<EventSubscriptionControl> {

  SAGAS.push(saga)

  await scheduler().addScheduleTaskListener(saga.name, async (name, id, data) => sagaScheduler.handleTimer(saga, name, data))

  let control = await eventClient().hotStream({
    stream: saga.streams,
    groupId: `saga-${saga.name}`,
    handler: async (event: EventicleEvent) => {
      logger.debug(`Saga event: ${saga.name}`, event)

      const timeoutTimer = setTimeout(() => {
        logger.warn("Saga processing step is taking an excessive amount of time, check for promise errors ", {
          saga: saga.name,
          event
        })
      }, 60000)

      // await dataStore().transaction(async () => {
      try {
        logger.debug(`  Saga handling notify intents: ${saga.name} :: ` + event.type)
        if (saga.eventHandler.has(event.type)) {
          logger.debug(`      saga can handle event: ${saga.name} :: ` + event.type)
          await checkSagaEventHandlers(saga, event)
          logger.debug(`      done intents: ${saga.name} :: ` + event.type)
        } else if (saga.starts.has(event.type)) {
          logger.debug(`      saga can start: ${saga.name} :: ` + event.type)
          await startSagaInstance(saga, event)
        }
        logger.debug(`  Saga processed: ${saga.name} :: ` + event.type)
      } catch (e) {
        await saga.errorHandler(saga, event, e)
      } finally {
        clearTimeout(timeoutTimer)
      }
      // }, {
      //   propagation: "requires"
      // })
    }, onError: error => {
      logger.error("Error subscribing to streams", {
        error, saga: saga.name
      })
    },
    parallelEventCount: saga.parallelEventCount
  });

  saga.streamSubs.push(control);

  return control;
}

export async function allSagaInstances(workspaceId?: string): Promise<SagaInstance<any, any>[]> {
  if (!workspaceId) workspaceId = "system"
  let ret = (await dataStore().findEntity(workspaceId, "saga-instance", {}, {}))

  if (!ret) return []
  return ret.map(value => new SagaInstance(value.content))
}

export async function allSagas(): Promise<Saga<any, any>[]> {
  return SAGAS
}


export function saga<TimeoutNames, SagaInstanceData>(name: string): Saga<TimeoutNames, SagaInstanceData> {
  return new Saga<TimeoutNames, SagaInstanceData>(name)
}
