import {EventicleEvent} from "./core/event-client";
import {dataStore} from "../";
import {logger} from "@eventicle/eventicle-utilities";
import {lockManager} from "./../";
import {AggregateRepository, AggregateRoot} from "./aggregate-root";
import {DataQuery, Query} from "@eventicle/eventicle-utilities/dist/datastore";

function eventstreamname<T extends AggregateRoot>(type: string) {
  return "aggregate-events-" + type
}

async function hydrateAggregate(datastoreContent: any, aggregate: any) {
  datastoreContent.content.history.forEach(value => aggregate.handleEvent(value))
  aggregate.history = datastoreContent.content.history
  return aggregate
}

export default {

  /**
   * Replay and build an aggregate root into its current state.
   * @param type
   * @param id
   */
  load: async <T extends AggregateRoot>(emptyInstance: T, tenant: string, id: string): Promise<T> => {
    let ret = await dataStore().findEntity(tenant, eventstreamname(emptyInstance.type), {domainId: id})
    if (ret && ret.length > 0) {
      return hydrateAggregate(ret[0], emptyInstance)
    }
    return null
  },

  loadBulk: async <T extends AggregateRoot>(type: { new (): T }, tenant: string, filter: Query): Promise<T[]> => {
    let t = new type()

    let instances = await dataStore().findEntity(tenant, eventstreamname(t.type), filter)

    const aggregates = []

    for (const instance of instances) {
      const aggregate = new type()
      await hydrateAggregate(instance, aggregate)
      aggregates.push(aggregate)
    }

    return aggregates
  },

  /**
   * Obtain the full stream of events that make up the history of an aggregate root.
   * @param type
   * @param id
   */
  history: async <T extends AggregateRoot>(type: string, tenant: string, id: string): Promise<EventicleEvent[]> => {
    let ret = await dataStore().findEntity(tenant, eventstreamname(type), {domainId: id})

    if (ret && ret.length > 0) {
      return ret[0].content.history
    }

    return null
  },

  persist: async <T extends AggregateRoot>(aggregate: T, tenant: string): Promise<EventicleEvent[]> => {
    return await dataStore().transaction(async () => {
      return await lockManager().withLock(tenant + aggregate.id, async () => {

        let ret = JSON.parse(JSON.stringify(aggregate.newEvents))
        aggregate.newEvents.length = 0

        let entity = await dataStore().findEntity(tenant, eventstreamname(aggregate.type), {domainId: aggregate.id})

        if (!entity || entity.length == 0) {

          let instance = {
            domainId: aggregate.id,
            history: ret
          }

          await dataStore().createEntity(tenant, eventstreamname(aggregate.type), instance)

        } else {
          let instance = entity[0]
          instance.content.history.push(...ret)
          await dataStore().saveEntity(tenant, eventstreamname(aggregate.type), instance)
        }

        return ret
      }, () => {
        logger.warn("Failed to do the thing")
      })
    })
  }
}
