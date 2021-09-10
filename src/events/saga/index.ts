import {eventClient, EventicleEvent, EventSubscriptionControl} from "../core/event-client";
import {dataStore, Record} from "../../datastore";
import logger from "../../logger";
import {apmJoinEvent, span, withAPM} from "../../apm";
import {lockManager} from "../lock-manager";
import uuid = require("uuid");

let metrics = {} as any

function updateLatency(view: Saga<any>, event: EventicleEvent) {
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

interface StartHandlerConfig<T extends EventicleEvent, Y> {
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
  withLock?: (instance: SagaInstance<Y>, event: T) => string
}

interface HandlerConfig<T extends EventicleEvent, Y> {
  /**
   * Obtain a lock during the processing of this event.
   * Defaults to no lock
   */
  withLock?: (instance: SagaInstance<Y>, event: T) => string

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

export class SagaInstance<T> {

  constructor(readonly internalData: any, readonly record?: Record) {
  }

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

  // addTimeout(name: string, millis: number) {
  //
  // }
  //
  // clearTimeout(name: string) {
  //
  // }

  endSaga(preserveInstanceData: boolean = false) {
    this.internalData.ended = true
    this.internalData.preserveInstanceData = preserveInstanceData
  }
}

export class Saga<InstanceData> {

  streams: string[]
  streamSubs: EventSubscriptionControl[] = []

  starts: Map<string, { config: StartHandlerConfig<any, InstanceData>, handle: (saga: SagaInstance<InstanceData>, event: EventicleEvent) => Promise<void> }> = new Map()
  eventHandler: Map<string, { config: HandlerConfig< any, InstanceData>, handle: (saga: SagaInstance<InstanceData>, event: EventicleEvent) => Promise<void> }> = new Map()
  errorHandler: (saga, event: EventicleEvent, error: Error) => Promise<void> = async (saga, event, error) => {
    logger.warn("An untrapped error occurred in a saga, Eventicle trapped this event and has consumed it", {
      saga, event
    })
    logger.error("Saga error", error)
  }

  constructor(readonly name: string) {
  }

  subscribeStreams(streams: string[]): Saga<InstanceData> {
    this.streams = streams
    return this
  }

  // startOnMatch(eventMatcher: (event: EventicleEvent) => Promise<boolean>): Saga {
  //   this.startMatcher = eventMatcher
  //   return this
  // }
  //
  // onTimeout(handler: (saga: SagaInstance<InstanceData>) => Promise<void>): Saga<InstanceData> {
  //
  //   return this
  // }

  startOn<T extends EventicleEvent>(eventName: string, config: StartHandlerConfig<T, InstanceData>, handler: (saga: SagaInstance<InstanceData>, event: T) => Promise<void>): Saga<InstanceData> {
    if (this.starts.has(eventName)) {
      throw new Error(`Event has been double registered in Saga startsOn ${this.name}: ${eventName}`)
    }
    this.starts.set(eventName, { config, handle: handler })
    return this
  }

  on<T extends EventicleEvent>(eventName: string, config: HandlerConfig<T, InstanceData>, handler: (saga: SagaInstance<InstanceData>, event: T) => Promise<void>): Saga<InstanceData> {
    if (this.eventHandler.has(eventName)) {
      throw new Error(`Event has been double registered in Saga.on ${this.name}: ${eventName}`)
    }
    this.eventHandler.set(eventName, { config, handle: handler })
    return this
  }

  onError(handler: (saga, event: EventicleEvent, error: Error) => Promise<void>): Saga<InstanceData> {
    this.errorHandler = handler
    return this
  }
}

const SAGAS: Saga<any>[] = []

export async function removeAllSagas(): Promise<void> {
  SAGAS.forEach(value => value.streamSubs.forEach(sub => sub.close()))
  SAGAS.length = 0
}

async function checkSagaEventHandlers(saga: Saga<any>, event: EventicleEvent) {

  let handler = saga.eventHandler.get(event.type)

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

          let instance = new SagaInstance(currentInstance.content, currentInstance)

          if (theSpan) theSpan.setType("SagaStep")
          await handler.handle(instance, event)
          instance.internalData.events.push(event)
          instance.record.content = instance.internalData
          await dataStore().saveEntity("system", "saga-instance", instance.record)

          if (instance.internalData.ended && !instance.internalData.preserveInstanceData) {
            await dataStore().deleteEntity("system", "saga-instance", instance.record.id)
          }
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

async function startSagaInstance(saga: Saga<any>, startEvent: EventicleEvent) {

  logger.debug(`Checking if should start ${saga.name}: ${startEvent.type}`)
  if (saga.starts.get(startEvent.type).config.matches && !await saga.starts.get(startEvent.type).config.matches(startEvent)) {
    return
  }

  logger.debug(`  Saga starting ${saga.name} :: ` + startEvent.type)

  let instance = new SagaInstance<any>({saga: saga.name, ended: false, instanceId: uuid.v4(), events: [startEvent]})

  apmJoinEvent(startEvent, saga.name + ":" + startEvent.type, "saga-step-" + saga.name, startEvent.type)
  await span(startEvent.type, {}, async theSpan => {
    if (theSpan) theSpan.setType("SagaStep")

    let sagaStep = saga.starts.get(startEvent.type)

    let exec = async () => {
      await sagaStep.handle(instance, startEvent)
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


export async function registerSaga<Y>(saga: Saga<Y>): Promise<EventSubscriptionControl> {

  SAGAS.push(saga)

  let control = await eventClient().hotStream(saga.streams,
    `saga-${saga.name}`, async (event: EventicleEvent) => {
      logger.debug(`Saga event: ${saga.name}`, event)
      await dataStore().transaction(async () => {
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
        }
      }, {
        propagation: "requires_new"
      })
    }, error => {
      logger.error("Error subscribing to streams", {
        error, saga: saga.name
      })
    });

  saga.streamSubs.push(control);

  return control;
}

export async function allSagaInstances(workspaceId?: string): Promise<SagaInstance<any>[]> {
  if (!workspaceId) workspaceId = "system"
  let ret = (await dataStore().findEntity(workspaceId, "saga-instance", {}, {}))

  if (!ret) return []
  return ret.map(value => new SagaInstance(value.content))
}

export async function allSagas(): Promise<Saga<any>[]> {
  return SAGAS
}

export function saga<SagaInstanceData>(name: string): Saga<SagaInstanceData> {
  return new Saga<SagaInstanceData>(name)
}
