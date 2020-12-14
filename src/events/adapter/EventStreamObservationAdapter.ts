import * as uuid from "uuid"

import {EventEmitter} from "events";
import {EventAdapter} from "./index";
import {AggregateRoot, EventicleEvent} from "../..";

class InternalEv extends EventEmitter {}
const emitter = new InternalEv()

export class EventStreamObservationAdapter implements EventAdapter {
  constructor(readonly streamsToSubscribe: string[]) {}
  readonly name = "event-stream-observer"
  readonly consumerGroup = `event-stream-observation-${uuid.v4()}`

  async handleEvent(event: EventicleEvent): Promise<void> {
    emitter.emit("event", event)
  }
}

let VIEW: EventStreamObservationAdapter

export function createEventStreamObservationAdapter<AR extends AggregateRoot>(aggregates: { new (): AR }[]) {
  VIEW = new EventStreamObservationAdapter(aggregates.map(value => new value().type))
  return VIEW
}
export const eventStreamObservationAdapter = () => VIEW

/**
 * Watch a hot stream
 * @param type
 * @param id
 * @param timeout
 * @param exec
 */
export const eventStreamObserver = async (type: string, id: string, timeout: number, exec: (event: EventicleEvent) => boolean): Promise<any> => {
  let internalContext = {}

  return await new Promise((resolve, reject) => {

    const timeoutHandler = setTimeout(() => {
      emitter.removeListener("event", listener)
      reject(new Error(`Event Observer timeout occured: ${type}, ${id}`))
    }, timeout)

    const listener = async (event: EventicleEvent) => {
      if(event.domainId === id) {
        internalContext = {...internalContext, ...event}
        if(exec(event)) {
          clearTimeout(timeoutHandler)
          emitter.removeListener("event", listener)
          resolve(internalContext)
        }
      }
    }
    emitter.addListener(`event`, listener)
  })
}
