import {
  CompressionTypes,
  Kafka, KafkaConfig,
  Producer,
  ProducerConfig,
  TopicMessages
} from "kafkajs";
import {logger} from "@eventicle/eventicle-utilities";
import * as uuid from "uuid";
import {HealthCheckStatus} from "../eventclient-kafka";
import {EventOutbox, OutboxSender} from "./outbox-event-client";
import {dataStore} from "@eventicle/eventicle-utilities/dist/datastore";
import {eventSourceName} from "../event-client";

export interface IKafkaJSProtocolError {
  name: string;
  retriable: boolean;
  helpUrl?: string;
  type: string;
  code: number;
}

export function isKafkaJSProtocolError(error: unknown): error is IKafkaJSProtocolError {
  return error && typeof error === 'object' && (error as any).name === 'KafkaJSProtocolError';
}

/**
 * KafkaOutboxSender is responsible for sending events from an event outbox to Kafka, ensuring
 * reliable event delivery using an outbox pattern. It interacts with a Kafka producer, manages
 * connection state, and handles errors that may arise during data transmission.
 *
 * This class provides methods to handle connection management, data batching, and reliable
 * flushing of messages to Kafka. It ensures idempotent delivery of events via Kafka's producer
 * configurations.
 *
 * Features:
 * - Connects and disconnects from Kafka safely.
 * - Reads batched events from an outbox and pushes them to Kafka.
 * - Implements a retry mechanism in case of specific Kafka errors (e.g., UNKNOWN_PRODUCER_ID).
 * - Tracks producer health status.
 * - Manages periodic heartbeat flushes for idle intervals.
 * - Reports infrastructure failures during message transmission.
 *
 * Dependencies:
 * - Requires an instance of `EventOutbox` for outbox functionality.
 * - Requires Kafka configuration (`KafkaConfig`) to initialize the Kafka connection.
 * - Optionally accepts additional producer configurations like `maxOutgoingBatchSize` and `flushIntervalMs`.
 */
export class KafkaOutboxSender implements OutboxSender {
  public recordsSent = 0;

  private producer: Producer;
  private isConnected: boolean = false;
  private intervalTimeout: any;
  private isFlushing = false;
  readonly producerHealth: HealthCheckStatus = {} as any
  private kafka: Kafka
  private errorLastReported: number = 0
  private lastSendErrored: boolean = false

  constructor(
    protected eventOutbox: EventOutbox,
    protected kafkaConfig: KafkaConfig,
    protected producerConfig: Omit<
      ProducerConfig,
      'allowAutoTopicCreation' | 'maxInFlightRequests' | 'idempotent'
      > & {maxOutgoingBatchSize?: number; flushIntervalMs?: number} = {
      maxOutgoingBatchSize: 10000,
      flushIntervalMs: 40
    }
  ) {
    this.kafka = new Kafka(kafkaConfig)
    this.createProducer();
  }

  async notify(): Promise<void> {
    if (!this.isConnected) {
      // this forces a bubble up to the original event producer through the event client.
      // otherwise, its not obvious to the calling code that kafka isn't connected.
      throw new Error('You must connect before events can be sent');
    }

    // if already in flight, this will do nothing.
    this.flush()
  }

  public connect = async () => {
    if (this.isConnected) {
      return;
    }
    this.producer.on("producer.connect", args => {
      this.producerHealth.status = "connected"
      this.producerHealth.healthy = true
    })
    this.producer.on("producer.disconnect", args => {
      this.producerHealth.status = "disconnected"
      this.producerHealth.healthy = false
    })

    // how often to do a heartbeat flush.  Most messages will go via the `notify` route.
    const regularFlushIntervalMs = 400;
    await this.producer.connect();
    this.intervalTimeout = setInterval(() => this.flush(), regularFlushIntervalMs);

    this.isConnected = true;
  };

  public disconnect = async () => {
    if (!this.isConnected) {
      return;
    }

    logger.info('Disconnecting kafka producer');
    clearInterval(this.intervalTimeout);

    await this.producer.disconnect();
    logger.debug('Disconnected');
    this.isConnected = false;
  };

  private createProducer = () => {
    logger.debug('Creating a new producer');
    this.producer = this.kafka.producer({
      maxInFlightRequests: 1,
      idempotent: true,
      allowAutoTopicCreation: true,
      ...this.producerConfig
    });
    logger.debug('Created a new producer');
  };

  // tslint:disable-next-line: cyclomatic-complexity
  private async flush (
  ) {
    if (this.isFlushing) {
      return;
    }
    /**
     * Ensures that if the interval call ends up being concurrent due latency in sendBatch,
     * unintentionally overlapping cycles are deferred to the next interval.
     */
    const out = this.eventOutbox
    this.isFlushing = true;
    return dataStore().transaction(async () => {
      const txData = dataStore().getTransactionData()
      const outgoingRecords = await out.readOutbox()
      const batchId = uuid.v4();

      if (!outgoingRecords.length) {
        this.isFlushing = false;
        if (this.lastSendErrored) {
          logger.info("Kafka outbox sender has read DB correctly after previous failure")
        }
        this.errorLastReported = 0
        this.lastSendErrored = false
        return;
      }
      logger.debug(
        'Flushing queue',
        {
          records: outgoingRecords.length,
          batchId
        }
      );

      try {

        const topicMessages = outgoingRecords.map(value => {

          return {
            topic: value.stream,
            messages: value.events.map(encoded => ({
              value: encoded.buffer,
              key: encoded.key,
              timestamp: `${encoded.timestamp}`,
              headers: { ...encoded.headers, source: eventSourceName(), sendingservice: process.env.PROCESSNAME || process.env.HOSTNAME || "unknown-host"}
            }))
          } as TopicMessages
        })

        logger.debug("Send message batch ", topicMessages)
        await this.producer.sendBatch({
          topicMessages,
          acks: -1,
          compression: CompressionTypes.GZIP
        });

        this.recordsSent += outgoingRecords.length;

        await this.eventOutbox.removeOutboxEntries(outgoingRecords);

        logger.debug('Flushed queue', {batchId});
        this.isFlushing = false;
        if (this.lastSendErrored) {
          this.errorLastReported = 0
          logger.info(`Kafka outbox sender has read DB correctly and sent events [${outgoingRecords.length}] successfully after previous failure`)
        }
        this.lastSendErrored = false
        return;
      } catch (error) {
        /**
         * If for some reason this producer is no longer recognized by th\\e broker,
         * create a new producer.
         */
        if (isKafkaJSProtocolError(error) && error.type === 'UNKNOWN_PRODUCER_ID') {
          await this.producer.disconnect();
          this.createProducer();
          await this.producer.connect();
          logger.debug(
            'Retrying failed flush attempt due to UNKNOWN_PRODUCER_ID',
            {batchId}
          );
          await this.flush();
          return;
        }
        throw error;
      }
    }, { propagation: "requires_new", isolationLevel: "read-committed" })
      .catch(reason => {
        const ERROR_REPEAT_TIME = 30000
        if (this.errorLastReported < Date.now() - ERROR_REPEAT_TIME) {
          logger.error(`Kafka outbox sender infrastructure failure has been detected. This will not repeat for ${ERROR_REPEAT_TIME}ms`, reason)
          this.errorLastReported = Date.now()
        }
        this.lastSendErrored = true;
      })
      .finally(() => {
      this.isFlushing = false;
    })
  };
}
