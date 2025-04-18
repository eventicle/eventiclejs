import * as avro from 'avsc';
import {logger, getApmTraceparent} from "@eventicle/eventicle-utilities";
import { EventClientCodec, EncodedEvent, EventicleEvent } from './event-client';

/**
 * Abstract base class for encoding and decoding events using Avro.
 * Implements the EventClientCodec interface to handle conversion of events
 * to and from Avro encoded buffers.
 *
 * This class provides functions to:
 * - Decode an encoded event into an EventicleEvent object.
 * - Encode an EventicleEvent object into an EncodedEvent.
 * - Parse Avro schema/protocol and register Avro types.
 *
 * Concrete implementations must implement the `loadAvro` method to initialize
 * and load the required Avro schemas.
 */
export abstract class AvroCodec implements EventClientCodec {

  protected _types = new Map<String, avro.Type>();

  /**
   * Retrieves the Avro type for a given event type name.
   *
   * @param {string} typeName - The name of the event type to retrieve.
   * @return {avro.Type | undefined} The corresponding Avro Type or undefined if not found.
   */
  protected getAvroType(typeName: string): avro.Type | undefined {
    return this._types.get(typeName);
  }
  /**
   *
   */
  constructor() {
    this.loadAvro();
  }

  /**
   * Decodes an encoded event into a EventicleEvent object.
   *
   * @param {EncodedEvent} encoded - The encoded event containing headers and buffer data to be decoded.
   * @return {Promise<EventicleEvent>} The decoded EventicleEvent object.
   * @throws {Error} Throws an error if the input encoded object is undefined or if decoding fails.
   */
  async decode(encoded: EncodedEvent): Promise<EventicleEvent> {

    const addTrace = (ev: EventicleEvent) => {
      if (encoded.headers.traceparent && encoded.headers.traceparent.toString().length > 0) {
        (ev as any).apmTrace = encoded.headers.traceparent.toString();
      }
      return ev
    }

    if (!encoded) {
      throw new Error("Can't pass undefined into decode")
    }
    const type = this._types.get(encoded.headers.type.toString());
    try {
      return addTrace(type.fromBuffer(encoded.buffer));
    } catch (e) {
      const buffer = encoded.buffer.slice(10);
      try {
        return addTrace(type.fromBuffer(buffer));
      } catch (e) {
        try {
          return addTrace(JSON.parse(encoded.buffer.toString()));
        } catch (e) {

          const headers = {} as any;
          Object.keys(encoded.headers).forEach((value) => headers[value] = encoded.headers[value].toString('utf8'));

          logger.error('Message has failed to decode (tried vanilla avro, byte trimmed avro and JSON, all failed. Logging out and marking as processed to avoid poisoning the queue', {
            error: 'failed_processing',
            message_buffer: encoded.buffer.toString('base64'),
            headers
          });
          return {
            type: 'fake-event',
            domainId: '',
            createdAt: new Date().getTime(),
            id: 'unknown',
            source: 'internal-failure',
            data: {
              message: e.message
            }
          };
        }
      }
    }
  }

  async encode(event: EventicleEvent): Promise<EncodedEvent> {
    const type = this._types.get(event.type);

    let traceparent
    if (event.hasOwnProperty("apmTrace")) {
      traceparent = (event as any).apmTrace
    } else {
      traceparent = getApmTraceparent()
    }

    try {
      return {
        timestamp: event.createdAt,
        key: event.domainId,
        headers: {
          id: event.id,
          type: event.type,
          source: event.source,
          causedById: event.causedById || '',
          causedByType: event.causedByType || '',
          domainId: event.domainId,
          createdAt: `${event.createdAt}`,
          traceparent:  traceparent || ""
        },
        buffer: type.toBuffer(event)
      };
    } catch (e) {
      const borkedPaths = [] as string[];
      await new Promise<void>((resolve, rej) => {
        type.isValid(event, {
          errorHook: (path1) => {
            borkedPaths.push(path1.join('.'))
            resolve()
          }
        });
      })
      logger.error(`Error encoding type ${type} on fields: ${JSON.stringify(borkedPaths)}`, {
        type, errors: borkedPaths, value: event
      });
      throw e;
    }
  }

  abstract loadAvro();

  protected parseProtocol(protocol: string, registry: any) {
    const schema = avro.readProtocol(protocol);
      schema.types.forEach((schemaType: any) => {
        const type = avro.Type.forSchema(schemaType, {
          registry
        });
        this._types.set(type.name, type);
        type.aliases.forEach((value) => this._types.set(value, type));
      });
  }
}
