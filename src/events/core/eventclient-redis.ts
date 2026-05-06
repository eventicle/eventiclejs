import Redis, { RedisOptions } from "ioredis";
import {
  EncodedEvent,
  EventClient,
  eventClientCodec,
  EventicleEvent,
  EventSubscriptionControl,
  isRawEvent,
} from "./event-client";
import * as uuid from "uuid";
import { logger } from "@eventicle/eventicle-utilities";
import { maybeRenderError } from "@eventicle/eventicle-utilities/dist/logger-util";
import { eventClientTransactional } from "./eventclient-transactional";
import { pause } from "../../util";

export interface RedisStreamConfig {
  redisOptions: RedisOptions;
  blockTimeoutMs?: number;
  coldBatchSize?: number;
  consumerNamePrefix?: string;
  maxStreamLength?: number;
}

const FIELD_BUFFER = "buf";
const FIELD_KEY = "key";
const FIELD_TIMESTAMP = "ts";
const FIELD_HEADERS = "hdrs";

interface ActiveSubscription {
  running: boolean;
  subscriber?: Redis;
  close: () => Promise<void>;
}

function encodeHeaders(headers: { [key: string]: any }): string {
  return JSON.stringify(headers);
}

function decodeHeaders(raw: string): { [key: string]: any } {
  return JSON.parse(raw);
}

export function buildStreamEntryFields(encoded: EncodedEvent): string[] {
  return [
    FIELD_BUFFER,
    encoded.buffer.toString("base64"),
    FIELD_KEY,
    encoded.key || "",
    FIELD_TIMESTAMP,
    `${encoded.timestamp}`,
    FIELD_HEADERS,
    encodeHeaders(encoded.headers),
  ];
}

export function parseStreamEntry(fields: string[]): EncodedEvent {
  const fieldMap: { [key: string]: string } = {};
  for (let fieldIdx = 0; fieldIdx < fields.length; fieldIdx += 2) {
    fieldMap[fields[fieldIdx]] = fields[fieldIdx + 1];
  }

  return {
    buffer: Buffer.from(fieldMap[FIELD_BUFFER] || "", "base64"),
    key: fieldMap[FIELD_KEY] || "",
    timestamp: parseInt(fieldMap[FIELD_TIMESTAMP] || "0", 10),
    headers: decodeHeaders(fieldMap[FIELD_HEADERS] || "{}"),
  };
}

async function ensureConsumerGroup(
  redis: Redis,
  stream: string,
  groupId: string,
  startId: string
): Promise<void> {
  try {
    await redis.xgroup("CREATE", stream, groupId, startId, "MKSTREAM");
  } catch (error: any) {
    if (error.message && error.message.includes("BUSYGROUP")) {
      logger.debug(
        `Consumer group ${groupId} already exists on stream ${stream}`
      );
    } else {
      throw error;
    }
  }
}

function incrementStreamId(id: string): string {
  const [timestamp, sequence] = id.split("-");
  return `${timestamp}-${parseInt(sequence, 10) + 1}`;
}

async function getStreamLastId(redis: Redis, stream: string): Promise<string | null> {
  const info = await redis.xinfo("STREAM", stream).catch(() => null);
  if (!info) return null;

  const infoArray = info as any[];
  for (let infoIdx = 0; infoIdx < infoArray.length; infoIdx += 2) {
    if (infoArray[infoIdx] === "last-generated-id") {
      return infoArray[infoIdx + 1] as string;
    }
  }
  return null;
}

async function getStreamLength(redis: Redis, stream: string): Promise<number> {
  try {
    return await redis.xlen(stream);
  } catch {
    return 0;
  }
}

class EventclientRedis implements EventClient {
  private publisher: Redis;
  private subscriberPool: Redis[] = [];
  private activeSubscriptions: ActiveSubscription[] = [];
  private connected = false;
  private consumerGroups: string[] = [];
  private config: Required<RedisStreamConfig>;

