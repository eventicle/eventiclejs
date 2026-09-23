import { KafkaJSError } from "@confluentinc/kafka-javascript/lib/kafkajs";
import {
  EventOutbox,
  OutboxEventClient,
  OutboxEventListWithId,
  OutboxSender,
} from "../../../../src/events/core/outbox/outbox-event-client";
import { KafkaOutboxSender } from "../../../../src/events/core/outbox/outbox-kafka-sender";
import { EventClient } from "../../../../src/events/core/event-client";
import { InMemoryDatastore, setDataStore } from "../../../../src";

/**
 * Producer doubles. `Kafka` is constructed inside the `KafkaOutboxSender`
 * constructor, so the module is mocked rather than injected; everything else is
 * the real class, including its timers and its transaction handling.
 */
const producers: MockProducer[] = [];

interface MockProducer {
  index: number;
  connect: jest.Mock;
  disconnect: jest.Mock;
  sendBatch: jest.Mock;
}

function newMockProducer(): MockProducer {
  const producer: MockProducer = {
    index: producers.length,
    connect: jest.fn().mockResolvedValue(undefined),
    disconnect: jest.fn().mockResolvedValue(undefined),
    sendBatch: jest.fn().mockResolvedValue(undefined),
  };
  producers.push(producer);
  return producer;
}

jest.mock("@confluentinc/kafka-javascript/lib/kafkajs", () => {
  const actual = jest.requireActual("@confluentinc/kafka-javascript/lib/kafkajs");
  return {
    ...actual,
    Kafka: jest.fn().mockImplementation(() => ({
      producer: () => newMockProducer(),
    })),
  };
});

function unknownProducerIdError(): KafkaJSError {
  const error = new KafkaJSError("The broker forgot this producer id");
  (error as any).code = 59;
  return error;
}

function outboxRow(id: string): OutboxEventListWithId {
  return {
    id,
    stream: "a-stream",
    persistedAt: new Date(),
    events: [
      {
        buffer: Buffer.from(id),
        key: id,
        timestamp: 1,
        headers: {},
      } as any,
    ],
  };
}

/** An outbox that hands out a scripted sequence of batches. */
class ScriptedOutbox implements EventOutbox {
  readonly removed: string[][] = [];
  readonly persisted: any[] = [];
  reads = 0;
  private readonly batches: OutboxEventListWithId[][];

  constructor(...batches: OutboxEventListWithId[][]) {
    this.batches = batches;
  }

  async persist(events: any): Promise<void> {
    this.persisted.push(events);
  }

  async readOutbox(): Promise<OutboxEventListWithId[]> {
    const batch = this.batches[this.reads] ?? [];
    this.reads++;
    return batch;
  }

