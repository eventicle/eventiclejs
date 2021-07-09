import {eventClient, EventicleEvent, EventSubscriptionControl} from "../core/event-client";
import {dataStore, Record} from "../../datastore";
import uuid = require("uuid");
import logger from "../../logger";
import {apmJoinEvent, span, withAPM} from "../../apm";

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

interface StartHandlerConfig<T extends EventicleEvent, Y extends SagaInternalData> extends  HandlerConfig<T, Y> {
  /**
   * Only start a saga instance if this function returns true
   *
   * @param event
   */
  matches?: (event: T) => Promise<boolean>
}

interface HandlerConfig<T extends EventicleEvent, Y extends SagaInternalData> {
  /**
   * Obtain a lock during the processing of this event.
   * Defaults to no lock
   */
  withLock?: (instance: SagaInstance<Y>, event: T) => string
}

interface NotifySub {
  id?: number
  instanceId?: string
  eventType: string
  filterProp: string
  filterVal: string
}

interface SagaInternalData {
  ended: boolean
  preserveInstanceData: boolean
}

export class SagaInstance<T extends SagaInternalData> {
  private notifiesToAdd: NotifySub[] = []

  constructor(readonly internalData: any, readonly record?: Record) {
  }

  get additionalSubs(): NotifySub[] {
    return this.notifiesToAdd
  }

  get(name: string): any {
    return this.internalData[name]
  }

  set(name: string, value: any) {
    if (name == "id") throw new Error("SETTING ID IS FORBIDDEN")
    this.internalData[name] = value
  }

  notifyOn(eventType: string, dataProperty: string, dataValue: any) {
    this.notifiesToAdd.push({
      eventType, filterProp: dataProperty, filterVal: dataValue
    })
  }

  lastEvent(): EventicleEvent {
    return null
  }

  addTimeout(name: string, millis: number) {

  }

  clearTimeout(name: string) {

  }

  endSaga(preserveInstanceData: boolean = false) {
    this.internalData.ended = true
    this.internalData.preserveInstanceData = preserveInstanceData
  }
}

export class Saga<Y> {

  streams: string[]
  streamSubs: EventSubscriptionControl[] = []
  startMatcher: (event: EventicleEvent) => Promise<boolean> = async event => true;

  starts: Map<string, (saga: SagaInstance<Y>, event: EventicleEvent) => void> = new Map()
  eventHandler: Map<string, (saga: SagaInstance<Y>, event: EventicleEvent) => void> = new Map()
  errorHandler: (saga, event: EventicleEvent, error: Error) => Promise<void> = async (saga, event, error) => {
    logger.warn("An untrapped error occurred in a saga, Eventicle trapped this event and has consumed it", {
      saga, event
    })
    logger.error("Saga error", error)
  }

  constructor(readonly name: string) {
  }

  subscribeStreams(streams: string[]): Saga<Y> {
    this.streams = streams
    return this
  }

  // startOnMatch(eventMatcher: (event: EventicleEvent) => Promise<boolean>): Saga {
  //   this.startMatcher = eventMatcher
  //   return this
  // }

  onTimeout(handler: (saga: SagaInstance<Y>) => Promise<void>): Saga<Y> {

    return this
  }

  startOn<T extends EventicleEvent>(eventName: string, config: StartHandlerConfig<T, Y>, handler: (saga: SagaInstance<Y>, event: T) => Promise<void>): Saga<Y> {
    this.starts.set(eventName, handler)
    return this
  }

  on<T extends EventicleEvent>(eventName: string, config: HandlerConfig<T, Y>, handler: (saga: SagaInstance<Y>, event: T) => Promise<void>): Saga<Y> {
    this.eventHandler.set(eventName, handler)
    return this
  }

  onError(handler: (saga, event: EventicleEvent, error: Error) => Promise<void>): Saga<Y> {
    this.errorHandler = handler
    return this
  }
}

const SAGAS: Saga<any>[] = []

export async function removeAllNotifyIntents(sagaInstance: SagaInstance<any>): Promise<void> {
  let notifies = await dataStore().findEntity("system", "saga-notify-intent", {instanceId: sagaInstance.internalData.instanceId})

  await Promise.all(notifies.map(value => dataStore().deleteEntity("system", "saga-notify-intent", value.id)))
}

