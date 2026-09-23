import {
  CompressionTypes,
  Kafka, KafkaConfig,
  Producer,
  TopicMessages,
  KafkaJSError
} from "@confluentinc/kafka-javascript/lib/kafkajs";
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
  return error && typeof error === 'object' && 'code' in (error as any) && (error as any) instanceof KafkaJSError;
}

/** Kafka protocol error code for UNKNOWN_PRODUCER_ID. */
const UNKNOWN_PRODUCER_ID = 59;

/**
 * Observable state of a {@link KafkaOutboxSender}, for health checks and metrics.
 *
 * `producerHealth` alone only ever said whether `connect()` had been called. A
 * sender whose every flush fails - because the producer is wedged, the broker is
 * gone, or the outbox read throws - reported `healthy: true` right up until the
 * process was killed. This carries the flush outcome as well, so a stalled
 * sender is visible to a liveness probe rather than only to whoever happens to
 * be reading logs.
 */
export interface OutboxSenderHealth {
  /**
   * False once flushes have been failing for longer than the configured grace
   * period, or when the sender is not connected.
   */
  healthy: boolean;
  status: "not-connected" | "connected" | "degraded" | "disconnected";
  /** Whether the underlying Kafka producer is currently believed connected. */
  producerConnected: boolean;
  /** Total event lists successfully published since process start. */
  recordsSent: number;
  /** Consecutive failed flush attempts. Reset by any flush that reaches the DB. */
  consecutiveFlushFailures: number;
  /**
   * Epoch millis of the last flush that completed without error, including
   * flushes that found the outbox empty: reading an empty outbox proves the
   * database path works, which is half of what can break.
   */
  lastSuccessfulFlushAt?: number;
  /** Millis since {@link lastSuccessfulFlushAt}, or since connect if none. */
  msSinceLastSuccessfulFlush?: number;
  /** Message of the most recent flush failure, if any. */
  lastErrorMessage?: string;
}

export interface KafkaOutboxSenderOptions {
  /**
   * How long flushes may keep failing before {@link OutboxSenderHealth.healthy}
   * goes false. Defaults to 30000ms, matching the error log throttle: the first
   * repeated error log and the health transition then describe the same event.
   *
   * A flush runs every 400ms, so a failure count threshold would flip on a
   * single transient broker hiccup. Time is the right unit here.
   */
  unhealthyAfterFailingForMs?: number;
  /**
   * Upper bound on how long {@link KafkaOutboxSender.disconnect} waits for a
   * flush that is already in progress.
   *
   * Shutdown has a hard deadline: the service's graceful-shutdown handler calls
   * `process.exit(0)` on a timer regardless. Waiting without a bound would
   * simply move the abrupt kill later, into the middle of the same flush.
   * Defaults to 4000ms, inside the default 5000ms window between server close
   * and exit.
   */
  shutdownFlushTimeoutMs?: number;
}

const DEFAULT_UNHEALTHY_AFTER_FAILING_FOR_MS = 30000;
const DEFAULT_SHUTDOWN_FLUSH_TIMEOUT_MS = 4000;
const ERROR_REPEAT_TIME = 30000;
const REGULAR_FLUSH_INTERVAL_MS = 400;

/**
 * KafkaOutboxSender is responsible for sending events from an event outbox to Kafka, ensuring
 * reliable event delivery using an outbox pattern. It interacts with a Kafka producer, manages
 * connection state, and handles errors that may arise during data transmission.
 */
export class KafkaOutboxSender implements OutboxSender {
  public recordsSent = 0;

