import {EventicleEvent, eventSourceName} from "./core/event-client";
import uuid = require("uuid");
import {dataStore} from "../datastore";
import logger from "../logger";
import {hashCode, lockManager} from "./lock-manager";

export abstract class AggregateRoot {

  readonly newEvents: EventicleEvent[] = []
  id: string;
  reducers: any

  constructor(readonly type: string) {}

  raiseEvent(event: EventicleEvent) {
    event.id = uuid.v4()
    if (!event.createdAt) {
      event.createdAt = new Date().getTime()
    }
    if (!event.source) {
      event.source = eventSourceName()
    }
    if (!event.domainId) {
      event.domainId = this.id
    }
    this.handleEvent(event)
    this.newEvents.push(event)
  }

  handleEvent(event: EventicleEvent) {
    let func = this.reducers[event.type]
    if (func) func.call(this, event)
    logger.trace(`${this.type} after applying ${event.type}`, this)
  }
}

function eventstreamname<T extends AggregateRoot>(type: { new (): T }) {
  let t = new type()
  return "aggregate-events-" + t.type
}

export default {
  /**
   * Replay and build an aggregate root into its current state.
   * @param type
   * @param id
   */
  load: async<T extends AggregateRoot>(type: { new (): T }, id: string): Promise<T> => {
    let t = new type()
    let ret = await dataStore().findEntity("system", eventstreamname(type), { domainId: id })

    if (ret && ret.length > 0) {
      ret[0].content.history.forEach(value => t.handleEvent(value))
      return t
    }

    return null
  },

  /**
   * Obtain the full stream of events that make up the history of an aggregate root.
   * @param type
   * @param id
   */
  history: async<T extends AggregateRoot>(type: { new (): T }, id: string): Promise<EventicleEvent[]> => {
    let ret = await dataStore().findEntity("system", eventstreamname(type), { domainId: id })

    if (ret && ret.length > 0) {
      return ret[0].content.history
    }

    return null
  },

  persist: async<T extends AggregateRoot>(aggregate: T): Promise<EventicleEvent[]> => {
    return lockManager().withLock(hashCode(aggregate.id), async () => {

      let storeType = "aggregate-events-" + aggregate.type
      let ret = JSON.parse(JSON.stringify(aggregate.newEvents))
      aggregate.newEvents.length = 0

      let entity = await dataStore().findEntity("system", storeType, { domainId: aggregate.id })

      if (!entity || entity.length == 0) {

        let instance = {
          domainId: aggregate.id,
          history: ret
        }

        await dataStore().createEntity("system", storeType, instance)

      } else {
        let instance = entity[0]
        instance.content.history.push(...ret)
        await dataStore().saveEntity("system", storeType, instance)
      }

      return ret
    }, () => {
      logger.warn("Failed to do the thing")
    })
  }
}
