import {ICustomPartitioner, Kafka, KafkaConfig} from "kafkajs";
import {EventClient, eventClientCodec, EventicleEvent, EventSubscriptionControl} from "./event-client";
import * as uuid from "uuid"
import logger from "../../logger";
import {ThrottledProducer} from "./kafka-throttle";

let kafka: Kafka

let consumerGroups = []


/**
 * Access the low level kafka client used by the event client
 */
export function getKafkaClient(): Kafka {
  return kafka;
}

export async function connectBroker(config: KafkaConfig) {
  kafka = new Kafka(config)
}

function hashStr(str) {
  let hash = 0;
  for (var i = 0; i < str.length; i++) {
    var charCode = str.charCodeAt(i);
    hash += charCode;
  }
  return hash;
}

let DomainAwarePartitioner: ICustomPartitioner = () => {
  return ({ topic, partitionMetadata, message }) => {

    // const numPartitions = partitionMetadata.length
    // let key = message.headers["domainId"] || message.key
    // return  hashStr(key) % numPartitions
    return 0
  }
}

class EventclientKafka implements EventClient {

  throttle: ThrottledProducer

  broker(): Kafka {
    return kafka
  }

  async connect(): Promise<EventclientKafka> {
    // Use this throttle to work around this - https://github.com/tulios/kafkajs/issues/598
    this.throttle = new ThrottledProducer(this.broker())
    await this.throttle.connect()
    return this
  }

  async clear(topics: string[]) {
    let admin = kafka.admin()
    await admin.connect()
    let existingTopics = await admin.listTopics()

    for(let topic of topics) {
      if (existingTopics.includes(topic)) {
        admin.deleteTopics({
          topics: [topic]
        }).catch(reason => logger.debug("Error tpic cleanup", reason))
      }
    }
  }

  async coldHotStream(config: { stream: string, groupId: string, handler: (event: EventicleEvent) => Promise<void>, onError: (error: any) => void }): Promise<EventSubscriptionControl> {

    if (!config.groupId) {
      logger.trace("Auto set groupId for cold/hot replay")
      config.groupId = uuid.v4()
    }

    if (consumerGroups.includes(config.groupId)) {
      logger.error("Consumer Group has subscribed multiple times, error: "+ config.groupId, new Error("Consumer Group has subscribed multiple times, error " + config.groupId))
      throw new Error("Consumer Group has subscribed multiple times, error " + config.groupId)
    }

    consumerGroups.push(config.groupId)

    let cons = kafka.consumer({groupId: uuid.v4()})

    await cons.connect()

    if (Array.isArray(config.stream)) {
      for (let str of config.stream) {
        await cons.subscribe({topic: str, fromBeginning: true})
      }
    } else {
      await cons.subscribe({topic: config.stream, fromBeginning: true})
    }

    cons.run({
      eachMessage: async payload => {
        logger.trace(`[${config.groupId}] message received`, payload)

        let decoded = await eventClientCodec().decode({
          headers: payload.message.headers,
          buffer: payload.message.value
        })

        await config.handler(decoded)
      }
    })

    return {
      close: async () => {
        await cons.disconnect()
      }
    }
  }

  async coldStream(stream: string, handler: (event: EventicleEvent) => Promise<void>, onError: (error: any) => void, onDone: () => void): Promise<EventSubscriptionControl> {

    const groupId = uuid.v4()
    let cons = kafka.consumer({groupId})

    let adm = kafka.admin()
    await adm.connect()

    let partitionOffsets = await adm.fetchTopicOffsets(stream)
    let latestOffset = Math.max(...partitionOffsets.map(value => parseInt(value.offset)))
    await adm.disconnect()

    logger.debug(`Cold replay of ${stream} by [${groupId}], seek till ${latestOffset}`)

    await cons.connect()

    await cons.subscribe({topic: stream, fromBeginning: true})

    cons.run({
      eachMessage: async payload => {
        logger.trace("Cold message lands", payload)
        try {
          let decoded = await eventClientCodec().decode({
            headers: payload.message.headers,
            buffer: payload.message.value
          })
          await handler({
            causedById: payload.message.headers.causedById as string,
            causedByType: payload.message.headers.causedByType as string,
            createdAt: payload.message.headers.createdAt && parseInt(payload.message.headers.createdAt.toString("utf8")),
            source: payload.message.headers.source as string,
            domainId: payload.message.headers.domainId && payload.message.headers.domainId.toString("utf8"),
            type: payload.message.headers.type && payload.message.headers.type.toString("utf8"),
            id: payload.message.headers.id && payload.message.headers.id.toString("utf8"),
            data: JSON.parse(payload.message.value.toString("utf8"))
          })
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

  async emit(events: EventicleEvent[], stream: string): Promise<void> {

    for (let event of events) {
      let encoded = await eventClientCodec().encode(event)

      await this.throttle.send({
        value: encoded.buffer,
        timestamp: `${event.createdAt}`,
        headers: encoded.headers
      }, stream)
    }
  }

  async hotStream(stream: string | string[], consumerName: string, consumer: (event: EventicleEvent) => Promise<void>, onError: (error: any) => void): Promise<EventSubscriptionControl> {

    if (consumerGroups.includes(consumerName)) {
      logger.error("Consumer Group has subscribed multiple times, this is a bug, error: "+ consumerName, new Error("Consumer Group has subscribed multiple times, this is a bug,  error " + consumerName))
      throw new Error("Consumer Group has subscribed multiple times, this is a bug, error " + consumerName)
    }

    consumerGroups.push(consumerName)

    let cons = kafka.consumer({groupId: consumerName})

    await cons.connect()

    if (Array.isArray(stream)) {
      for (let str of stream) {
        await cons.subscribe({topic: str})
      }
    } else {
      await cons.subscribe({topic: stream})
    }

    await cons.run({
      eachMessage: async payload => {
        await consumer(await eventClientCodec().decode({
          headers: payload.message.headers, buffer: payload.message.value
        }))
      }
    })

    return {
      close: async () => {
        await cons.disconnect()
      }
    }
  }
}

export async function eventClientOnKafka(config: KafkaConfig): Promise<EventClient> {
  await connectBroker(config)
  return new EventclientKafka().connect()
}
