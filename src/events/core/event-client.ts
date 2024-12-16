/**
 * Low level event stream client
 */
import * as uuid from "uuid"
import {getApmTraceparent} from "@eventicle/eventicle-utilities";

let EVENT_SOURCE = "unknown-service"

export function setEventSourceName(name: string) {
  EVENT_SOURCE = name
}

export function eventSourceName(): string {
  return EVENT_SOURCE
}

export function isRawEvent(event: EncodedEvent | EventicleEvent): event is EncodedEvent {
  return event.hasOwnProperty("buffer")
}

export interface EncodedEvent {
  buffer: Buffer
  key: string
  timestamp: number,
  headers: { [key: string]: any }
}

/**
 * Convert {@link EventicleEvent} to/ from {@link EncodedEvent}.
 *
 * EncodedEvent is suitable for the {@link EventClient} implementations to send on the wire, as it
 * is a Buffer and a set of message headers.
 */
export interface EventClientCodec {
  /**
   * Convert a raw event binary (as a {@link EncodedEvent}) into a {@link EventicleEvent}
   */
  encode: (event: EventicleEvent) => Promise<EncodedEvent>
  decode: (encoded: EncodedEvent) => Promise<EventicleEvent>
}

export class EventClientJsonCodec implements EventClientCodec {
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
      timestamp: event.createdAt,
      key: event.domainId || event.id,
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

export interface EventicleEvent<T = any> {
  id?: string
  type: string
  source?: string
  causedById?: string
  causedByType?: string
  stream?: string
  domainId?: string
  createdAt?: number
  data: T
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
  emit: (event: EventicleEvent[] | EncodedEvent[], stream: string) => Promise<void>
  /**
   * Play from persisted storage
   */
  coldStream: (config: {
    stream: string,
    handler: (event: EventicleEvent) => Promise<void>,
    onError: (error: any) => void,
    onDone: () => void
  }) => Promise<EventSubscriptionControl>
  /**
   * Only play hot data.
   */
  hotStream: (config: {
    parallelEventCount?: number,
    stream: string | string[],
    groupId: string,
    handler: (event: EventicleEvent) => Promise<void>,
    onError: (error: any) => void
  }) => Promise<EventSubscriptionControl>

  /**
   * Only play hot data.
   */
  hotRawStream: (config: {
    parallelEventCount?: number,
    stream: string | string[],
    groupId: string,
    handler: (event: EncodedEvent) => Promise<void>,
    onError: (error: any) => void
  }) => Promise<EventSubscriptionControl>


  /**
   * Play from persisted storage the continue from in memory
   */
  coldHotStream: (config: {
    parallelEventCount?: number,
    rawEvents: true,
    stream: string | string[],
    groupId: string,
    handler: (event: EncodedEvent) => Promise<void>,
    onError: (error: any) => void
  } | {
    parallelEventCount?: number,
    rawEvents: false,
    stream: string | string[],
    groupId: string,
    handler: (event: EventicleEvent) => Promise<void>,
    onError: (error: any) => void
  } | {
    parallelEventCount?: number,
    stream: string | string[],
    groupId: string,
    handler: (event: EventicleEvent) => Promise<void>,
    onError: (error: any) => void
  }) => Promise<EventSubscriptionControl>

  shutdown: () => Promise<void>
  isConnected: () => boolean
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

export function isEncodedEvent(event: EventicleEvent | EncodedEvent): event is EncodedEvent {
  return "key" in event
}
