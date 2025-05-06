import {dataStore, EventicleEvent, lockManager, Record, Saga, SagaInstance, scheduler} from "../../index";
import {getAPM, logger, span, withAPM} from "@eventicle/eventicle-utilities";
import {apmJoinEvent} from "../../apm";
import * as uuid from "uuid";
import {sagaScheduler} from "./index";

export const SAGA_METRICS = {} as any

function updateLatency(view: Saga<any, any>, event: EventicleEvent) {
  if (!SAGA_METRICS.hasOwnProperty(view.name)) {
    SAGA_METRICS[view.name] = {latest: 0}
  }
  if (!SAGA_METRICS[view.name].hasOwnProperty(event.type)) {
    SAGA_METRICS[view.name][event.type] = 0
  }
  SAGA_METRICS[view.name][event.type] = new Date().getTime() - event.createdAt
  SAGA_METRICS[view.name].latest = new Date().getTime() - event.createdAt
}

export async function handleSagaInstanceEnd(instance: SagaInstance<unknown, unknown>, saga: Saga<any, any>) {
  if (instance.internalData.ended) {
    await removeAllTimersForInstance(saga, instance)
  }
  if (instance.internalData.ended && !instance.internalData.preserveInstanceData) {
    await dataStore().deleteEntity("system", "saga-instance", instance.record.id)
  }
}

export async function processSagaInstanceWithExecutor(currentInstance: Record, executor: (instance: SagaInstance<any, any>) => Promise<void>, saga: Saga<any, any>) {
  let instance = new SagaInstance(currentInstance.content, currentInstance)

  await executor(instance)

  if (!instance.internalData.activeTimers) instance.internalData.activeTimers = {}

  instance.record.content = instance.internalData
  await processTimersInSagaInstance(saga, instance)
  await dataStore().saveEntity("system", "saga-instance", instance.record)
  await handleSagaInstanceEnd(instance, saga);
}

export async function sagaHandleEvent(saga: Saga<any, any>, event: EventicleEvent<any>, instanceId: string) {

  const currentInstance = await dataStore().findEntity("system", "saga-instance", { instanceId })

  let handler = saga.eventHandler.get(event.type)

  let executor = async (instance: SagaInstance<any, any>) => {
    await handler.handle(instance, event)
    instance.internalData.events.push(event)
  }

  await dataStore().transaction(async () => {
    apmJoinEvent(event, saga.name + ":" + event.type, "saga-step-" + saga.name, event.type)
    await span(event.type, {}, async theSpan => {
      if (theSpan) theSpan.setType("SagaStep")
      await processSagaInstanceWithExecutor(currentInstance[0], executor, saga)
    })
    updateLatency(saga, event)
    await withAPM(async apm => apm.endTransaction())
  })
}

export async function checkSagaEventHandlers(saga: Saga<any, any>, event: EventicleEvent) {

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
      await sagaScheduler.sagaHandleEvent(saga, event, currentInstance.content.instanceId);
    }
  } else {
    logger.debug("No Saga instance handled event, checking to see if we spawn a new one ", event)
    if (saga.starts.has(event.type)) {
      await startSagaInstance(saga, event)
    }
  }
}

export async function startSagaInstance(saga: Saga<any, any>, startEvent: EventicleEvent) {

  logger.debug(`Checking if should start ${saga.name}: ${startEvent.type}`)
  if (saga.starts.get(startEvent.type).config.matches && !await saga.starts.get(startEvent.type).config.matches(startEvent)) {
    return
  }

  logger.debug(`  Saga starting ${saga.name} :: ` + startEvent.type)

  let instance = new SagaInstance<any, any>({
    activeTimers: {},
    saga: saga.name,
    ended: false,
    instanceId: uuid.v4(),
    events: [startEvent]
  })

  apmJoinEvent(startEvent, saga.name + ":" + startEvent.type, "saga-step-" + saga.name, startEvent.type)
  await span(startEvent.type, {}, async theSpan => {
    if (theSpan) theSpan.setType("SagaStep")

    let sagaStep = saga.starts.get(startEvent.type)

    let exec = async () => {
      await sagaStep.handle(instance, startEvent)
      await processTimersInSagaInstance(saga, instance)
      const record = await dataStore().createEntity("system", "saga-instance", instance.internalData)
      instance = new SagaInstance<any, any>(instance.internalData, record)
      await handleSagaInstanceEnd(instance, saga)
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

export async function handleTimerEvent(saga: Saga<any, any>, name: string, data: { instanceId: string }) {
  let instanceData = (await dataStore().findEntity("system", "saga-instance", {instanceId: data.instanceId}))

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

export async function processTimersInSagaInstance(saga: Saga<any, any>, instance: SagaInstance<any, any>) {
  for (let timer of instance.timersToAdd) {
    if (!instance.internalData.activeTimers) instance.internalData.activeTimers = {}
    if (!Object.keys(instance.internalData.activeTimers).includes(timer.name)) {
      instance.internalData.activeTimers[timer.name] = timer.config.isCron ? "cron" : "timeout"
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

export async function removeAllTimersForInstance(saga: Saga<any, any>, instance: SagaInstance<any, any>) {
  let instanceData = (await dataStore().findEntity("system", "saga-instance", {instanceId: instance.internalData.instanceId}))

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
