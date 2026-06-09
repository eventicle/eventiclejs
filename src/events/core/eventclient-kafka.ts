import {Kafka, KafkaConfig, Consumer, ConsumerConfig, ConsumerRunConfig, Message} from "@confluentinc/kafka-javascript/lib/kafkajs";
import {
  EncodedEvent,
  EventClient,
  eventClientCodec,
  EventicleEvent,
  EventSubscriptionControl, isRawEvent
} from "./event-client";
import * as uuid from "uuid"
import {logger} from "@eventicle/eventicle-utilities";
import {ThrottledProducer} from "./kafka-throttle";
import {eventClientTransactional} from "./eventclient-transactional";
import {maybeRenderError} from "@eventicle/eventicle-utilities/dist/logger-util";
import {pause} from "../../util";

interface KafkaClientHealth {
  healthy: boolean
  consumers: { [key: string]: HealthCheckStatus }
  producer: HealthCheckStatus
}

export interface HealthCheckStatus {
  name: string
  status: "connected" | "disconnected" | "error" | "active" | "killed"
  healthy: boolean
}

let kafka: Kafka

let producerHealth: HealthCheckStatus
let consumerGroups = []

const consumers: Consumer[] = []

let consumerGroupHealth: {
  [key: string]: HealthCheckStatus
} = {}
let consumerConfigFactory: ConsumerConfigFactory = {
  consumerConfig: (stream, consumerName, type) => {
    return {
      maxWaitTimeInMs: 100,
      groupId: consumerName,
      allowAutoTopicCreation: true,
    }
  },
  consumerRunConfig: (stream, consumerName, type, partitionsConsumedConcurrently) => {
    if (type === "COLD") {
      return {
        partitionsConsumedConcurrently: partitionsConsumedConcurrently ?? 1,
      }
    }
    const config =  {
      partitionsConsumedConcurrently: partitionsConsumedConcurrently ?? 50,
    }
    logger.debug(`Creating topic consumer ${consumerName} for stream ${stream} with run config `, config)
    return config
  }
}

/**
 * Access the low level kafka client used by the event client
 */
export function getKafkaClient(): Kafka {
  return kafka;
}

export function getKafkaClientHealth(): KafkaClientHealth {
  return {
    consumers: consumerGroupHealth,
    producer: producerHealth,
    healthy: producerHealth.healthy && !Object.keys(consumerGroupHealth).find(value => !consumerGroupHealth[value].healthy)
  }
}

export async function connectBroker(config: KafkaConfig) {
  kafka = new Kafka({kafkaJS: config} as any)
}

export type TopicFailureConfiguration = {
  createTopic: boolean,
  numPartitions?: number,
  replicationFactor?: number,
  configEntries?: {
    name: string, value: string
  }[]
}
let onTopicFailure = async (topicName: string) => {
  return {
    createTopic: false
  } as TopicFailureConfiguration
}

export async function maybeCreateTopic(config: TopicFailureConfiguration, topicName: string, reason) {
  if (config.createTopic) {
    logger.warn(`Error when connecting to topic ${topicName}, will create topic`, {
      topicName, maybeRenderError: reason
    })

    const admin = kafka.admin()

    try {
      await admin.connect()
      const topics = await admin.listTopics()
      if (topics.find(val => val == topicName)) {
        return;
      }
      await admin.createTopics({
        topics: [{
          topic: topicName,
          numPartitions: config.numPartitions ?? undefined,
          replicationFactor: config.replicationFactor ?? undefined,
          configEntries: config.configEntries ?? [],
        }]
      })
      logger.info(`Created topic ${topicName} in fallback`)
      await pause(5000)
    } catch (e) {
      logger.warn(`Failed to create topic ${topicName} in fallback`, e)
    } finally {
      await admin.disconnect()
    }
  }
}

function filterUndefined(obj: Record<string, any>): Record<string, any> {
  return Object.fromEntries(Object.entries(obj).filter(([_, v]) => v !== undefined))
}