  constructor(config: RedisStreamConfig) {
    this.config = {
      redisOptions: config.redisOptions,
      blockTimeoutMs: config.blockTimeoutMs ?? 2000,
      coldBatchSize: config.coldBatchSize ?? 100,
      consumerNamePrefix: config.consumerNamePrefix ?? "eventicle",
      maxStreamLength: config.maxStreamLength ?? 0,
    };
  }

  async connect(): Promise<EventclientRedis> {
    this.publisher = new Redis(this.config.redisOptions);

    this.publisher.on("connect", () => {
      this.connected = true;
    });
    this.publisher.on("close", () => {
      this.connected = false;
    });
    this.publisher.on("error", (err) => {
      logger.warn("Redis publisher error", { error: maybeRenderError(err) });
    });

    await new Promise<void>((resolve, reject) => {
      this.publisher.once("ready", () => resolve());
      this.publisher.once("error", (err) => reject(err));
    });

    this.connected = true;
    return this;
  }

  private createSubscriber(): Redis {
    const subscriber = new Redis(this.config.redisOptions);
    subscriber.on("error", (err) => {
      logger.warn("Redis subscriber error", { error: maybeRenderError(err) });
    });
    this.subscriberPool.push(subscriber);
    return subscriber;
  }

  private generateConsumerName(): string {
    return `${this.config.consumerNamePrefix}-${uuid.v4().substring(0, 8)}`;
  }

  async emit(
    events: EventicleEvent[] | EncodedEvent[],
    stream: string
  ): Promise<void> {
    if (events.length === 0) return;

    const pipeline = this.publisher.pipeline();

    for (const event of events) {
      (event as any).stream = stream;

      let encoded: EncodedEvent;

      if (isRawEvent(event)) {
        encoded = event;
      } else {
        (event as EventicleEvent).createdAt =
          (event as EventicleEvent).createdAt || new Date().getTime();
        encoded = await eventClientCodec().encode(event as EventicleEvent);
      }

      const fields = buildStreamEntryFields(encoded);

      if (this.config.maxStreamLength > 0) {
        pipeline.xadd(
          stream,
          "MAXLEN",
          "~",
          `${this.config.maxStreamLength}`,
          "*",
          ...fields
        );
      } else {
        pipeline.xadd(stream, "*", ...fields);
      }
    }

    await pipeline.exec();
  }

  async hotStream(config: {
    parallelEventCount?: number;
    stream: string | string[];
    groupId: string;
    handler: (event: EventicleEvent) => Promise<void>;
    onError: (error: any) => void;
    deleteConsumerGroupOnClose?: boolean;
  }): Promise<EventSubscriptionControl> {
    return this.hotStreamInternal({
      parallelEventCount: config.parallelEventCount,
      rawEvents: false,
      stream: config.stream,
      groupId: config.groupId,
      handler: config.handler,
      onError: config.onError,
      deleteConsumerGroupOnClose: config.deleteConsumerGroupOnClose,
    });
  }

  async hotRawStream(config: {
    parallelEventCount?: number;
    stream: string | string[];
    groupId: string;
    handler: (event: EncodedEvent) => Promise<void>;
    onError: (error: any) => void;
    deleteConsumerGroupOnClose?: boolean;
  }): Promise<EventSubscriptionControl> {
    return this.hotStreamInternal({
      parallelEventCount: config.parallelEventCount,
      rawEvents: true,
      stream: config.stream,
      groupId: config.groupId,
      handler: config.handler,
      onError: config.onError,
      deleteConsumerGroupOnClose: config.deleteConsumerGroupOnClose,
    });
  }

