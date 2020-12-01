import {CompressionTypes, Kafka, Message, Producer, ProducerConfig, ProducerRecord} from "kafkajs";
import logger, {LogApi} from "../../logger";
import {pause} from "../../util";
import * as uuid from "uuid";

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

export interface IQueuedRecord {
  resolve: () => void;
  reject: (...args: any[]) => void;
  record: Pick<ProducerRecord, 'topic' | 'messages'>;
}

export class ThrottledProducer {
  public recordsSent = 0;

  private producer: Producer;
  private isConnected: boolean = false;
  private intervalTimeout: NodeJS.Timeout;
  private recordQueue: IQueuedRecord[] = [];
  private isFlushing = false;

  constructor(
    protected kafka: Kafka,
    protected producerConfig: Omit<
      ProducerConfig,
      'allowAutoTopicCreation' | 'maxInFlightRequests' | 'idempotent'
      > & {maxOutgoingBatchSize?: number; flushIntervalMs?: number} = {
      maxOutgoingBatchSize: 10000,
      flushIntervalMs: 40
    }
  ) {
    this.createProducer();
  }

  public async send(event: Message, stream: string) {
    if (!this.isConnected) {
      throw new Error('You must .connect before producing actions');
    }

    return new Promise<void>((resolve, reject) => {
      this.recordQueue = [
        ...this.recordQueue,
        {
          resolve,
          reject,
          record: {
            topic: stream,
            messages: [event]
          }
        }
      ];

      return;
    });
  };

  public connect = async () => {
    if (this.isConnected) {
      return;
    }

    const flushIntervalMs = this.producerConfig.flushIntervalMs || 100;

    logger.debug('Connecting producer');
    await this.producer.connect();
    logger.debug('Connected producer');

    logger.debug('Creating flush interval', {flushIntervalMs});
    this.intervalTimeout = setInterval(this.flush, flushIntervalMs);
    logger.debug('Created flush interval');

    this.isConnected = true;
  };

  public disconnect = async () => {
    if (!this.isConnected) {
      return;
    }

    logger.debug('Disconnecting');
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

    /**
     * Ensures that if the interval call ends up being concurrent due latency in sendBatch,
     * unintentinally overlapping cycles are deferred to the next interval.
     */
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
        acks: -1,
        compression: CompressionTypes.GZIP
      });

      this.recordsSent += outgoingRecords.length;
      logger.debug('Flushed queue', {batchId});
      outgoingRecords.map(({resolve}) => resolve());
      this.isFlushing = false;
      return;
    } catch (error) {
      /**
       * If for some reason this producer is no longer recognized by the broker,
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
        await this.flush(outgoingRecords, retryCounter + 1, batchId);
        return;
      }

      outgoingRecords.map(({reject}) => reject(error));
      this.isFlushing = false;
      return;
    }
  };
}
