import {EventicleEvent, eventSourceName} from "./core/event-client";
import uuid = require("uuid");
import {logger} from "@eventicle/eventicle-utilities";
import aggregatesTenant from "./tenant-aggregate-root";

export abstract class AggregateRoot {

  history: EventicleEvent[] = []
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

export interface AggregateRepository {
  load<T extends AggregateRoot>(type: { new (): T }, id: string): Promise<T>
  history<T extends AggregateRoot>(type: { new (): T }, id: string): Promise<EventicleEvent[]>
  persist<T extends AggregateRoot>(aggregate: T): Promise<EventicleEvent[]>
}


export default {
  /**
   * Replay and build an aggregate root into its current state.
   * @param type
   * @param id
   */
  load: async<T extends AggregateRoot>(type: { new (): T }, id: string): Promise<T> => {
    let t = new type()
    return aggregatesTenant.load(t, "system", id)
  },

  /**
   * Obtain the full stream of events that make up the history of an aggregate root.
   * @param type
   * @param id
   */
  history: async<T extends AggregateRoot>(type: { new (): T }, id: string): Promise<EventicleEvent[]> => {
    let t = new type()
    return aggregatesTenant.history(t.type, "system", id)
  },

  persist: async<T extends AggregateRoot>(aggregate: T): Promise<EventicleEvent[]> => {
    return aggregatesTenant.persist(aggregate, "system")
  }
} as AggregateRepository