  private async hotStreamInternal(config: {
    parallelEventCount?: number;
    rawEvents: boolean;
    stream: string | string[];
    groupId: string;
    handler: (event: EventicleEvent | EncodedEvent) => Promise<void>;
    onError: (error: any) => void;
    deleteConsumerGroupOnClose?: boolean;
  }): Promise<EventSubscriptionControl> {
    if (this.consumerGroups.includes(config.groupId)) {
      const errorMessage = `Consumer Group has subscribed multiple times, this is a bug, error: ${config.groupId}`;
      logger.error(errorMessage, new Error(errorMessage));
      throw new Error(errorMessage);
    }

    this.consumerGroups.push(config.groupId);

    const streams = Array.isArray(config.stream)
      ? config.stream
      : [config.stream];
    const consumerId = this.generateConsumerName();
    const subscriber = this.createSubscriber();

    for (const stream of streams) {
      await ensureConsumerGroup(subscriber, stream, config.groupId, "$");
    }

    let running = true;

    const pollLoop = async () => {
      while (running) {
        try {
          const results = await this.executeXReadGroup(
            subscriber,
            config.groupId,
            consumerId,
            streams,
            ">",
            this.config.blockTimeoutMs
          );

          if (!results || !running) continue;

          for (const [streamName, messages] of results as any[]) {
            await this.processMessages(
              subscriber,
              streamName,
              messages,
              config.groupId,
              config.rawEvents,
              config.handler,
              config.parallelEventCount
            );
          }
        } catch (error: any) {
          if (!running) break;
          if (error.message?.includes("NOGROUP")) {
            for (const stream of streams) {
              await ensureConsumerGroup(subscriber, stream, config.groupId, "$");
            }
          } else {
            logger.warn("Error in hot stream poll loop", {
              error: maybeRenderError(error),
              groupId: config.groupId,
            });
            config.onError(error);
            await pause(1000);
          }
        }
      }
    };

    const pollPromise = pollLoop();

    const subscription: ActiveSubscription = {
      running: true,
      subscriber,
      close: async () => {
        running = false;
        subscription.running = false;
        await pollPromise.catch(() => {});

        if (config.deleteConsumerGroupOnClose) {
          for (const stream of streams) {
            try {
              await subscriber.xgroup("DESTROY", stream, config.groupId);
              logger.debug(`Deleted consumer group ${config.groupId} on stream ${stream}`);
            } catch (destroyError) {
              logger.warn(`Failed to delete consumer group ${config.groupId}`, destroyError);
            }
          }
        }

        await subscriber.quit();
        this.consumerGroups = this.consumerGroups.filter(
          (cg) => cg !== config.groupId
        );
      },
    };

    this.activeSubscriptions.push(subscription);

    return {
      close: subscription.close,
    };
  }

  async coldStream(config: {
    stream: string;
    parallelEventCount?: number;
    handler: (event: EventicleEvent) => Promise<void>;
    onError: (error: any) => void;
    onDone: () => void;
  }): Promise<EventSubscriptionControl> {
    const subscriber = this.createSubscriber();
    let running = true;
    let closed = false;

    const replayTask = async () => {
      try {
        const streamLength = await getStreamLength(subscriber, config.stream);

        if (streamLength === 0) {
          logger.debug(`Stream ${config.stream} is empty, cold replay done immediately`);
          config.onDone();
          return;
        }

        const lastId = await getStreamLastId(subscriber, config.stream);
        let cursor = "0-0";

        while (running) {
          const entries = (await subscriber.xrange(
            config.stream,
            cursor,
            "+",
            "COUNT",
            this.config.coldBatchSize
          )) as [string, string[]][];

          if (!entries || entries.length === 0) {
            break;
          }

          for (const [entryId, fields] of entries) {
            if (!running) break;

            const encoded = parseStreamEntry(fields);

            try {
              const decoded = await eventClientCodec().decode(encoded);
              if (decoded) {
                decoded.stream = config.stream;
                await config.handler(decoded);
              }
            } catch (handlerError) {
              logger.warn(
                "Cold stream handler failed, skipping message (poison pill protection)",
                {
                  error: maybeRenderError(handlerError),
                  stream: config.stream,
                  entryId,
                }
              );
            }

            cursor = incrementStreamId(entryId);
          }

          if (entries.length < this.config.coldBatchSize) {
            break;
          }

          if (lastId && cursor >= lastId) {
            break;
          }
        }

        if (running) {
          config.onDone();
        }
      } catch (error) {
        logger.error(`Error in cold replay of ${config.stream}:`, error);
        config.onError(error);
      }
    };

    const subscription: ActiveSubscription = {
      running: true,
      subscriber,
      close: async () => {
        running = false;
        subscription.running = false;
        if (!closed) {
          closed = true;
          await subscriber.quit();
        }
      },
    };

    this.activeSubscriptions.push(subscription);

    replayTask();

    return {
      close: subscription.close,
    };
  }

