import {EventClient, EventicleEvent, EventSubscriptionControl} from "./event-client";
import {EventEmitter} from "events"
import {dataStore} from "../../datastore";
// import logger from "../../logger";

class InternalEv extends EventEmitter {}

let emitter = new InternalEv()

// TODO, this is only a test-ready implementation of an event log.

const streams = new Map()

interface InternalEvent {
  id: string
  stream: string
  event: EventicleEvent
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

  async coldHotStream(config: { stream: string, from: string, handler: (event: EventicleEvent) => Promise<void>, onError: (error: any) => void }): Promise<EventSubscriptionControl> {

    let coldReplay = async() => {
      const str = await dataStore().findEntity("system", "event-stream", { streamId: config.stream })

      if (!str) {
        config.onError(`No such stream ${config.stream}`)
        return
      }

      // todo, improved by having a hot buffer and storing until replay is made.  This seems to pass reliably in process, so .... meh
      emitter.addListener("event", async (ev: InternalEvent) => {
        if (ev.stream == config.stream) {
          await config.handler(ev.event)
        }
      })

      for(let entry in str) {
        await config.handler({
          id: "epic",
          type: "epic",
          data: "woop"
        } as EventicleEvent)
      }
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

    const str = await dataStore().findEntity("system", "event-stream", { streamId: stream })

    if (!str) {
      onError(`No such stream ${stream}`)
      return
    }

    // logger.debug("stream", str)

    // todo, should be done in the datastore.
    // let streamEntries = str.sort((a, b) => a.createdAt.getDate() - b.createdAt.getDate())

    for(let entry of str) {
      // await handler(await decryptEvent(entry.internal))
      await handler(entry.content.internal)
    }

    onDone()

    return {
      close: async () => {

      }
    }
  }

  async emit (event: EventicleEvent[], stream: string) {

    // let ev = await encryptEvent(event)

    for (let ev of event) {

      ev.createdAt = new Date().getTime()

      await dataStore().createEntity("system", "event-stream", {
        streamId: stream, internal: ev
      })

      let internal = {
        event: ev, stream, id: ev.id
      } as InternalEvent
      // TODO, remove when coldHot ports to event log
      emitter.emit("event", internal)

      getStream(stream).items.push(internal)
    }
    await tickSubs()
  }

  async hotStream(stream: string,
                  consumerName: string,
                  handler: (event: EventicleEvent) => Promise<void>,
                  onError: (error: any) => void) {
    //todo, ACTUALLY REMOVE THE SUB, this is a resource leak
    let tombstoned = false
    let exec = async (ev: InternalEvent) => {
      if (tombstoned) return
      if (ev.stream == stream) {
        // await handler(await decryptEvent(ev.event))
        await handler(ev.event)
      }
    }

    subscriptions.push(new StreamSubscription(`${stream}:${consumerName}`, getStream(stream), exec))

    return {
      close: async () => {
        tombstoned = true
      }
    }
  }
}
