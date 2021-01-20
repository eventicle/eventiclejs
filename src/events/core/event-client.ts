/**
 * Low level event stream client
 */
import * as uuid from "uuid"
import {getApmTraceparent} from "../../apm";

let EVENT_SOURCE = "unknown-service"

export function setEventSourceName(name: string) {
  EVENT_SOURCE = name
}

export function eventSourceName(): string {
  return EVENT_SOURCE
}

export interface EncodedEvent {
  buffer: Buffer
  headers: { [key: string]: any }
}

export interface EventClientCodec {
  encode: (event: EventicleEvent) => Promise<EncodedEvent>
  decode: (encoded: EncodedEvent) => Promise<EventicleEvent>
}

class EventClientJsonCodec implements EventClientCodec {
  decode(encoded: EncodedEvent): Promise<EventicleEvent> {
    const addTrace = (ev: EventicleEvent) => {
      if (encoded.headers.traceparent && encoded.headers.traceparent.toString().length > 0) {
        (ev as any).apmTrace = encoded.headers.traceparent.toString();
      }
      return ev
    }

    let content = addTrace(JSON.parse(encoded.buffer.toString("utf8")))
    return Promise.resolve(content);
  }

  encode(event: EventicleEvent): Promise<EncodedEvent> {
    let traceparent
    if (event.hasOwnProperty("apmTrace")) {
      traceparent = (event as any).apmTrace
    } else {
      traceparent = getApmTraceparent()
    }

    return Promise.resolve({
      headers: {
        type: event.type,
        domainId: event.domainId || "",
        id: event.id || uuid.v4(),
        source: event.source || "",
        causedById: event.causedById || "",
        causedByType: event.causedByType || "",
        createdAt: `${event.createdAt}`,
        traceparent: traceparent || ""
      },
      buffer: Buffer.from(JSON.stringify(event), "utf8")
    });
  }
}


export interface EventicleEvent {
  id?: string
  type: string
  source?: string
  causedById?: string
  causedByType?: string
  domainId?: string
  createdAt?: number
  data: any
}

export interface EventSubscriptionControl {
  close: () => Promise<void>
}

export interface EventClient {
  /**
   *
   * @param event
   * @param stream
   */
  emit: (event: EventicleEvent[], stream: string) => Promise<void>
  /**
   * Play from persisted storage
   * @param stream
   * @param from
   * @param handler
   * @param onError
   * @param onDone
   */
  coldStream: (stream: string,
               handler: (event: EventicleEvent) => Promise<void>,
               onError: (error: any) => void,
               onDone: () => void) => Promise<EventSubscriptionControl>
  /**
   * Only play hot data.
   * @param stream
   * @param consumerName
   * @param handler
   * @param onError
   */
  hotStream: (stream: string | string[],
              consumerName: string,
              handler: (event: EventicleEvent) => Promise<void>,
              onError: (error: any) => void) => Promise<EventSubscriptionControl>

  /**
   * Play from persisted storage the continue from in memory
   * @param stream
   * @param from
   * @param handler
   * @param onError
   * @param onDone
   */
  coldHotStream: (config: {
    stream: string | string[],
    groupId?: string,
    handler: (event: EventicleEvent) => Promise<void>,
    onError: (error: any) => void
  }) => Promise<EventSubscriptionControl>
}

let EVENT_CLIENT: EventClient
let EVENT_CODEC: EventClientCodec = new EventClientJsonCodec()

export function setEventClientCodec(cl: EventClientCodec) {
  EVENT_CODEC = cl
}

export function setEventClient(cl: EventClient) {
  EVENT_CLIENT = cl
}

export function eventClient(): EventClient {
  return EVENT_CLIENT
}

export function eventClientCodec(): EventClientCodec {
  return EVENT_CODEC
}