  async coldHotStream(
    config:
      | {
          parallelEventCount?: number;
          rawEvents: true;
          stream: string | string[];
          groupId: string;
          handler: (event: EncodedEvent) => Promise<void>;
          onError: (error: any) => void;
        }
      | {
          parallelEventCount?: number;
          rawEvents: false;
          stream: string | string[];
          groupId: string;
          handler: (event: EventicleEvent) => Promise<void>;
          onError: (error: any) => void;
        }
      | {
          parallelEventCount?: number;
          stream: string | string[];
          groupId: string;
          handler: (event: EventicleEvent) => Promise<void>;
          onError: (error: any) => void;
        }
  ): Promise<EventSubscriptionControl> {
    const rawEvents = (config as any).rawEvents === true;

    if (!config.groupId) {
      logger.trace("Auto set groupId for cold/hot replay");
      config.groupId = uuid.v4();
    }

    if (this.consumerGroups.includes(config.groupId)) {
      const errorMessage = `Consumer Group has subscribed multiple times, error: ${config.groupId}`;
      logger.error(errorMessage, new Error(errorMessage));
      throw new Error(errorMessage);
    }

    this.consumerGroups.push(config.groupId);

    const streams = Array.isArray(config.stream)
      ? config.stream
      : [config.stream];
    const consumerId = this.generateConsumerName();
    const subscriber = this.createSubscriber();

    for (const stream of streams) {
      await ensureConsumerGroup(subscriber, stream, config.groupId, "0");
    }

    let running = true;

    const coldHotLoop = async () => {
      let readingPending = true;

      while (running) {
        try {
          const readId = readingPending ? "0" : ">";

          const results = await this.executeXReadGroup(
            subscriber,
            config.groupId,
            consumerId,
            streams,
            readId,
            readingPending ? 0 : this.config.blockTimeoutMs
          );

          if (!results) {
            if (readingPending) {
              readingPending = false;
            }
            continue;
          }

          let hadPendingMessages = false;

          for (const [streamName, messages] of results as any[]) {
            if (messages.length > 0) {
              hadPendingMessages = true;
            }

            await this.processMessages(
              subscriber,
              streamName,
              messages,
              config.groupId,
              rawEvents,
              config.handler as (
                event: EventicleEvent | EncodedEvent
              ) => Promise<void>,
              config.parallelEventCount
            );
          }

          if (readingPending && !hadPendingMessages) {
            readingPending = false;
            logger.debug(
              `Cold-hot stream ${config.groupId} finished pending messages, switching to live`
            );
          }
        } catch (error: any) {
          if (!running) break;
          if (error.message?.includes("NOGROUP")) {
            for (const stream of streams) {
              await ensureConsumerGroup(
                subscriber,
                stream,
                config.groupId,
                "0"
              );
            }
          } else {
            logger.warn("Error in cold-hot stream poll loop", {
              error: maybeRenderError(error),
              groupId: config.groupId,
            });
            config.onError(error);
            await pause(1000);
          }
        }
      }
    };

    const loopPromise = coldHotLoop();

    const subscription: ActiveSubscription = {
      running: true,
      subscriber,
      close: async () => {
        running = false;
        subscription.running = false;
        await loopPromise.catch(() => {});
        await subscriber.quit();
        this.consumerGroups = this.consumerGroups.filter(
          (cg) => cg !== config.groupId
        );
      },
    };

    this.activeSubscriptions.push(subscription);

    return {
      close: subscription.close,
    };
  }