// These keys were valid in kafkajs run() config but are now consumer-level config in confluent.
// Strip them from the run config to maintain backward compatibility with existing ConsumerConfigFactory implementations.
const RUN_CONFIG_DISALLOWED_KEYS = ['autoCommit', 'autoCommitInterval', 'autoCommitThreshold']

function sanitizeRunConfig(config: Record<string, any>): Record<string, any> {
  return Object.fromEntries(Object.entries(config).filter(([k]) => !RUN_CONFIG_DISALLOWED_KEYS.includes(k)))
}

async function connectConsumerWithOptionalCreation<T>(topicNames: string | string[], consumer: Consumer, executor: (retry?: boolean) => Promise<T>) {
  let topics: string[]
  if (!Array.isArray(topicNames)) {
    topics = [topicNames]
  } else {
    topics = topicNames
  }

  await consumer.connect()

  return executor(false).catch(async reason => {
    await Promise.all(topics.map(async topicName => {
      logger.warn(`Error when connecting to topic ${topicName}, checking fallback configuration`, {
        topicName, maybeRenderError: reason
      })

      const config = await onTopicFailure(topicName)
      await maybeCreateTopic(config, topicName, reason);
    }))
    return executor(true)
  })
}

/**
 * Represents an Event Client with Kafka integration. Provides methods to manage Kafka connections,
 * publish events, and subscribe to streams for event processing.
 */
class EventclientKafka implements EventClient {

  throttle: ThrottledProducer

  broker(): Kafka {
    return kafka
  }

  async connect(): Promise<EventclientKafka> {
    producerHealth = {
      healthy: false, status: "disconnected", name: "message-sender"
    }
    this.throttle = new ThrottledProducer(this.broker(), {}, producerHealth, onTopicFailure)
    await this.throttle.connect()
    return this
  }

  async clear(topics: string[]) {
    let admin = kafka.admin()
    await admin.connect()
    let existingTopics = await admin.listTopics()

    for (let topic of topics) {
      if (existingTopics.includes(topic)) {
        admin.deleteTopics({
          topics: [topic]
        }).catch(reason => logger.debug("Error tpic cleanup", reason))
      }
    }
  }

  async coldHotStream(config: {
    rawEvents?: boolean,
    parallelEventCount?: number,
    stream: string | string[],
    groupId?: string,
    handler: (event: EventicleEvent | EncodedEvent) => Promise<void>,
    onError: (error: any) => void
  }): Promise<EventSubscriptionControl> {

    let id = uuid.v4()
    if (!config.groupId) {
      logger.trace("Auto set groupId for cold/hot replay")
      config.groupId = uuid.v4()
    }

    let healthStatus: HealthCheckStatus = {
      name: config.groupId, healthy: false, status: "disconnected"
    }
    consumerGroupHealth[healthStatus.name] = healthStatus

    if (consumerGroups.includes(config.groupId)) {
      logger.error("Consumer Group has subscribed multiple times, error: " + config.groupId, new Error("Consumer Group has subscribed multiple times, error " + config.groupId))
      throw new Error("Consumer Group has subscribed multiple times, error " + config.groupId)
    }

    consumerGroups.push(config.groupId)

    let newConf = consumerConfigFactory.consumerConfig(config.stream, config.groupId, "COLD_HOT")

    let cons = kafka.consumer({
      kafkaJS: filterUndefined({
        groupId: newConf.groupId || config.groupId,
        fromBeginning: true,
        autoCommit: true,
        autoCommitInterval: 500,
        sessionTimeout: newConf.sessionTimeout,
        rebalanceTimeout: newConf.rebalanceTimeout,
        heartbeatInterval: newConf.heartbeatInterval,
        maxWaitTimeInMs: newConf.maxWaitTimeInMs,
      })
    } as any)

    consumers.push(cons)

    await connectConsumerWithOptionalCreation(config.stream, cons, async (retry) => {
      healthStatus.healthy = true
      healthStatus.status = "connected"

      const topics = Array.isArray(config.stream) ? config.stream : [config.stream]
      await cons.subscribe({topics, replace: retry})

      let newRunConf = sanitizeRunConfig(consumerConfigFactory.consumerRunConfig(config.stream, config.groupId, "COLD_HOT", config.parallelEventCount))
      await cons.run({
        ...newRunConf,
        eachMessage: async payload => {
          logger.debug(`[${config.groupId}] message received on sub id ` + id, payload)

          try {
            if (config.rawEvents) {
              await config.handler({
                timestamp: payload.message.timestamp ? parseInt(payload.message.timestamp) : 0,
                key: payload.message.key ? payload.message.key.toString() : null,
                buffer: payload.message.value,
                headers: payload.message.headers
              })
            } else {
              let decoded = await eventClientCodec().decode({
                timestamp: parseInt(payload.message.timestamp),
                key: payload.message.key ? payload.message.key.toString() : null,
                headers: payload.message.headers,
                buffer: payload.message.value
              })
              if (!decoded) {
                return;
              }

              decoded.stream = payload.topic

              logger.debug(`Received event ${decoded.id} on ${config.groupId} on topic ${payload.topic}`, decoded)
              await config.handler(decoded)
            }
          } catch (e) {
            logger.warn("Consumer failed to process message, dropping to avoid poisoning queue", {
              error: maybeRenderError(e), consumer: config.groupId, stream: config.stream
            });
          }
        }
      })
    })

    return {
      close: async () => {
        await cons.disconnect()
        consumerGroups = consumerGroups.filter(value => value !== config.groupId)
      }
    }
  }

