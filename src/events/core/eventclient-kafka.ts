import {Consumer, ConsumerConfig, ConsumerRunConfig, ICustomPartitioner, Kafka, KafkaConfig, Message} from "kafkajs";
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
      groupId: consumerName
    }
  },
  consumerRunConfig: (stream, consumerName, type) => {
    if (type === "COLD") {
      return {
        autoCommit: true,
        autoCommitInterval: 500,
        autoCommitThreshold: 50
      }
    }
    return {
      autoCommit: true,
      autoCommitInterval: 500,
      autoCommitThreshold: 50,
      partitionsConsumedConcurrently: 50,
    }
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
  kafka = new Kafka(config)
}

class EventclientKafka implements EventClient {

  throttle: ThrottledProducer

  broker(): Kafka {
    return kafka
  }

  async connect(): Promise<EventclientKafka> {
    // Use this throttle to work around this - https://github.com/tulios/kafkajs/issues/598
    producerHealth = {
      healthy: false, status: "disconnected", name: "message-sender"
    }
    this.throttle = new ThrottledProducer(this.broker(), {}, producerHealth)
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
      groupId: newConf.groupId || config.groupId,
      ...newConf
    })

    setupMonitor(healthStatus, cons)

    await cons.connect()

    consumers.push(cons)

    if (Array.isArray(config.stream)) {
      for (let str of config.stream) {
        await cons.subscribe({topic: str, fromBeginning: true})
      }
    } else {
      await cons.subscribe({topic: config.stream, fromBeginning: true})
    }

    let newRunConf = consumerConfigFactory.consumerRunConfig(config.stream, config.groupId, "COLD_HOT")
    cons.run({
      ...newRunConf,
      eachMessage: async payload => {
        logger.debug(`[${config.groupId}] message received on sub id ` + id, payload)

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

          decoded.stream = payload.topic

          await config.handler(decoded)
        }
      }
    })


    return {
      close: async () => {
        await cons.disconnect()
        consumerGroups = consumerGroups.filter(value => value !== config.groupId)
      }
    }
  }

  async coldStream(stream: string, handler: (event: EventicleEvent) => Promise<void>, onError: (error: any) => void, onDone: () => void): Promise<EventSubscriptionControl> {

    const groupId = uuid.v4()
    let newConf = consumerConfigFactory.consumerConfig(stream, groupId, "COLD")

    let cons = kafka.consumer({
      groupId: newConf.groupId || groupId,
      ...newConf
    })

    let adm = kafka.admin()
    await adm.connect()

    let partitionOffsets = await adm.fetchTopicOffsets(stream)
    let latestOffset = Math.max(...partitionOffsets.map(value => parseInt(value.offset)))
    await adm.disconnect()

    logger.debug(`Cold replay of ${stream} by [${groupId}], seek till ${latestOffset}`)

    await cons.connect()

    await cons.subscribe({topic: stream, fromBeginning: true})
    let newRunConf = consumerConfigFactory.consumerRunConfig(stream, groupId, "COLD")

    cons.run({
      ...newRunConf,
      eachMessage: async payload => {
        logger.trace("Cold message lands", payload)
        try {
          let decoded = await eventClientCodec().decode({
            timestamp: parseInt(payload.message.timestamp),
            key: payload.message.key ? payload.message.key.toString() : null,
            headers: payload.message.headers,
            buffer: payload.message.value
          })

          decoded.stream = payload.topic

          await handler(decoded)
        } finally {
          if (parseInt(payload.message.offset) >= latestOffset - 1) {
            logger.debug(`Group ID [${groupId}] finishes cold replay on offset ${payload.message.offset}`)
            onDone()
            await cons.disconnect()
          }
        }
      }
    })

    return {
      close: async () => {
        await cons.disconnect()
      }
    }
  }

  async emit(events: EventicleEvent[] | EncodedEvent[], stream: string): Promise<void> {

    const messages = await Promise.all(events.map(async (event: EventicleEvent | EncodedEvent )  => {
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
      rawEvents?: boolean,
      stream: string | string[],
      consumerName: string,
      consumer: (event: EventicleEvent | EncodedEvent) => Promise<void>,
      onError: (error: any) => void
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
      groupId: newConf.groupId || config.consumerName,
      ...newConf
    })

    setupMonitor(healthStatus, cons)

    await cons.connect()

    consumers.push(cons)

    if (Array.isArray(config.stream)) {
      for (let str of config.stream) {
        await cons.subscribe({topic: str})
      }
    } else {
      await cons.subscribe({topic: config.stream})
    }

    let newRunConf = consumerConfigFactory.consumerRunConfig(config.stream, config.consumerName, "HOT")

    await cons.run({
      ...newRunConf,
      eachMessage: async (payload) => {
        let encodedEvent = {
          timestamp: parseInt(payload.message.timestamp),
          key: payload.message.key ? payload.message.key.toString() : null,
          headers: payload.message.headers, buffer: payload.message.value
        } as EncodedEvent

        if (config.rawEvents) {
          await config.consumer(encodedEvent)
        } else {
          let decoded = await eventClientCodec().decode(encodedEvent)

          decoded.stream = payload.topic

          await config.consumer(decoded)
        }
      }
    })

    return {
      close: async () => {
        await cons.disconnect()
        consumerGroups = consumerGroups.filter(value => value !== config.consumerName)
      }
    }
  }

  async hotRawStream(stream: string | string[], consumerName: string, consumer: (event: EncodedEvent) => Promise<void>, onError: (error: any) => void): Promise<EventSubscriptionControl> {
    return this.hotStreamInternal({
      rawEvents: true,
      stream, consumerName, consumer, onError
    })
  }

  async hotStream(stream: string | string[], consumerName: string, consumer: (event: EventicleEvent) => Promise<void>, onError: (error: any) => void): Promise<EventSubscriptionControl> {
    return this.hotStreamInternal({
      rawEvents: false,
      stream, consumerName, consumer, onError
    })
  }

  isConnected(): boolean {
    return getKafkaClientHealth().healthy;
  }

  async shutdown(): Promise<void> {
    await this.throttle.disconnect()
    await Promise.all(consumers.map(value => value.disconnect()))
  }
}