export async function removeAllSagas(): Promise<void> {
  SAGAS.forEach(value => value.streamSubs.forEach(sub => sub.close()))
  SAGAS.length = 0
}

async function checkNotifyIntents(saga: Saga<any>, event: EventicleEvent) {

  let notifies: NotifySub[] = (await dataStore().findEntity("system", "saga-notify-intent", {
    saga: saga.name,
    eventType: event.type
  })).map(value => value.content)

  let matchingNotifies = notifies.filter(value => {
    if (value && value.hasOwnProperty('filterProp')) {
      if (event.hasOwnProperty(value.filterProp)) {
        return event[value.filterProp] == value.filterVal
      }
      return event.data[value.filterProp] == value.filterVal
    } else {
      return false
    }
  })

  await Promise.all(matchingNotifies.map(async value => {
    await dataStore().transaction(async () => {
      await apmJoinEvent(event, saga.name + ":" + event.type, "saga-step-" + saga.name, event.type)
      await span(event.type, {}, async theSpan => {
        let instanceData = await dataStore().findEntity("system", "saga-instance", {instanceId: value.instanceId})

        let instance = new SagaInstance(instanceData[0].content, instanceData[0])

        if (theSpan) theSpan.setType("SagaStep")
        await saga.eventHandler.get(event.type).call(instance, instance, event)
        instance.internalData.events.push(event)
        instance.record.content = instance.internalData
        await dataStore().saveEntity("system", "saga-instance", instance.record)
        await persistNotificationSubs(saga, instance)
        if (instance.internalData.ended && !instance.internalData.preserveInstanceData) {
          await dataStore().deleteEntity("system", "saga-instance", instance.record.id)
        }
      })
      if (matchingNotifies.length > 0) {
        updateLatency(saga, event)
      }
      await withAPM(async apm => apm.endTransaction())
    })
  }))
}

async function startSagaInstance(saga: Saga<any>, startEvent: EventicleEvent) {
  let instance = new SagaInstance<any>({saga: saga.name, ended: false, instanceId: uuid.v4(), events: [startEvent]})

  await apmJoinEvent(startEvent, saga.name + ":" + startEvent.type, "saga-step-" + saga.name, startEvent.type)
  await span(startEvent.type, {}, async theSpan => {
    if (theSpan) theSpan.setType("SagaStep")
    await saga.starts.get(startEvent.type).call(instance, instance, startEvent)

    let internal = instance.internalData

    await dataStore().createEntity("system", "saga-instance", internal)

    await persistNotificationSubs(saga, instance)
  })
  updateLatency(saga, startEvent)
  await withAPM(async apm => apm.endTransaction())
}

async function persistNotificationSubs(saga: Saga<any>, instance: SagaInstance<any>) {

  if (instance.internalData.ended) {
    return removeAllNotifyIntents(instance)
  }

  await Promise.all(instance.additionalSubs.map(value => dataStore().createEntity("system", "saga-notify-intent", {
    saga: saga.name,
    instanceId: instance.internalData.instanceId,
    ...value
  })))
}

export async function registerSaga<Y>(saga: Saga<Y>): Promise<EventSubscriptionControl> {

  SAGAS.push(saga)

  let control = await eventClient().hotStream(saga.streams,
    `saga-${saga.name}`, async (event: EventicleEvent) => {
      logger.debug(`Saga event: ${saga.name}`, event)
      await dataStore().transaction(async () => {
        try {
          logger.debug(`  Saga starting ${saga.name} :: ` + event.type)
          if (saga.starts.has(event.type) && await saga.startMatcher(event)) {
            await startSagaInstance(saga, event)
          }
          logger.debug(`  Saga handling notify intents: ${saga.name} :: ` + event.type)
          if (saga.eventHandler.has(event.type)) {
            await checkNotifyIntents(saga, event)
            logger.debug(`      done intents: ${saga.name} :: ` + event.type)
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

export function saga<Y>(name: string): Saga<Y> {
  return new Saga<Y>(name)
}
