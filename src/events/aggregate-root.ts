import {EventicleEvent} from "./core/event-client";
import uuid = require("uuid");
import {dataStore} from "../datastore";

export abstract class AggregateRoot {

  readonly newEvents: EventicleEvent[] = []
  id: string;
  reducers: any

  constructor(readonly type: string) {}

  raiseEvent(event: EventicleEvent) {
    event.id = uuid.v4()
    if (!event.data.id) {
      event.data.id = this.id
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
  }
}

export default {
  /**
   * Replay and build an aggregate root into its current state.
   * @param type
   * @param id
   */
  load: async<T>(type: any, id: string): Promise<T> => {
    let t = new type()
    let ret = await dataStore().findEntity("system", "aggregate-events-" + t.type, { domainId: id })

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
  history: async<T>(type: string, id: string): Promise<EventicleEvent[]> => {
    let ret = await dataStore().findEntity("system", "aggregate-events-" + type, { domainId: id })

    if (ret && ret.length > 0) {
      return ret[0].content.history
    }

    return null
  },

  persist: async<T extends AggregateRoot>(aggregate: T): Promise<EventicleEvent[]> => {

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
  }
}
