import {eventClient, EventicleEvent, EventSubscriptionControl} from "../core/event-client";
import {dataStore, Record} from "../../datastore";
import uuid = require("uuid");
import logger from "../../logger";

interface NotifySub {
  id?: number
  instanceId?: string
  eventType: string
  filterProp: string
  filterVal: string
}

export class SagaInstance {
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

  endSaga() {
    this.internalData.ended = true
  }
}

export class Saga {

  streams: string[]
  streamSubs: EventSubscriptionControl[] = []

  starts: Map<string, (saga: SagaInstance, event: EventicleEvent) => void> = new Map()
  eventHandler: Map<string, (saga: SagaInstance, event: EventicleEvent) => void> = new Map()
  errorHandler: (saga, event: EventicleEvent, error: Error) => Promise<void> = async (saga, event, error) => {
    logger.warn("An untrapped error occurred in a saga, Eventicle trapped this event and has consumed it", {
      saga, event, error
    })
  }

  constructor(readonly name: string) {
  }

  subscribeStreams(streams: string[]): Saga {
    this.streams = streams
    return this
  }

  startOn(eventName: string, handler: (saga: SagaInstance, event: EventicleEvent) => void): Saga {
    this.starts.set(eventName, handler)
    return this
  }

  on(eventName: string, handler: (saga: SagaInstance, event: EventicleEvent) => void): Saga {
    this.eventHandler.set(eventName, handler)
    return this
  }

  onError(handler: (saga, event: EventicleEvent, error: Error) => Promise<void>): Saga {
    this.errorHandler = handler
    return this
  }
}

const SAGAS: Saga[] = []

export async function removeAllNotifyIntents(sagaInstance: SagaInstance): Promise<void> {
  let notifies = await dataStore().findEntity("system", "saga-notify-intent", {instanceId: sagaInstance.internalData.instanceId})

  await Promise.all(notifies.map(value => dataStore().deleteEntity("system", "saga-notify-intent", value.id)))
}

export async function removeAllSagas(): Promise<void> {
  SAGAS.forEach(value => value.streamSubs.forEach(sub => sub.close()))
  SAGAS.length = 0
}

async function checkNotifyIntents(saga: Saga, event: EventicleEvent) {

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

    let instanceData = await dataStore().findEntity("system", "saga-instance", {instanceId: value.instanceId})

    let instance = new SagaInstance(instanceData[0].content, instanceData[0])

    logger.info(instance)

    await saga.eventHandler.get(event.type).call(instance, instance, event)
    instance.internalData.events.push(event)
    instance.record.content = instance.internalData
    await dataStore().saveEntity("system", "saga-instance", instance.record)
    await persistNotificationSubs(saga, instance)
  }))
}

async function startSagaInstance(saga: Saga, startEvent: EventicleEvent) {
  let instance = new SagaInstance({saga: saga.name, ended: false, instanceId: uuid.v4(), events: [startEvent]})

  await saga.starts.get(startEvent.type).call(instance, instance, startEvent)

  let internal = instance.internalData

  await dataStore().createEntity("system", "saga-instance", internal)

  await persistNotificationSubs(saga, instance)
}

async function persistNotificationSubs(saga: Saga, instance: SagaInstance) {

  if (instance.internalData.ended) {
    return removeAllNotifyIntents(instance)
  }

  await Promise.all(instance.additionalSubs.map(value => dataStore().createEntity("system", "saga-notify-intent", {
    saga: saga.name,
    instanceId: instance.internalData.instanceId,
    ...value
  })))
}

export async function registerSaga(saga: Saga): Promise<void> {

  SAGAS.push(saga)

  saga.streamSubs.push(await eventClient().hotStream(saga.streams,
    `saga-${saga.name}`, async (event: EventicleEvent) => {
      logger.debug(`Saga ${saga.name} event`, event)
      try {
        if (saga.starts.has(event.type)) {
          await startSagaInstance(saga, event)
        } else if (saga.eventHandler.has(event.type)) {
          await checkNotifyIntents(saga, event)
        }
      } catch (e) {
        await saga.errorHandler(saga, event, e)
      }
    }, error => {
      logger.error("Error subscribing to streams", {
        error, saga: saga.name
      })
    }))
}

export async function allSagaInstances(): Promise<SagaInstance[]> {
  let ret = (await dataStore().findEntity("system", "saga-instance", {}, {}))

  if (!ret) return []
  return ret.map(value => new SagaInstance(value.content))
}

export async function allSagas(): Promise<Saga[]> {
  return SAGAS
}

export function saga(name: string): Saga {
  return new Saga(name)
}