  async coldStream(config: {
    stream: string,
    parallelEventCount?: number,
    handler: (event: EventicleEvent) => Promise<void>,
    onError: (error: any) => void,
    onDone: () => void
  }): Promise<EventSubscriptionControl> {

    const groupId = `cold-replay-${uuid.v4()}`
    let newConf = consumerConfigFactory.consumerConfig(config.stream, groupId, "COLD")

    let cons = kafka.consumer({
      kafkaJS: filterUndefined({
        groupId: groupId,
        fromBeginning: true,
        autoCommit: true,
        autoCommitInterval: 500,
        sessionTimeout: 60000,
        rebalanceTimeout: 60000,
        heartbeatInterval: 3000,
        maxWaitTimeInMs: newConf.maxWaitTimeInMs,
      })
    } as any)

    const latestOffsets = new Map();
    const consumedOffsets = new Map();
    const emptyPartitions = new Set();
    const partitionsWithMessages = new Set();
    let allPartitions = [];
    let messagesProcessed = false;

    let adm = kafka.admin()
    try {
      await adm.connect()

      const metadata = await adm.fetchTopicMetadata({ topics: [config.stream] }).catch(async reason => {
        return null
      })

      let topicMetadata = metadata ? metadata.find(t => t.name === config.stream) : null

      if (!topicMetadata) {
        const createConfig = await onTopicFailure(config.stream);
        await maybeCreateTopic(createConfig, config.stream, new Error('Topic not found in metadata'));

        const newMetadata = await adm.fetchTopicMetadata({topics: [config.stream]});
        const newTopicMetadata = newMetadata.find(t => t.name === config.stream);

        if (!newTopicMetadata) {
          throw new Error(`Failed to create topic ${config.stream}`);
        }

        topicMetadata = newTopicMetadata;
      }

      allPartitions = topicMetadata.partitions.map(p => p.partitionId)

      let topicOffsets = await adm.fetchTopicOffsets(config.stream)

      if (allPartitions.length !== topicOffsets.length) {
        logger.warn(`Mismatch between metadata partitions (${allPartitions.length}) and offset partitions (${topicOffsets.length})`)
      }

      allPartitions.forEach(partition => {
        consumedOffsets.set(partition, BigInt(-1))
      })

      topicOffsets.forEach(({ partition, high }) => {
        const highOffset = BigInt(high);
        latestOffsets.set(partition, highOffset);

        if (highOffset === BigInt(0)) {
          emptyPartitions.add(partition);
        } else {
          partitionsWithMessages.add(partition);
        }

        logger.debug(`Partition ${partition} has high offset ${high}`)
      })
    } finally {
      await adm.disconnect()
    }

    const partitionsToProcess = allPartitions.length;

    const serializableLatestOffsets = {};
    latestOffsets.forEach((value, key) => {
      serializableLatestOffsets[key] = value.toString();
    });

    logger.debug(`Cold replay of ${config.stream} by [${groupId}], partitions:`, {
      allPartitions,
      partitionsWithMessages: Array.from(partitionsWithMessages),
      emptyPartitions: Array.from(emptyPartitions),
      latestOffsets: serializableLatestOffsets
    });

    try {
      await connectConsumerWithOptionalCreation(config.stream, cons, async (retry) => {
        const topics = [config.stream]
        await cons.subscribe({topics, replace: retry})
      })

      let newRunConf = sanitizeRunConfig(consumerConfigFactory.consumerRunConfig(config.stream, groupId, "COLD", config.parallelEventCount))

      let stuckCheckInterval;
      let lastActivity = Date.now();
      const seenPartitions = new Set();

      stuckCheckInterval = setInterval(() => {
        const now = Date.now();
        const timeWithoutActivity = now - lastActivity;

        if (timeWithoutActivity > 10000) {
          const serializableConsumedOffsets = {};
          consumedOffsets.forEach((value, key) => {
            serializableConsumedOffsets[key] = value.toString();
          });

          logger.debug(`Cold replay has been idle for ${timeWithoutActivity}ms. Checking state:`, {
            seenPartitions: Array.from(seenPartitions),
            consumedOffsets: serializableConsumedOffsets,
            partitionsWithMessages: Array.from(partitionsWithMessages)
          });

          partitionsWithMessages.forEach(partition => {
            if (!seenPartitions.has(partition)) {
              logger.warn(`Ignoring partition ${partition} that has messages but wasn't seen`);
            }
          });

          clearInterval(stuckCheckInterval);
          config.onDone();
          setTimeout(() => {
            cons.disconnect();
          }, 3000);
        }
      }, 10000);

      await cons.run({
        ...newRunConf,
        eachMessage: async ({ topic, partition, message }) => {
          lastActivity = Date.now();
          seenPartitions.add(partition);

          logger.trace(`Cold message from partition ${partition}, offset ${message.offset}`)
          try {
            let decoded = await eventClientCodec().decode({
              timestamp: parseInt(message.timestamp),
              key: message.key ? message.key.toString() : null,
              headers: message.headers,
              buffer: message.value
            })

            decoded.stream = topic

            await config.handler(decoded)
            messagesProcessed = true;
          } finally {
            consumedOffsets.set(partition, BigInt(message.offset));

            const allCaughtUp = Array.from(latestOffsets.entries()).every(([partition, endOffset]) => {
              if (emptyPartitions.has(partition)) {
                return true;
              }
              const currentOffset = consumedOffsets.get(partition);
              return currentOffset >= endOffset - BigInt(1);
            });

            if (allCaughtUp) {
              const serializableConsumedOffsets = {};
              const serializableLatestOffsets = {};

              consumedOffsets.forEach((value, key) => {
                serializableConsumedOffsets[key] = value.toString();
              });

              latestOffsets.forEach((value, key) => {
                serializableLatestOffsets[key] = value.toString();
              });

              logger.debug(`Group ID [${groupId}] finishes cold replay`, {
                stream: config.stream,
                seenPartitions: Array.from(seenPartitions),
                partitionsWithMessages: Array.from(partitionsWithMessages),
                consumedOffsets: serializableConsumedOffsets,
                latestOffsets: serializableLatestOffsets,
                messagesProcessed
              });

              clearInterval(stuckCheckInterval);

              await pause(5000)
              config.onDone();
              setTimeout(() => {
                cons.disconnect();
              }, 3000)
            }
          }
        }
      });

      if (emptyPartitions.size === partitionsToProcess) {
        logger.debug(`Topic ${config.stream} is completely empty, finishing immediately`);
        clearInterval(stuckCheckInterval);
        config.onDone();
        await cons.disconnect();
        return {
          close: async () => {}
        };
      }
    } catch (error) {
      logger.error(`Error in cold replay of ${config.stream}:`, error);
      config.onError(error);
      await cons.disconnect().catch(e => logger.error("Error disconnecting consumer:", e));
    }

    return {
      close: async () => {
        await cons.disconnect().catch(e => logger.error("Error disconnecting consumer:", e));
      }
    }
  }