  private producer: Producer;
  private isConnected: boolean = false;
  private producerConnected: boolean = false;
  private intervalTimeout: any;
  private isFlushing = false;
  /**
   * The flush currently in progress, so `disconnect()` can wait for it instead
   * of tearing the producer out from under a send that has already happened but
   * whose outbox rows have not yet been deleted. That window is precisely how a
   * shutdown turns an at-least-once delivery into a duplicate on restart.
   */
  private inFlightFlush: Promise<void> | undefined;
  private isShuttingDown = false;
  readonly producerHealth: HealthCheckStatus = {} as any
  private kafka: Kafka
  private errorLastReported: number = 0
  private lastSendErrored: boolean = false
  private consecutiveFlushFailures = 0
  private lastSuccessfulFlushAt: number | undefined
  private lastErrorMessage: string | undefined
  private failingSince: number | undefined
  private readonly unhealthyAfterFailingForMs: number
  private readonly shutdownFlushTimeoutMs: number

  constructor(
    protected eventOutbox: EventOutbox,
    protected kafkaConfig: KafkaConfig,
    protected producerConfig: {maxOutgoingBatchSize?: number; flushIntervalMs?: number} = {
      maxOutgoingBatchSize: 10000,
      flushIntervalMs: 40
    },
    options: KafkaOutboxSenderOptions = {}
  ) {
    this.unhealthyAfterFailingForMs =
      options.unhealthyAfterFailingForMs ?? DEFAULT_UNHEALTHY_AFTER_FAILING_FOR_MS;
    this.shutdownFlushTimeoutMs =
      options.shutdownFlushTimeoutMs ?? DEFAULT_SHUTDOWN_FLUSH_TIMEOUT_MS;
    this.kafka = new Kafka({kafkaJS: kafkaConfig} as any)
    // HealthCheckStatus.status is eventicle's fixed vocabulary
    // ("active" | "error" | "connected" | "disconnected" | "killed"), so a
    // never-connected producer reads as "disconnected" there. OutboxSenderHealth
    // carries the finer distinction.
    this.producerHealth.status = "disconnected"
    this.producerHealth.healthy = false
    this.createProducer();
  }

  async notify(): Promise<void> {
    if (!this.isConnected) {
      throw new Error('You must connect before events can be sent');
    }
    // Deliberately not awaited: an emit must not block on the broker, that is
    // what the outbox is for. `flush()` never rejects, so this cannot produce an
    // unhandled rejection.
    void this.flush()
  }

  /**
   * Current health and drain state. Safe to call at any time, does no I/O.
   */
  health(): OutboxSenderHealth {
    const now = Date.now();
    const failingForMs =
      this.failingSince === undefined ? 0 : now - this.failingSince;
    const healthy =
      this.isConnected &&
      this.producerConnected &&
      failingForMs < this.unhealthyAfterFailingForMs;

    let status: OutboxSenderHealth["status"];
    if (!this.isConnected) {
      status = this.lastSuccessfulFlushAt === undefined && !this.isShuttingDown
        ? "not-connected"
        : "disconnected";
    } else if (healthy) {
      status = "connected";
    } else {
      status = "degraded";
    }

    return {
      healthy,
      status,
      producerConnected: this.producerConnected,
      recordsSent: this.recordsSent,
      consecutiveFlushFailures: this.consecutiveFlushFailures,
      lastSuccessfulFlushAt: this.lastSuccessfulFlushAt,
      msSinceLastSuccessfulFlush:
        this.lastSuccessfulFlushAt === undefined
          ? undefined
          : now - this.lastSuccessfulFlushAt,
      lastErrorMessage: this.lastErrorMessage,
    };
  }

  public connect = async () => {
    if (this.isConnected) {
      return;
    }
    this.isShuttingDown = false;

    await this.producer.connect();
    this.markProducerConnected();
    this.intervalTimeout = setInterval(() => void this.flush(), REGULAR_FLUSH_INTERVAL_MS);

    this.isConnected = true;
  };