  private async executeXReadGroup(
    subscriber: Redis,
    groupId: string,
    consumerId: string,
    streams: string[],
    readId: string,
    blockTimeoutMs: number
  ): Promise<any[] | null> {
    const args: (string | number)[] = [
      "GROUP",
      groupId,
      consumerId,
    ];

    if (blockTimeoutMs > 0) {
      args.push("BLOCK", blockTimeoutMs);
    }

    args.push("COUNT", this.config.coldBatchSize);
    args.push("STREAMS", ...streams);

    for (const _stream of streams) {
      args.push(readId);
    }

    return subscriber.call("XREADGROUP", ...args) as Promise<any[] | null>;
  }

  private async processMessages(
    subscriber: Redis,
    streamName: string,
    messages: [string, string[]][],
    groupId: string,
    rawEvents: boolean,
    handler: (event: EventicleEvent | EncodedEvent) => Promise<void>,
    parallelEventCount?: number
  ): Promise<void> {
    const concurrency = parallelEventCount && parallelEventCount > 1
      ? parallelEventCount
      : 1;

    for (let batchStart = 0; batchStart < messages.length; batchStart += concurrency) {
      const batch = messages.slice(batchStart, batchStart + concurrency);

      await Promise.all(
        batch.map(async ([messageId, fields]) => {
          const encoded = parseStreamEntry(fields);

          try {
            if (rawEvents) {
              await handler(encoded);
            } else {
              const decoded = await eventClientCodec().decode(encoded);
              if (!decoded) return;

              decoded.stream = streamName;

              logger.debug(
                `Received event ${decoded.id} on ${groupId} on stream ${streamName}`,
                decoded
              );
              await handler(decoded);
            }
          } catch (handlerError) {
            logger.warn(
              "Consumer failed to process message, dropping to avoid poisoning queue",
              {
                error: maybeRenderError(handlerError),
                consumer: groupId,
                stream: streamName,
                messageId,
              }
            );
          }

          try {
            await subscriber.xack(streamName, groupId, messageId);
          } catch (ackError) {
            logger.warn("Failed to XACK message", {
              error: maybeRenderError(ackError),
              stream: streamName,
              groupId,
              messageId,
            });
          }
        })
      );
    }
  }

  async clear(streams?: string[]): Promise<void> {
    if (streams) {
      for (const stream of streams) {
        await this.publisher.del(stream).catch(() => {});
      }
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  async shutdown(): Promise<void> {
    const closedSubscribers = new Set<Redis>();

    for (const subscription of this.activeSubscriptions) {
      if (subscription.subscriber) {
        closedSubscribers.add(subscription.subscriber);
      }
      await subscription.close().catch(() => {});
    }
    this.activeSubscriptions.length = 0;
    this.consumerGroups.length = 0;

    for (const subscriber of this.subscriberPool) {
      if (!closedSubscribers.has(subscriber)) {
        await subscriber.quit().catch(() => {});
      }
    }
    this.subscriberPool.length = 0;

    if (this.publisher) {
      await this.publisher.quit().catch(() => {});
    }

    this.connected = false;
  }
}

/**
 * Factory function to create a Redis Streams-backed EventClient.
 *
 * The returned client implements the full EventClient interface using
 * Redis Streams for event persistence and delivery. It supports
 * hot, cold, and cold-hot subscriptions with consumer group
 * load balancing.
 *
 * @param config Redis connection and stream configuration
 * @returns A connected EventClient wrapped with transactional support
 */
export async function eventClientOnRedis(
  config: RedisStreamConfig
): Promise<EventClient> {
  return eventClientTransactional(await new EventclientRedis(config).connect());
}