  async emit(events: EventicleEvent[] | EncodedEvent[], stream: string): Promise<void> {

    const messages = await Promise.all(events.map(async (event: EventicleEvent | EncodedEvent )  => {

      (event as any).stream = stream;

      let kafkaMessage: Message

      if (isRawEvent(event)) {
        kafkaMessage ={
          value: event.buffer,
          key: event.key,
          timestamp: `${event.timestamp}`,
          headers: event.headers
        }
      } else {
        let encoded = await eventClientCodec().encode(event)
        kafkaMessage ={
          value: encoded.buffer,
          key: encoded.key,
          timestamp: `${event.createdAt}`,
          headers: encoded.headers
        }
      }

      return kafkaMessage
    }))

    if (messages.length > 0) {
      await this.throttle.send(messages, stream)
    }
  }

  private async hotStreamInternal(
    config: {
      parallelEventCount?: number
      rawEvents?: boolean,
      stream: string | string[],
      consumerName: string,
      consumer: (event: EventicleEvent | EncodedEvent) => Promise<void>,
      onError: (error: any) => void,
      deleteConsumerGroupOnClose?: boolean
    }): Promise<EventSubscriptionControl> {
    if (consumerGroups.includes(config.consumerName)) {
      logger.error("Consumer Group has subscribed multiple times, this is a bug, error: " + config.consumerName, new Error("Consumer Group has subscribed multiple times, this is a bug,  error " + config.consumerName))
      throw new Error("Consumer Group has subscribed multiple times, this is a bug, error " + config.consumerName)
    }

    consumerGroups.push(config.consumerName)
    let healthStatus: HealthCheckStatus = {
      name: config.consumerName, healthy: false, status: "disconnected"
    }
    consumerGroupHealth[healthStatus.name] = healthStatus

    let newConf = consumerConfigFactory.consumerConfig(config.stream, config.consumerName, "HOT")

    let cons = kafka.consumer({
      kafkaJS: filterUndefined({
        groupId: newConf.groupId || config.consumerName,
        fromBeginning: false,
        autoCommit: true,
        autoCommitInterval: 500,
        sessionTimeout: newConf.sessionTimeout,
        rebalanceTimeout: newConf.rebalanceTimeout,
        heartbeatInterval: newConf.heartbeatInterval,
        maxWaitTimeInMs: newConf.maxWaitTimeInMs,
      })
    } as any)

    consumers.push(cons)

    await connectConsumerWithOptionalCreation(config.stream, cons, async (retry) => {
      healthStatus.healthy = true
      healthStatus.status = "connected"

      const topics = Array.isArray(config.stream) ? config.stream : [config.stream]
      await cons.subscribe({topics, replace: retry})

      let newRunConf = sanitizeRunConfig(consumerConfigFactory.consumerRunConfig(config.stream, config.consumerName, "HOT", config.parallelEventCount))

      await cons.run({
        ...newRunConf,
        eachMessage: async (payload) => {
          try {
            let encodedEvent = {
              timestamp: parseInt(payload.message.timestamp),
              key: payload.message.key ? payload.message.key.toString() : null,
              headers: payload.message.headers, buffer: payload.message.value
            } as EncodedEvent

            if (config.rawEvents) {
              await config.consumer(encodedEvent)
            } else {
              let decoded = await eventClientCodec().decode(encodedEvent)
              if (!decoded) {
                return;
              }

              decoded.stream = payload.topic

              await config.consumer(decoded)
            }
          } catch (e) {
            logger.warn("Consumer failed to process message, dropping to avoid poisoning queue", {
              error: maybeRenderError(e), consumer: config.consumerName, stream: config.stream
            })
          }
        }
      })
    })

    return {
      close: async () => {
        if (config.deleteConsumerGroupOnClose) {
          const admin = kafka.admin()
          try {
            await admin.connect()
            await admin.deleteGroups([config.consumerName])
            logger.debug(`Deleted consumer group ${config.consumerName}`)
          } catch (error) {
            logger.warn(`Failed to delete consumer group ${config.consumerName}`, error)
          } finally {
            await admin.disconnect()
          }
        }
        await cons.disconnect()
        healthStatus.healthy = false
        healthStatus.status = "disconnected"
        consumerGroups = consumerGroups.filter(value => value !== config.consumerName)
      }
    }
  }

