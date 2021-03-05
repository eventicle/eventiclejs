import {
  EncodedEvent,
  EventClient,
  eventClientCodec,
  EventicleEvent,
  EventSubscriptionControl
} from "./event-client";
import {EventEmitter} from "events"
import {dataStore} from "../../datastore";
import logger from "../../logger";
// import logger from "../../logger";

class InternalEv extends EventEmitter {}

let emitter = new InternalEv()

// TODO, this is only a test-ready implementation of an event log.

const streams = new Map()

interface InternalEvent {
  id: string
  stream: string
  event: EncodedEvent
}

class Stream {
  items: InternalEvent[] = []

  constructor(readonly name: string) {}

  getNextAfter(cursor: string): InternalEvent {
    if (!cursor && this.items.length > 0) {
      return this.items[0]
    }

    for(let it = 0; it < this.items.length; it++) {
      if (this.items[it].id == cursor && this.items.length > it) {
        return this.items[it + 1]
      }
    }

    return null
  }
}

function getStream(name: string): Stream {
  if (!streams.has(name)) {
    streams.set(name, new Stream(name))
  }
  return streams.get(name)
}

class StreamSubscription {

  private processing: boolean = false
  private cursor: string

  constructor(readonly name: string, readonly stream: Stream, readonly handler: (event: InternalEvent) => Promise<void>) {}

  async process() {
    try {
      if (this.processing) return
      this.processing = true

      let it = this.stream.getNextAfter(this.cursor)

      while(it != null) {
        if (it) {
          this.cursor = it.id
        }

        await this.handler(it)

        it = this.stream.getNextAfter(this.cursor)
      }

    } finally {
      this.processing = false
    }
  }
}

const subscriptions = [] as StreamSubscription[]

async function tickSubs() {
  subscriptions.forEach(value => value.process())
}

/**
 * This is a test capable event client.
 *
 * It fully implements the event client semantics, and persists its events into the given data store.
 *
 * Good to pair with the InMemDataStore for testing and local dev usage.
 *
 * Not recommended for production (really!), as you disable any possibility of distribution
 */
export function eventClientOnDatastore(): EventClient {
  return new EventclientDatastore()
}

class EventclientDatastore implements EventClient {

  constructor() {}

  async coldHotStream(config: { stream: string | string[], from: string, handler: (event: EventicleEvent) => Promise<void>, onError: (error: any) => void }): Promise<EventSubscriptionControl> {

    let streams = JSON.parse(JSON.stringify(config.stream))

    let coldReplay = async() => {
      const str = []

      if (Array.isArray(streams)) {
        for (let stream of streams) {
          str.push(...await dataStore().findEntity("system", "event-stream", {streamId: stream}, { createdAt: "ASC"}))
        }
      } else {
        str.push(...await dataStore().findEntity("system", "event-stream", {streamId: streams}, {createdAt: "ASC"}))
      }

      if (!str) {
        config.onError(`No such stream ${streams}`)
        return
      }

      // todo, improved by having a hot buffer and storing until replay is made.  This seems to pass reliably in process, so .... meh
      emitter.addListener("event", async (ev: InternalEvent) => {
        if (!ev) throw new Error("Received an undefined or null InternalEvent, this is a bug: " + JSON.stringify(ev.event))

        if (Array.isArray(streams) && streams.includes(ev.stream)) {
          await config.handler(await eventClientCodec().decode(ev.event))
        } else if (ev.stream == config.stream) {
          await config.handler(await eventClientCodec().decode(ev.event))
        }
      })
    }

    coldReplay()

    return {
      close: async () => {

      }
    }
  };

  async clear() {
    for (let stream of (await dataStore().findEntity("system", "event-stream", {}))) {
      await dataStore().deleteEntity("system", "event-stream", stream.id)
    }
    subscriptions.length=0
    streams.clear()
  }

  async coldStream(stream: string, handler: (event: EventicleEvent) => Promise<void>, onError: (error: any) => void, onDone: () => void): Promise<EventSubscriptionControl> {

    const str = []
    if (Array.isArray(stream)) {
      for (let theStream of stream) {
        str.push(...await dataStore().findEntity("system", "event-stream", {streamId: theStream}, { createdAt : "ASC"} ))
      }
    } else {
      str.push(...await dataStore().findEntity("system", "event-stream", {streamId: stream}, { createdAt : "ASC"}))
    }

    if (!str) {
      onError(`No such stream ${stream}`)
      return
    }

    for(let entry of str) {
      await handler(entry.content.internal)
    }

    onDone()

    return {
      close: async () => {

      }
    }
  }

  async emit (event: EventicleEvent[], stream: string) {

    for (let ev of event) {

      ev.createdAt = new Date().getTime()
      ev.stream = stream

      await dataStore().createEntity("system", "event-stream", {
        streamId: stream, internal: ev
      })

      let event = await eventClientCodec().encode(ev)

      if (!event) {
        logger.error("An encoding error occurred. An event encoded to undefined or null. This is a bug", {
          event, source_event:ev
        })
      }
      let internal = {
        event, stream, id: ev.id
      } as InternalEvent
      // TODO, remove when coldHot ports to event log
      emitter.emit("event", internal)

      getStream(stream).items.push(internal)
    }
    await tickSubs()
  }

  async hotStream(stream: string | string[],
                  consumerName: string,
                  handler: (event: EventicleEvent) => Promise<void>,
                  onError: (error: any) => void) {
    let theStream = stream
    //todo, ACTUALLY REMOVE THE SUB, this is a resource leak
    let tombstoned = false
    let exec = async (ev: InternalEvent) => {
      if (tombstoned) return
      if (Array.isArray(theStream) && theStream.includes(ev.stream)) {
        await handler(await eventClientCodec().decode(ev.event))
      } else if (ev.stream == theStream) {
        await handler(await eventClientCodec().decode(ev.event))
      }
    }

    if (Array.isArray(theStream)) {
      for (let str of theStream) {
        subscriptions.push(new StreamSubscription(`${theStream}:${consumerName}`, getStream(str), exec))
      }
    } else {
      subscriptions.push(new StreamSubscription(`${theStream}:${consumerName}`, getStream(theStream), exec))
    }
    return {
      close: async () => {
        tombstoned = true
      }
    }
  }
}