  /**
   * Stop flushing and release the producer.
   *
   * Ordering matters and is not interchangeable:
   *
   *  1. `isShuttingDown` is set first, so no *new* flush can start, including
   *     one a concurrent `notify()` is about to request.
   *  2. The interval is cleared, so the 400ms timer stops resurrecting the
   *     sender after it has been told to stop. Before this existed the timer
   *     outlived `shutdownSystem()` entirely and kept flushing until
   *     `process.exit(0)` killed the process mid-transaction.
   *  3. A flush already in progress is awaited (bounded), so the producer is not
   *     disconnected between a successful `sendBatch` and the `DELETE` that
   *     records it as sent.
   *  4. `isConnected` goes false only now. `notify()` throws once it is false,
   *     so flipping it earlier would turn every in-flight request's emit into
   *     an error. This is also why the caller must run shutdown *after*
   *     `server.close()`.
   *
   * Rows still in the outbox are not drained. They are durable, ordered, and
   * owned by whichever replica picks them up next; a best-effort drain here
   * would race the process exit deadline for no delivery guarantee.
   */
  public disconnect = async () => {
    if (!this.isConnected) {
      return;
    }
    this.isShuttingDown = true;

    logger.info('Disconnecting kafka producer');
    clearInterval(this.intervalTimeout);
    this.intervalTimeout = undefined;

    await this.awaitInFlightFlush();

    this.isConnected = false;

    try {
      await this.producer.disconnect();
    } catch (error) {
      // Nothing above this can act on a failed disconnect, and throwing would
      // abort the rest of the service's shutdown sequence.
      logger.warn('Kafka producer disconnect failed during shutdown', error);
    }
    this.producerConnected = false;
    this.producerHealth.status = "disconnected"
    this.producerHealth.healthy = false
    logger.debug('Disconnected');
  };