  async removeOutboxEntries(events: OutboxEventListWithId[]): Promise<void> {
    this.removed.push(events.map((e) => e.id));
  }
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

async function settle(times = 6): Promise<void> {
  for (let i = 0; i < times; i++) {
    await tick();
  }
}

describe("KafkaOutboxSender lifecycle", () => {
  beforeEach(() => {
    producers.length = 0;
    setDataStore(new InMemoryDatastore());
  });

  const newSender = (outbox: EventOutbox, options = {}) =>
    new KafkaOutboxSender(outbox, { clientId: "t", brokers: ["localhost:9092"] } as any, undefined, options);

  it("stops the periodic flush when disconnected", async () => {
    const outbox = new ScriptedOutbox();
    const sender = newSender(outbox);

    await sender.connect();
    // The interval is the defect: before disconnect() was reachable from
    // shutdown, this timer kept firing until process.exit killed the process.
    await new Promise((resolve) => setTimeout(resolve, 900));
    const readsWhileConnected = outbox.reads;
    expect(readsWhileConnected).toBeGreaterThan(0);

    await sender.disconnect();

    await new Promise((resolve) => setTimeout(resolve, 900));
    expect(outbox.reads).toEqual(readsWhileConnected);
    expect(producers[0].disconnect).toHaveBeenCalled();
  });

  it("waits for a flush already in progress before disconnecting the producer", async () => {
    let signalSendStarted: () => void = () => undefined;
    let releaseSend: () => void = () => undefined;
    const sendStarted = new Promise<void>((resolve) => {
      signalSendStarted = resolve;
    });
    const sendMayComplete = new Promise<void>((resolve) => {
      releaseSend = resolve;
    });

    const outbox = new ScriptedOutbox([outboxRow("row-1")]);
    const sender = newSender(outbox);
    await sender.connect();

    producers[0].sendBatch.mockImplementation(async () => {
      signalSendStarted();
      await sendMayComplete;
    });

    void sender.notify();
    await sendStarted;

    let disconnected = false;
    const disconnecting = sender.disconnect().then(() => {
      disconnected = true;
    });

    await settle();
    // The producer must still be alive: the batch has been handed to Kafka but
    // its outbox rows have not been deleted yet. Disconnecting here is how a
    // shutdown turns a delivered batch into a duplicate on restart.
    expect(disconnected).toEqual(false);
    expect(producers[0].disconnect).not.toHaveBeenCalled();
    expect(outbox.removed).toEqual([]);

    releaseSend();
    await disconnecting;

    expect(outbox.removed).toEqual([["row-1"]]);
    expect(producers[0].disconnect).toHaveBeenCalled();
  });

  it("gives up waiting for a stuck flush rather than blocking shutdown forever", async () => {
    const outbox = new ScriptedOutbox([outboxRow("row-1")]);
    const sender = newSender(outbox, { shutdownFlushTimeoutMs: 100 });
    await sender.connect();

    // Never resolves: shutdown has a hard process.exit deadline, so waiting
    // without a bound only moves the abrupt kill later.
    producers[0].sendBatch.mockImplementation(() => new Promise(() => undefined));

    void sender.notify();
    await settle();

    const startedAt = Date.now();
    await sender.disconnect();
    expect(Date.now() - startedAt).toBeLessThan(2000);
    expect(producers[0].disconnect).toHaveBeenCalled();
  });

  it("refuses further emits once disconnected, and is idempotent", async () => {
    const outbox = new ScriptedOutbox();
    const sender = newSender(outbox);
    await sender.connect();
    await sender.disconnect();

    await expect(sender.notify()).rejects.toThrow(/must connect before events can be sent/);

    // A second disconnect must not disconnect the producer twice.
    await sender.disconnect();
    expect(producers[0].disconnect).toHaveBeenCalledTimes(1);
  });

  it("does not start a new flush once shutdown has begun", async () => {
    const outbox = new ScriptedOutbox();
    const sender = newSender(outbox);
    await sender.connect();
    await sender.disconnect();

    const readsAfterDisconnect = outbox.reads;
    await settle();
    expect(outbox.reads).toEqual(readsAfterDisconnect);
  });
});

describe("KafkaOutboxSender UNKNOWN_PRODUCER_ID recovery", () => {
  beforeEach(() => {
    producers.length = 0;
    setDataStore(new InMemoryDatastore());
  });

  const newSender = (outbox: EventOutbox, options = {}) =>
    new KafkaOutboxSender(outbox, { clientId: "t", brokers: ["localhost:9092"] } as any, undefined, options);

  it("replaces the producer and actually re-sends the batch", async () => {
    const outbox = new ScriptedOutbox([outboxRow("row-1")]);
    const sender = newSender(outbox);
    await sender.connect();

    producers[0].sendBatch.mockRejectedValueOnce(unknownProducerIdError());

    await sender.notify();
    await settle(12);

    // The previous implementation recursed into flush(), which returned
    // immediately because isFlushing was still true. The batch was silently
    // abandoned and the flush reported as a success: no retry, no delete, no
    // error. Both of the following assertions failed against that code.
    expect(producers).toHaveLength(2);
    expect(producers[1].connect).toHaveBeenCalled();
    expect(producers[1].sendBatch).toHaveBeenCalledTimes(1);
    expect(outbox.removed).toEqual([["row-1"]]);
    expect(sender.health().healthy).toEqual(true);
    expect(sender.recordsSent).toEqual(1);
  });

  it("reports unhealthy instead of zombieing when the replacement producer cannot connect", async () => {
    const outbox = new ScriptedOutbox([outboxRow("row-1")]);
    const sender = newSender(outbox, { unhealthyAfterFailingForMs: 0 });
    await sender.connect();

    producers[0].sendBatch.mockRejectedValueOnce(unknownProducerIdError());
    const kafka: any = (sender as any).kafka;
    const originalProducerFactory = kafka.producer;
    kafka.producer = () => {
      const p = newMockProducer();
      p.connect.mockRejectedValue(new Error("broker unreachable"));
      return p;
    };

    await sender.notify();
    await settle(12);
    kafka.producer = originalProducerFactory;

    // Before this change isConnected and producerHealth were never touched on
    // this path, so a sender holding an unconnected producer went on reporting
    // itself healthy while every subsequent flush failed.
    const health = sender.health();
    expect(health.healthy).toEqual(false);
    expect(health.producerConnected).toEqual(false);
    expect(health.lastErrorMessage).toMatch(/broker unreachable/);
    expect(sender.producerHealth.healthy).toEqual(false);

    // The rows are still in the outbox, which is the correct outcome: they are
    // durable and the next interval retries them.
    expect(outbox.removed).toEqual([]);

    await sender.disconnect();
  });

  it("does not retry more than once when the broker keeps rejecting", async () => {
    const outbox = new ScriptedOutbox([outboxRow("row-1")]);
    const sender = newSender(outbox);
    await sender.connect();

    producers[0].sendBatch.mockRejectedValue(unknownProducerIdError());
    // The replacement producer is rejected too, so the recovery path cannot
    // terminate by succeeding.
    const kafka: any = (sender as any).kafka;
    kafka.producer = () => {
      const p = newMockProducer();
      p.sendBatch.mockRejectedValue(unknownProducerIdError());
      return p;
    };

    await sender.notify();
    await settle(12);

    // Exactly one replacement. Unbounded recursion against a broker that keeps
    // rejecting would spawn producers until the process died.
    expect(producers).toHaveLength(2);
    expect(producers[1].sendBatch).toHaveBeenCalledTimes(1);
    // The rows stay in the outbox: durable, and retried by the next interval.
    expect(outbox.removed).toEqual([]);
    expect(sender.health().consecutiveFlushFailures).toBeGreaterThan(0);

    await sender.disconnect();
  });

  it("propagates a non-producer-id failure without touching the producer", async () => {
    const outbox = new ScriptedOutbox([outboxRow("row-1")]);
    const sender = newSender(outbox);
    await sender.connect();

    producers[0].sendBatch.mockRejectedValue(new Error("message too large"));

    await sender.notify();
    await settle(12);

    expect(producers).toHaveLength(1);
    expect(outbox.removed).toEqual([]);
    expect(sender.health().lastErrorMessage).toMatch(/message too large/);
    expect(sender.health().consecutiveFlushFailures).toBeGreaterThan(0);

    await sender.disconnect();
  });
});

describe("KafkaOutboxSender health", () => {
  beforeEach(() => {
    producers.length = 0;
    setDataStore(new InMemoryDatastore());
  });

  const newSender = (outbox: EventOutbox, options = {}) =>
    new KafkaOutboxSender(outbox, { clientId: "t", brokers: ["localhost:9092"] } as any, undefined, options);

  it("is unhealthy before connect", () => {
    const sender = newSender(new ScriptedOutbox());
    expect(sender.health()).toMatchObject({
      healthy: false,
      status: "not-connected",
      producerConnected: false,
      recordsSent: 0,
    });
  });

  it("counts an empty outbox read as a successful flush", async () => {
    const outbox = new ScriptedOutbox();
    const sender = newSender(outbox);
    await sender.connect();

    await sender.notify();
    await settle();

    // Reading an empty outbox proves the database half of the drain works,
    // which is exactly the signal the old code only ever wrote to a log line.
    const health = sender.health();
    expect(health.healthy).toEqual(true);
    expect(health.status).toEqual("connected");
    expect(health.lastSuccessfulFlushAt).toBeDefined();
    expect(health.msSinceLastSuccessfulFlush).toBeLessThan(5000);

    await sender.disconnect();
  });

  it("goes unhealthy once flushes have been failing past the grace period", async () => {
    const outbox = new ScriptedOutbox();
    const sender = newSender(outbox, { unhealthyAfterFailingForMs: 0 });
    await sender.connect();
    jest.spyOn(outbox, "readOutbox").mockRejectedValue(new Error("db gone"));

    await sender.notify();
    await settle();

    const health = sender.health();
    expect(health.healthy).toEqual(false);
    expect(health.status).toEqual("degraded");
    expect(health.lastErrorMessage).toMatch(/db gone/);

    await sender.disconnect();
  });

  it("tolerates a transient failure inside the grace period", async () => {
    const outbox = new ScriptedOutbox();
    const sender = newSender(outbox, { unhealthyAfterFailingForMs: 60000 });
    await sender.connect();
    const read = jest.spyOn(outbox, "readOutbox").mockRejectedValueOnce(new Error("blip"));

    await sender.notify();
    await settle();
    // A 400ms flush interval means a count-based threshold would trip on a
    // single hiccup. Within the grace period the sender stays healthy.
    expect(sender.health().healthy).toEqual(true);
    expect(sender.health().consecutiveFlushFailures).toEqual(1);

    read.mockRestore();
    await sender.notify();
    await settle();
    expect(sender.health().consecutiveFlushFailures).toEqual(0);

    await sender.disconnect();
  });

  it("reports disconnected after shutdown", async () => {
    const sender = newSender(new ScriptedOutbox());
    await sender.connect();
    await sender.notify();
    await settle();
    await sender.disconnect();

    expect(sender.health()).toMatchObject({
      healthy: false,
      status: "disconnected",
      producerConnected: false,
    });
  });
});

describe("OutboxEventClient shutdown", () => {
  function delegate(): EventClient & { shutdownCalls: number } {
    const d: any = {
      shutdownCalls: 0,
      shutdown: jest.fn(async () => {
        d.shutdownCalls++;
      }),
      emit: jest.fn(),
      coldHotStream: jest.fn(),
      coldStream: jest.fn(),
      hotRawStream: jest.fn(),
      hotStream: jest.fn(),
      isConnected: jest.fn(() => true),
    };
    return d;
  }

  const outbox: EventOutbox = {
    persist: jest.fn(),
    readOutbox: jest.fn(async () => []),
    removeOutboxEntries: jest.fn(),
  };

  it("shuts the sender down as well as the delegate", async () => {
    const order: string[] = [];
    const sender: OutboxSender = {
      notify: jest.fn(),
      disconnect: jest.fn(async () => {
        order.push("sender");
      }),
    };
    const d = delegate();
    (d.shutdown as jest.Mock).mockImplementation(async () => {
      order.push("delegate");
    });

    await new OutboxEventClient(outbox, sender, d).shutdown();

    // The whole defect: shutdown() only ever called the delegate, so the
    // sender's flush interval outlived shutdownSystem() entirely.
    expect(sender.disconnect).toHaveBeenCalled();
    // Outbound path stops before the consumers behind the delegate go away.
    expect(order).toEqual(["sender", "delegate"]);
  });

  it("still shuts the delegate down when the sender fails, then reports the failure", async () => {
    const sender: OutboxSender = {
      notify: jest.fn(),
      disconnect: jest.fn().mockRejectedValue(new Error("producer wedged")),
    };
    const d = delegate();

    await expect(new OutboxEventClient(outbox, sender, d).shutdown()).rejects.toThrow(
      /producer wedged/
    );
    // A sender that cannot stop cleanly must not strand the delegate.
    expect(d.shutdownCalls).toEqual(1);
  });

  it("still works with a sender that does not implement disconnect", async () => {
    const sender: OutboxSender = { notify: jest.fn() };
    const d = delegate();

    await new OutboxEventClient(outbox, sender, d).shutdown();

    expect(d.shutdownCalls).toEqual(1);
  });
});
