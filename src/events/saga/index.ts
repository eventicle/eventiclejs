import {eventClient, EventicleEvent, EventSubscriptionControl} from "../core/event-client";
import {dataStore, Record, scheduler} from "../../";
import {getAPM, logger, span, withAPM} from "@eventicle/eventicle-utilities";
import {apmJoinEvent} from "../../apm";
import {lockManager} from "../../";
import uuid = require("uuid");
import {values} from "lodash";
import {maybeRenderError} from "@eventicle/eventicle-utilities/dist/logger-util";

let metrics = {} as any

function updateLatency(view: Saga<any, any>, event: EventicleEvent) {
  if (!metrics.hasOwnProperty(view.name)) {
    metrics[view.name] = {latest: 0}
  }
  if (!metrics[view.name].hasOwnProperty(event.type)) {
    metrics[view.name][event.type] = 0
  }
  metrics[view.name][event.type] = new Date().getTime() - event.createdAt
  metrics[view.name].latest = new Date().getTime() - event.createdAt
}

export function getSagaMetrics() {
  return metrics
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

export class SagaInstance<TimeoutNames, T> {

  readonly timersToRemove: TimeoutNames[] = []
  readonly timersToAdd: {
    name: TimeoutNames, config: {
      isCron: true
      crontab: string
    } | {
      isCron: false
      timeout: number
    }
  }[] = []

  constructor(readonly internalData: any, readonly record?: Record) {}

  get(name: keyof T): any {
    return this.internalData[name]
  }

  set(name: keyof T, value: any) {
    if (name == "id") throw new Error("SETTING ID IS FORBIDDEN")
    this.internalData[name] = value
  }

  lastEvent(): EventicleEvent {
    return null
  }

  upsertTimer(name: TimeoutNames, config: {
    isCron: true
    crontab: string
  } | {
    isCron: false
    timeout: number
  }) {
    this.timersToAdd.push({ name, config })
  }

  removeTimer(name: TimeoutNames) {
    this.timersToRemove.push(name)
  }

  endSaga(preserveInstanceData: boolean = false) {
    this.internalData.ended = true
    this.internalData.preserveInstanceData = preserveInstanceData
  }
}

export class Saga<TimeoutNames, InstanceData> {

  streams: string[]
  streamSubs: EventSubscriptionControl[] = []

  starts: Map<string, { config: StartHandlerConfig<any, InstanceData, TimeoutNames>, handle: (saga: SagaInstance<TimeoutNames, InstanceData>, event: EventicleEvent) => Promise<void> }> = new Map()
  eventHandler: Map<string, { config: HandlerConfig< any, InstanceData, TimeoutNames>, handle: (saga: SagaInstance<TimeoutNames, InstanceData>, event: EventicleEvent) => Promise<void> }> = new Map()
  errorHandler: (saga, event: EventicleEvent, error: Error) => Promise<void> = async (saga, event, error) => {
    logger.warn("An untrapped error occurred in a saga, Eventicle trapped this event and has consumed it", {
      saga, event
    })
    logger.error("Saga error", maybeRenderError(error))
  }

  timerHandler: Map<TimeoutNames, { handle: (saga: SagaInstance<TimeoutNames, InstanceData>) => Promise<void> }> = new Map

  constructor(readonly name: string) {
  }

  subscribeStreams(streams: string[]): Saga<TimeoutNames, InstanceData> {
    this.streams = streams
    return this
  }

  onTimer(name: TimeoutNames, handle: (saga: SagaInstance<TimeoutNames, InstanceData>) => Promise<void>): Saga<TimeoutNames, InstanceData> {
    this.timerHandler.set(name, { handle })
    return this
  }

  startOn<T extends EventicleEvent>(eventName: string, config: StartHandlerConfig<T, InstanceData, TimeoutNames>, handler: (saga: SagaInstance<TimeoutNames, InstanceData>, event: T) => Promise<void>): Saga<TimeoutNames, InstanceData> {
    if (this.starts.has(eventName)) {
      throw new Error(`Event has been double registered in Saga startsOn ${this.name}: ${eventName}`)
    }
    this.starts.set(eventName, { config, handle: handler })
    return this
  }

  on<T extends EventicleEvent>(eventName: string, config: HandlerConfig<T, InstanceData, TimeoutNames>, handler: (saga: SagaInstance<TimeoutNames, InstanceData>, event: T) => Promise<void>): Saga<TimeoutNames, InstanceData> {
    if (this.eventHandler.has(eventName)) {
      throw new Error(`Event has been double registered in Saga.on ${this.name}: ${eventName}`)
    }
    this.eventHandler.set(eventName, { config, handle: handler })
    return this
  }

  onError(handler: (saga, event: EventicleEvent, error: Error) => Promise<void>): Saga<TimeoutNames, InstanceData> {
    this.errorHandler = handler
    return this
  }
}

const SAGAS: Saga<any, any>[] = []

export async function removeAllSagas(): Promise<void> {

  SAGAS.forEach(value => {
    logger.info("REMOVING ALL SAGAS NOW: " + value.name, value.streamSubs.length)
    value.streamSubs.forEach(sub => sub.close())

  })
  SAGAS.length = 0
}

async function processSagaInstanceWithExecutor(currentInstance: Record, executor: (instance: SagaInstance<any, any>) => Promise<void>, saga: Saga<any, any>) {
  let instance = new SagaInstance(currentInstance.content, currentInstance)

  await executor(instance)

  if (!instance.internalData.activeTimers) instance.internalData.activeTimers = {}

  instance.record.content = instance.internalData
  await processTimersInSagaInstance(saga, instance)
  await dataStore().saveEntity("system", "saga-instance", instance.record)

  if (instance.internalData.ended) {
    await removeAllTimersForInstance(saga, instance)
  }
  if (instance.internalData.ended && !instance.internalData.preserveInstanceData) {
    await dataStore().deleteEntity("system", "saga-instance", instance.record.id)
  }
}

async function checkSagaEventHandlers(saga: Saga<any, any>, event: EventicleEvent) {

  let handler = saga.eventHandler.get(event.type)
  let executor = async (instance: SagaInstance<any, any>) => {
    await handler.handle(instance, event)
    instance.internalData.events.push(event)
  }

  let matcher = handler.config.matchInstance(event)

  let query = {
    saga: saga.name
  }

  query[matcher.instanceProperty] = matcher.value

  logger.debug("Searching for saga-instance", query)

  let instanceData = (await dataStore().findEntity("system", "saga-instance", query))

  logger.debug("Search results for saga-instance", instanceData)

  if (instanceData.length > 0) {
    for (let currentInstance of instanceData) {
      await dataStore().transaction(async () => {
        apmJoinEvent(event, saga.name + ":" + event.type, "saga-step-" + saga.name, event.type)
        await span(event.type, {}, async theSpan => {
          if (theSpan) theSpan.setType("SagaStep")
          await processSagaInstanceWithExecutor(currentInstance, executor, saga)
        })
        updateLatency(saga, event)
        await withAPM(async apm => apm.endTransaction())
      })
    }
  } else {
    logger.debug("No Saga instance handled event, checking to see if we spawn a new one ", event)
    if (saga.starts.has(event.type)) {
      await startSagaInstance(saga, event)
    }
  }
}

async function startSagaInstance(saga: Saga<any, any>, startEvent: EventicleEvent) {

  logger.debug(`Checking if should start ${saga.name}: ${startEvent.type}`)
  if (saga.starts.get(startEvent.type).config.matches && !await saga.starts.get(startEvent.type).config.matches(startEvent)) {
    return
  }

  logger.debug(`  Saga starting ${saga.name} :: ` + startEvent.type)

  let instance = new SagaInstance<any, any>({activeTimers: {}, saga: saga.name, ended: false, instanceId: uuid.v4(), events: [startEvent]})

  apmJoinEvent(startEvent, saga.name + ":" + startEvent.type, "saga-step-" + saga.name, startEvent.type)
  await span(startEvent.type, {}, async theSpan => {
    if (theSpan) theSpan.setType("SagaStep")

    let sagaStep = saga.starts.get(startEvent.type)

    let exec = async () => {
      await sagaStep.handle(instance, startEvent)
      await processTimersInSagaInstance(saga, instance)
      await dataStore().createEntity("system", "saga-instance", instance.internalData)
    }

    if (sagaStep.config.withLock) {
      let lockKey = sagaStep.config.withLock(instance, startEvent)

      await lockManager().withLock(lockKey, exec, () => {
        logger.debug("Failed obtaining cluster lock")
      })
    } else {
      await exec()
    }
  })
  updateLatency(saga, startEvent)
  await withAPM(async apm => apm.endTransaction())
}

async function handleTimerEvent(saga, name, data) {
  let instanceData = (await dataStore().findEntity("system", "saga-instance", { instanceId: data.instanceId }))

  logger.debug("Search results for saga-instance", instanceData)

  if (instanceData.length > 0) {
    for (let currentInstance of instanceData) {
      try {
        getAPM().startTransaction(saga.name + ":" + name, "saga-timerstep-" + saga.name, name, null)
        await dataStore().transaction(async () => {
          await span(`${saga.name}: ${name}`, {}, async theSpan => {
            if (theSpan) theSpan.setType("SagaStepTimer")
            await processSagaInstanceWithExecutor(currentInstance, async instance => {
              if (saga.timerHandler.has(name)) {
                await saga.timerHandler.get(name).handle(instance)
              } else {
                logger.warn(`Saga does not have a matching onTimer ${saga.name}/ ${name}.  This is a bug. The timer has been missed and will not be retried`)
              }
              if (instance.internalData.activeTimers[name] && instance.internalData.activeTimers[name] === "timeout") {
                delete instance.internalData.activeTimers[name]
                await scheduler().removeSchedule(saga.name, name, instance.internalData.instanceId)
              }
            }, saga)
          })
        })
      } finally {
        await withAPM(async apm => apm.endTransaction())
      }
    }
  }
}

async function processTimersInSagaInstance(saga: Saga<any, any>, instance: SagaInstance<any, any>) {
  for (let timer of instance.timersToAdd) {
    if (!instance.internalData.activeTimers) instance.internalData.activeTimers = {}
    if (!Object.keys(instance.internalData.activeTimers).includes(timer.name)) {
      instance.internalData.activeTimers[timer.name] = timer.config.isCron ? "cron": "timeout"
    }
    await scheduler().addScheduledTask(saga.name, timer.name, instance.internalData.instanceId, timer.config, {
      instanceId: instance.internalData.instanceId
    })
  }
  for (let timer of instance.timersToRemove) {
    delete instance.internalData.activeTimers[timer]
    await scheduler().removeSchedule(saga.name, timer, instance.internalData.instanceId)
  }
}

async function removeAllTimersForInstance(saga: Saga<any, any>, instance: SagaInstance<any, any>) {
  let instanceData = (await dataStore().findEntity("system", "saga-instance", { instanceId: instance.internalData.instanceId }))

  if (instanceData.length > 0) {
    for (let currentInstance of instanceData) {
      if (instance.internalData.activeTimers) {
        for (const timer of Object.keys(instance.internalData.activeTimers)) {
          await scheduler().removeSchedule(saga.name, timer, instance.internalData.instanceId)
        }
      }
    }
  }
}

export async function registerSaga<TimeoutNames, Y>(saga: Saga<TimeoutNames, Y>): Promise<EventSubscriptionControl> {

  SAGAS.push(saga)

  await scheduler().addScheduleTaskListener(saga.name, async (name, id, data) => handleTimerEvent(saga, name, data))

  let control = await eventClient().hotStream(saga.streams,
    `saga-${saga.name}`, async (event: EventicleEvent) => {
      logger.debug(`Saga event: ${saga.name}`, event)

      const timeoutTimer = setTimeout(() => {
        logger.warn("Saga processing step is taking an excessive amount of time, check for promise errors ", { saga: saga.name, event })
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
    }, error => {
      logger.error("Error subscribing to streams", {
        error, saga: saga.name
      })
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