  private async awaitInFlightFlush(): Promise<void> {
    const inFlight = this.inFlightFlush;
    if (!inFlight) {
      return;
    }

    let timer: any;
    const deadline = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), this.shutdownFlushTimeoutMs);
    });

    try {
      const outcome = await Promise.race([inFlight.then(() => "flushed" as const), deadline]);
      if (outcome === "timeout") {
        logger.warn(
          `Kafka outbox sender shut down with a flush still in progress after ${this.shutdownFlushTimeoutMs}ms. ` +
          `Its rows stay in the outbox and will be re-sent, which may duplicate an already-published batch.`
        );
      }
    } finally {
      clearTimeout(timer);
    }
  }

  private markProducerConnected() {
    this.producerConnected = true;
    this.producerHealth.status = "connected"
    this.producerHealth.healthy = true
  }

  private markProducerUnavailable(reason: unknown) {
    this.producerConnected = false;
    this.producerHealth.status = "error"
    this.producerHealth.healthy = false
    this.lastErrorMessage = reason instanceof Error ? reason.message : String(reason);
  }

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

  /**
   * Replace the producer after the broker has forgotten its producer id.
   *
   * The previous implementation disconnected, created and connected without
   * touching any state. If `connect()` threw, the sender was left holding an
   * unconnected producer while still reporting itself healthy and connected,
   * and every subsequent flush failed against a producer that could never
   * recover. Health now tracks the outcome, and the failure propagates to the
   * flush error handler rather than being swallowed into a zombie.
   */
  private async replaceProducer(): Promise<void> {
    this.producerConnected = false;
    try {
      await this.producer.disconnect();
    } catch (error) {
      // Expected: the producer we are replacing is the broken one.
      logger.debug('Disconnect of the replaced producer failed, continuing', error);
    }

    this.createProducer();
    try {
      await this.producer.connect();
    } catch (error) {
      this.markProducerUnavailable(error);
      throw error;
    }
    this.markProducerConnected();
  }

  private async flush(): Promise<void> {
    if (this.isFlushing || this.isShuttingDown) {
      return;
    }
    this.isFlushing = true;

    const flush = this.runFlush()
      .then(() => {
        this.recordFlushSuccess();
      })
      .catch(reason => {
        this.recordFlushFailure(reason);
      })
      .finally(() => {
        // Reset only here. The previous implementation also cleared the flag at
        // several points *inside* the transaction, which let the next 400ms tick
        // start a second flush while the first was still committing.
        this.isFlushing = false;
        this.inFlightFlush = undefined;
      });

    this.inFlightFlush = flush;
    return flush;
  }

  private recordFlushSuccess() {
    this.lastSuccessfulFlushAt = Date.now();
    this.consecutiveFlushFailures = 0;
    this.failingSince = undefined;
    this.lastErrorMessage = undefined;
    if (this.lastSendErrored) {
      this.errorLastReported = 0;
      logger.info("Kafka outbox sender has recovered and completed a flush after previous failure");
    }
    this.lastSendErrored = false;
    if (this.isConnected && this.producerConnected) {
      this.producerHealth.status = "connected";
      this.producerHealth.healthy = true;
    }
  }

  private recordFlushFailure(reason: any) {
    this.consecutiveFlushFailures++;
    this.lastErrorMessage = reason instanceof Error ? reason.message : String(reason);
    if (this.failingSince === undefined) {
      this.failingSince = Date.now();
    }
    if (this.errorLastReported < Date.now() - ERROR_REPEAT_TIME) {
      logger.error(
        `Kafka outbox sender infrastructure failure has been detected. This will not repeat for ${ERROR_REPEAT_TIME}ms`,
        reason
      );
      this.errorLastReported = Date.now();
    }
    this.lastSendErrored = true;
    if (Date.now() - this.failingSince >= this.unhealthyAfterFailingForMs) {
      this.producerHealth.status = "error";
      this.producerHealth.healthy = false;
    }
  }

  private runFlush(): Promise<void> {
    const out = this.eventOutbox
    return dataStore().transaction(async () => {
      const outgoingRecords = await out.readOutbox()
      const batchId = uuid.v4();

      if (!outgoingRecords.length) {
        // Reaching here is itself a health signal: the DB read path works.
        return;
      }
      logger.debug(
        'Flushing queue',
        {
          records: outgoingRecords.length,
          batchId
        }
      );

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
      await this.sendBatchWithProducerIdRecovery(topicMessages, batchId);

      this.recordsSent += outgoingRecords.length;

      await this.eventOutbox.removeOutboxEntries(outgoingRecords);

      logger.debug('Flushed queue', {batchId});
    }, { propagation: "requires_new", isolationLevel: "read-committed" })
  }

  /**
   * Send a batch, replacing the producer and retrying exactly once if the broker
   * reports UNKNOWN_PRODUCER_ID.
   *
   * The previous recovery path called `this.flush()` recursively. That call
   * returned immediately every time, because `isFlushing` was still true from
   * the flush it was called out of: the retry never happened and the batch was
   * silently abandoned to the next interval, with the outer flush reported as a
   * success. Retrying the send in place, inside the same transaction, is what
   * the recursion was trying to express.
   *
   * The retry can duplicate a batch the broker did in fact accept. That is
   * inherent to the outbox's at-least-once contract and was true of the previous
   * code too; consumers of these topics must be idempotent.
   */
  private async sendBatchWithProducerIdRecovery(
    topicMessages: TopicMessages[],
    batchId: string
  ): Promise<void> {
    try {
      await this.producer.sendBatch({ topicMessages });
      return;
    } catch (error: any) {
      if (!isKafkaJSProtocolError(error) || error.code !== UNKNOWN_PRODUCER_ID) {
        throw error;
      }
      logger.info(
        'Replacing the Kafka producer and retrying the batch once after UNKNOWN_PRODUCER_ID',
        {batchId}
      );
      await this.replaceProducer();
    }

    // One retry, on the replacement producer. A second UNKNOWN_PRODUCER_ID
    // propagates: the rows stay in the outbox and the next interval tries again,
    // which is bounded, observable and does not recurse.
    await this.producer.sendBatch({ topicMessages });
  }
}
