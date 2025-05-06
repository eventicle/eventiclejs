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
 * The data for a single execution of a {@link Saga}
 *
 * Sagas are stateful concepts, and this type contains the state.
 */
export class SagaInstance<TimeoutNames, T> {

  /**
   * Private instance data
   */
  readonly timersToRemove: TimeoutNames[] = []
  /**
   * Private instance data
   */
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
   * Get a piece of arbitrary data from the saga instance
   * @param name THe key
   */
  get<K extends keyof T>(name: K): T[K] {
    return this.internalData[name]
  }

  /**
   * Set a piece of arbitrary data into the saga instance
   * @param name The key
   * @param value the value. Must be able to encode to JSON.
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

  endSaga(preserveInstanceData: boolean = false) {
    this.internalData.ended = true
    this.internalData.preserveInstanceData = preserveInstanceData
  }
}

/**
 * A saga!
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

  startOn<T extends EventicleEvent>(eventName: string, config: StartHandlerConfig<T, InstanceData, TimeoutNames>, handler: (saga: SagaInstance<TimeoutNames, InstanceData>, event: T) => Promise<void>): Saga<TimeoutNames, InstanceData> {
    if (this.starts.has(eventName)) {
      throw new Error(`Event has been double registered in Saga startsOn ${this.name}: ${eventName}`)
    }
    this.starts.set(eventName, {config, handle: handler})
    return this
  }

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