  async hotRawStream(config: {
    parallelEventCount?: number,
    stream: string | string[],
    groupId: string,
    handler: (event: EncodedEvent) => Promise<void>,
    onError: (error: any) => void,
    deleteConsumerGroupOnClose?: boolean
  }): Promise<EventSubscriptionControl> {
    return this.hotStreamInternal({
      parallelEventCount: config.parallelEventCount,
      rawEvents: true,
      stream:config.stream, consumerName: config.groupId, consumer: config.handler, onError: config.onError,
      deleteConsumerGroupOnClose: config.deleteConsumerGroupOnClose
    })
  }

  async hotStream(config: {
    parallelEventCount?: number,
    stream: string | string[],
    groupId: string,
    handler: (event: EventicleEvent) => Promise<void>,
    onError: (error: any) => void,
    deleteConsumerGroupOnClose?: boolean
  }): Promise<EventSubscriptionControl> {
    return this.hotStreamInternal({
      parallelEventCount: config.parallelEventCount,
      rawEvents: false,
      stream:config.stream, consumerName: config.groupId, consumer: config.handler, onError: config.onError,
      deleteConsumerGroupOnClose: config.deleteConsumerGroupOnClose
    })
  }

  isConnected(): boolean {
    return getKafkaClientHealth().healthy;
  }

