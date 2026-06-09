import {CompressionTypes, Producer, ProducerRecord, Message, Kafka, KafkaJSError} from "@confluentinc/kafka-javascript/lib/kafkajs";
import {logger} from "@eventicle/eventicle-utilities";
import {pause} from "../../util";
import * as uuid from "uuid";
import {HealthCheckStatus, maybeCreateTopic, TopicFailureConfiguration} from "./eventclient-kafka";

export interface IKafkaJSProtocolError {
  name: string;
  retriable: boolean;
  helpUrl?: string;
  type: string;
  code: number;
}

export function isKafkaJSProtocolError(error: unknown): error is IKafkaJSProtocolError {
  return error && typeof error === 'object' && 'code' in (error as any) && (error as any) instanceof KafkaJSError;
}

export interface IQueuedRecord {
  resolve: () => void;
  reject: (...args: any[]) => void;
  record: Pick<ProducerRecord, 'topic' | 'messages'>;
}

/**
 * The ThrottledProducer class is responsible for producing messages to a Kafka topic
 * while throttling the outgoing batch sizes. It ensures that messages are sent
 * in a controlled manner to prevent overloading the Kafka broker. It also handles
 * reliable connection management and retries for producing messages in case of
 * specific Kafka protocol errors.
 */
export class ThrottledProducer {
  public recordsSent = 0;

  private producer: Producer;
  private isConnected: boolean = false;
  private intervalTimeout: any;
  private recordQueue: IQueuedRecord[] = [];
  private isFlushing = false;
  private confirmedTopics = new Set<string>

  constructor(
    protected kafka: Kafka,
    protected producerConfig: {maxOutgoingBatchSize?: number; flushIntervalMs?: number} = {
      maxOutgoingBatchSize: 10000,
      flushIntervalMs: 40
    },
    readonly producerHealth: HealthCheckStatus,
    readonly onTopicFailure: (name: string) => Promise<TopicFailureConfiguration>
  ) {
    this.createProducer();
  }

  public async send(event: Message[], stream: string) {
    if (!this.isConnected) {
      throw new Error('You must connect before producing actions');
    }

    if(!this.confirmedTopics.has(stream)) {
      this.confirmedTopics.add(stream)
      const createConfig = await this.onTopicFailure(stream);
      await maybeCreateTopic(createConfig, stream, new Error(""));
    }

    return new Promise<void>((resolve, reject) => {
      this.recordQueue = [
        ...this.recordQueue,
        {
          resolve,
          reject,
          record: {
            topic: stream,
            messages: event
          }
        }
      ];
    });
  }

  public connect = async () => {
    if (this.isConnected) {
      return;
    }

    const flushIntervalMs = this.producerConfig.flushIntervalMs || 100;
    await this.producer.connect();
    this.producerHealth.status = "connected"
    this.producerHealth.healthy = true
    this.intervalTimeout = setInterval(this.flush, flushIntervalMs);

    this.isConnected = true;
  };

  public disconnect = async () => {
    if (!this.isConnected) {
      return;
    }

    logger.info('Disconnecting kafka producer');
    clearInterval(this.intervalTimeout);

    await this.producer.disconnect();
    this.producerHealth.status = "disconnected"
    this.producerHealth.healthy = false
    logger.debug('Disconnected');
    this.isConnected = false;
  };

  private createProducer = () => {
    logger.debug('Creating a new producer');
    this.producer = this.kafka.producer({
      kafkaJS: {
        maxInFlightRequests: 1,
        idempotent: true,
        allowAutoTopicCreation: true,
        acks: -1,
        compression: CompressionTypes.GZIP
      }
    } as any);
    logger.debug('Created a new producer');
  };

  // tslint:disable-next-line: cyclomatic-complexity
  private flush = async (
    retryRecords?: IQueuedRecord[],
    retryCounter = 0,
    retryBatchId?: string
  ) => {
    if (!retryRecords && this.isFlushing) {
      return;
    }

    if (retryCounter) {
      /** Wait for a max of 4 seconds before retrying */
      const retryDelay = Math.min(retryCounter * 1000, 4000);
      logger.debug('Waiting before attempting retry', {retryDelay});
      await pause(retryDelay);
    }

    this.isFlushing = true;

    const batchSize = this.producerConfig.maxOutgoingBatchSize || 1000;
    const outgoingRecords = retryRecords || this.recordQueue.slice(0, batchSize);
    this.recordQueue = this.recordQueue.slice(batchSize);
    const batchId = retryBatchId || uuid.v4();

    if (!outgoingRecords.length) {
      this.isFlushing = false;
      return;
    }

    logger.debug(
      'Flushing queue',
      {
        remaining: this.recordQueue.length,
        records: outgoingRecords.length,
        batchId
      }
    );

    try {
      await this.producer.sendBatch({
        topicMessages: outgoingRecords.map(({record}) => record),
      });

      this.recordsSent += outgoingRecords.length;
      logger.debug('Flushed queue', {batchId});
      outgoingRecords.forEach(({resolve}) => resolve());
      this.isFlushing = false;
      return;
    } catch (error: any) {
      /**
       * If for some reason this producer is no longer recognized by the broker,
       * create a new producer.
       */
      if (isKafkaJSProtocolError(error) && error.code === 59) { // ERR_UNKNOWN_PRODUCER_ID
        await this.producer.disconnect();
        this.createProducer();
        await this.producer.connect();
        logger.debug(
          'Retrying failed flush attempt due to UNKNOWN_PRODUCER_ID',
          {batchId}
        );
        await this.flush(outgoingRecords, retryCounter + 1, batchId);
        return;
      }
      if (isKafkaJSProtocolError(error) && error.code === 3) { // ERR_UNKNOWN_TOPIC_OR_PART
        for (const record of outgoingRecords) {
          const topic = record.record.topic
          const config = await this.onTopicFailure(topic)
          await maybeCreateTopic(config, topic, error)
        }

        await this.flush(outgoingRecords, retryCounter + 1, batchId)
        return
      }

      outgoingRecords.forEach(({reject}) => reject(error));
      this.isFlushing = false;
      return;
    }
  };
}