function setupMonitor(healthStatus: HealthCheckStatus, cons: Consumer) {
  cons.on("consumer.stop", args => {
    healthStatus.healthy = false
    healthStatus.status = "disconnected"
  })
  cons.on("consumer.crash", args => {
    (healthStatus as any).args = args
    healthStatus.healthy = false
    healthStatus.status = "error"
  })
  cons.on("consumer.disconnect", args => {
    healthStatus.healthy = false
    healthStatus.status = "disconnected"
  })
  cons.on("consumer.connect", args => {
    healthStatus.healthy = true
    healthStatus.status = "connected"
  })
  cons.on("consumer.group_join", args => {
    healthStatus.healthy = true
    healthStatus.status = "active"
  })
}

export type ConsumerConfigStreamType = "HOT" | "COLD" | "COLD_HOT"

export interface ConsumerConfigFactory {
  consumerConfig?: (stream: string | string[], consumerName: string, type: ConsumerConfigStreamType) => Partial<ConsumerConfig>;
  consumerRunConfig?: (stream: string | string[], consumerName: string, type: ConsumerConfigStreamType) => Partial<ConsumerRunConfig>;
}

export async function eventClientOnKafka(config: KafkaConfig, consumerConfig?: ConsumerConfigFactory): Promise<EventClient> {
  if (consumerConfig && consumerConfig.consumerConfig) {
    consumerConfigFactory.consumerConfig = consumerConfig.consumerConfig
  }
  if (consumerConfig && consumerConfig.consumerRunConfig) {
    consumerConfigFactory.consumerRunConfig = consumerConfig.consumerRunConfig
  }
  await connectBroker(config)
  return eventClientTransactional(await new EventclientKafka().connect())
}