  async shutdown(): Promise<void> {
    await this.throttle.disconnect()
    await Promise.all(consumers.map(value => value.disconnect().catch(e => logger.debug("Error disconnecting consumer during shutdown", e))))
  }
}

export type ConsumerConfigStreamType = "HOT" | "COLD" | "COLD_HOT"

export interface ConsumerConfigFactory {
  consumerConfig?: (stream: string | string[], consumerName: string, type: ConsumerConfigStreamType) => Partial<ConsumerConfig>;
  consumerRunConfig?: (stream: string | string[], consumerName: string, type: ConsumerConfigStreamType, partitionsConsumedConcurrently: number) => Partial<ConsumerRunConfig>;
}



/**
 * https://github.com/confluentinc/confluent-kafka-javascript/blob/dev_early_access_development_branch/MIGRATION.md
 *
 * @param config as per @confluentinc/kafka-javascript kafkaJS compat layer
 * @param consumerConfig consumer configuration factory
 * @param onTopicFailureConfig If a consumer fails because the topic doesn't exist, configure this to request the topic is auto generated with the given config
 */
export async function eventClientOnKafka(config: KafkaConfig, consumerConfig?: ConsumerConfigFactory, onTopicFailureConfig?: (topicName) => Promise<TopicFailureConfiguration>): Promise<EventClient> {
  if (onTopicFailureConfig) onTopicFailure = onTopicFailureConfig

  if (consumerConfig && consumerConfig.consumerConfig) {
    consumerConfigFactory.consumerConfig = consumerConfig.consumerConfig
  }
  if (consumerConfig && consumerConfig.consumerRunConfig) {
    consumerConfigFactory.consumerRunConfig = consumerConfig.consumerRunConfig
  }
  await connectBroker(config)
  return eventClientTransactional(await new EventclientKafka().connect())
}
