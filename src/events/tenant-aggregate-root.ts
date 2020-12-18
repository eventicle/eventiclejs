import {EventicleEvent, eventSourceName} from "./core/event-client";
import uuid = require("uuid");
import {dataStore} from "../datastore";
import logger from "../logger";
import {hashCode, lockManager} from "./lock-manager";
import {AggregateRoot} from "./aggregate-root";

function eventstreamname<T extends AggregateRoot>(type: string) {
  return "aggregate-events-" + type
}

export default {
  /**
   * Replay and build an aggregate root into its current state.
   * @param type
   * @param id
   */
  load: async<T extends AggregateRoot>(emptyInstance: T, tenant: string, id: string): Promise<T> => {
    let ret = await dataStore().findEntity(tenant, eventstreamname(emptyInstance.type), { domainId: id })

    if (ret && ret.length > 0) {
      ret[0].content.history.forEach(value => emptyInstance.handleEvent(value))
      return emptyInstance
    }

    return null
  },

  /**
   * Obtain the full stream of events that make up the history of an aggregate root.
   * @param type
   * @param id
   */
  history: async<T extends AggregateRoot>(type: string, tenant: string, id: string): Promise<EventicleEvent[]> => {
    let ret = await dataStore().findEntity(tenant, eventstreamname(type), { domainId: id })

    if (ret && ret.length > 0) {
      return ret[0].content.history
    }

    return null
  },

  persist: async<T extends AggregateRoot>(aggregate: T, tenant: string): Promise<EventicleEvent[]> => {
    return lockManager().withLock(hashCode(tenant + aggregate.id), async () => {

      let ret = JSON.parse(JSON.stringify(aggregate.newEvents))
      aggregate.newEvents.length = 0

      let entity = await dataStore().findEntity(tenant, eventstreamname(aggregate.type), { domainId: aggregate.id })

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
  }
}
