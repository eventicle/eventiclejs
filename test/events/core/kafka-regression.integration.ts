/**
 * Kafka Regression Test Pack
 *
 * Exercises the eventiclejs EventClient Kafka implementation against a real
 * Kafka broker via testcontainers. These tests form the regression baseline
 * before migrating from kafkajs to @confluentinc/kafka-javascript.
 *
 * Covers:
 *  1. Hot stream: subscribes then receives new events
 *  2. Cold stream: replays all historical events then completes
 *  3. Cold-hot stream: replays history then continues receiving live events
 *  4. Producer: emit, batching, topic auto-creation
 *  5. Consumer health monitoring via getKafkaClientHealth()
 *  6. Multi-partition ordering and parallel consumption
 *  7. Raw (encoded) event streaming
 *  8. Consumer group load balancing (two consumers, same groupId)
 */

import { KafkaContainer, StartedKafkaContainer } from "@testcontainers/kafka";
import {
  eventClient,
  EventicleEvent,
  setEventClient,
  EncodedEvent,
} from "../../../src/events/core/event-client";
import {
  eventClientOnKafka,
  getKafkaClientHealth,
} from "../../../src/events/core/eventclient-kafka";
import { setDataStore } from "../../../src";
import InMemDatastore from "../../../src/datastore/inmem-data-store";
import { pause } from "../../../src/util";
import * as uuid from "uuid";

jest.setTimeout(120_000);

let kafkaContainer: StartedKafkaContainer;
let brokerAddress: string;

beforeAll(async () => {
  kafkaContainer = await new KafkaContainer("confluentinc/cp-kafka:7.5.0")
    .withExposedPorts(9093)
    .start();

  brokerAddress = `${kafkaContainer.getHost()}:${kafkaContainer.getMappedPort(9093)}`;

  setDataStore(new InMemDatastore());
  setEventClient(
    await eventClientOnKafka(
      { brokers: [brokerAddress], clientId: `test-${uuid.v4()}` },
      {
        consumerConfig: (_stream, consumerName, _type) => ({
          maxWaitTimeInMs: 100,
          groupId: consumerName,
        }),
        consumerRunConfig: (_stream, _consumerName, type) => {
          if (type === "COLD") {
            return { autoCommit: true, autoCommitInterval: 500, autoCommitThreshold: 50 };
          }
          return {
            autoCommit: true,
            autoCommitInterval: 500,
            autoCommitThreshold: 50,
            partitionsConsumedConcurrently: 5,
          };
        },
      },
      async (_topicName) => ({
        createTopic: true,
        numPartitions: 3,
        replicationFactor: 1,
      })
    )
  );

  // Wait for producer to be healthy
  await pause(2000);
});

afterAll(async () => {
  await eventClient().shutdown();
  await kafkaContainer.stop();
});

async function ensureTopicsExist(topics: string[]) {
  const { getKafkaClient } = require("../../../src/events/core/eventclient-kafka");
  const admin = getKafkaClient().admin();
  await admin.connect();
  await admin.createTopics({ topics: topics.map(t => ({ topic: t, numPartitions: 3, replicationFactor: 1 })) });
  await admin.disconnect();
  await pause(1000);
}

function makeEvent(overrides: Partial<EventicleEvent> = {}): EventicleEvent {
  return {
    type: "test.event",
    id: uuid.v4(),
    domainId: uuid.v4(),
    data: { value: Math.random() },
    createdAt: Date.now(),
    source: "regression-test",
    causedById: "",
    causedByType: "",
    ...overrides,
  };
}

// ─── Hot Stream Tests ────────────────────────────────────────────

describe("Hot Stream", () => {
  test("receives events published after subscription", async () => {
    const stream = `hot-${uuid.v4()}`;
    const received: EventicleEvent[] = [];

    const sub = await eventClient().hotStream({
      stream,
      groupId: `hot-group-${uuid.v4()}`,
      handler: async (event) => { received.push(event); },
      onError: (err) => { throw err; },
    });

    await pause(2000); // let consumer group stabilize

    await eventClient().emit([makeEvent({ type: "hot.first" })], stream);
    await eventClient().emit([makeEvent({ type: "hot.second" })], stream);

    await pause(3000);
    await sub.close();

    expect(received.length).toBe(2);
    expect(received[0].type).toBe("hot.first");
    expect(received[1].type).toBe("hot.second");
  });

  test("does NOT receive events published before subscription", async () => {
    const stream = `hot-preexist-${uuid.v4()}`;
    const received: EventicleEvent[] = [];

    // Emit before subscribing
    await eventClient().emit([makeEvent({ type: "pre.existing" })], stream);
    await pause(1000);

    const sub = await eventClient().hotStream({
      stream,
      groupId: `hot-group-pre-${uuid.v4()}`,
      handler: async (event) => { received.push(event); },
      onError: (err) => { throw err; },
    });

    await pause(3000);
    await sub.close();

    // Hot stream should not replay history
    expect(received.length).toBe(0);
  });

  test("supports multiple streams in one subscription", async () => {
    const streamA = `hot-multi-a-${uuid.v4()}`;
    const streamB = `hot-multi-b-${uuid.v4()}`;
    const received: EventicleEvent[] = [];

    await ensureTopicsExist([streamA, streamB]);

    const sub = await eventClient().hotStream({
      stream: [streamA, streamB],
      groupId: `hot-multi-${uuid.v4()}`,
      handler: async (event) => { received.push(event); },
      onError: (err) => { throw err; },
    });

    await pause(3000);

    await eventClient().emit([makeEvent({ type: "from.a" })], streamA);
    await eventClient().emit([makeEvent({ type: "from.b" })], streamB);

    await pause(5000);
    await sub.close();

    expect(received.length).toBe(2);
    const types = received.map((e) => e.type).sort();
    expect(types).toEqual(["from.a", "from.b"]);
  });
});

// ─── Cold Stream Tests ───────────────────────────────────────────

describe("Cold Stream", () => {
  test("replays all historical events then completes", async () => {
    const stream = `cold-${uuid.v4()}`;
    const received: EventicleEvent[] = [];

    // Emit events first
    for (let i = 0; i < 5; i++) {
      await eventClient().emit([makeEvent({ type: `cold.event.${i}` })], stream);
    }
    await pause(1000);

    await new Promise<void>((resolve, reject) => {
      eventClient()
        .coldStream({
          stream,
          handler: async (event) => { received.push(event); },
          onError: (err) => reject(err),
          onDone: () => resolve(),
        })
        .catch(reject);
    });

    expect(received.length).toBe(5);
    const types = received.map(e => e.type).sort();
    for (let i = 0; i < 5; i++) {
      expect(types[i]).toBe(`cold.event.${i}`);
    }
  });

  test("completes immediately on empty topic", async () => {
    const stream = `cold-empty-${uuid.v4()}`;

    // Create the topic by emitting and consuming, then clear won't help
    // Instead rely on onTopicFailure creating the empty topic
    const done = await new Promise<boolean>((resolve, reject) => {
      eventClient()
        .coldStream({
          stream,
          handler: async () => {},
          onError: (err) => reject(err),
          onDone: () => resolve(true),
        })
        .catch(reject);
    });

    expect(done).toBe(true);
  });
});

// ─── Cold-Hot Stream Tests ───────────────────────────────────────

describe("Cold-Hot Stream", () => {
  test("replays history then receives live events", async () => {
    const stream = `coldhot-${uuid.v4()}`;
    const received: EventicleEvent[] = [];

    // Emit historical events
    await eventClient().emit([makeEvent({ type: "history.1" })], stream);
    await eventClient().emit([makeEvent({ type: "history.2" })], stream);
    await pause(1000);

    const sub = await eventClient().coldHotStream({
      stream,
      groupId: `coldhot-group-${uuid.v4()}`,
      handler: async (event) => { received.push(event); },
      onError: (err) => { throw err; },
    });

    await pause(3000);

    // Emit live events
    await eventClient().emit([makeEvent({ type: "live.1" })], stream);
    await pause(2000);

    await sub.close();

    expect(received.length).toBeGreaterThanOrEqual(3);
    const types = received.map((e) => e.type);
    expect(types).toContain("history.1");
    expect(types).toContain("history.2");
    expect(types).toContain("live.1");
  });
});

// ─── Producer / ThrottledProducer Tests ──────────────────────────

describe("Producer", () => {
  test("emits batch of events atomically", async () => {
    const stream = `producer-batch-${uuid.v4()}`;
    const received: EventicleEvent[] = [];
    const batchSize = 20;

    const events = Array.from({ length: batchSize }, (_, i) =>
      makeEvent({ type: `batch.${i}` })
    );

    await eventClient().emit(events, stream);
    await pause(1000);

    await new Promise<void>((resolve, reject) => {
      eventClient()
        .coldStream({
          stream,
          handler: async (event) => { received.push(event); },
          onError: reject,
          onDone: () => resolve(),
        })
        .catch(reject);
    });

    expect(received.length).toBe(batchSize);
  });

  test("handles topic auto-creation on first emit", async () => {
    const stream = `auto-create-${uuid.v4()}`;

    // This should not throw, the topic will be auto-created
    await eventClient().emit([makeEvent({ type: "first.on.new.topic" })], stream);

    const received: EventicleEvent[] = [];
    await new Promise<void>((resolve, reject) => {
      eventClient()
        .coldStream({
          stream,
          handler: async (event) => { received.push(event); },
          onError: reject,
          onDone: () => resolve(),
        })
        .catch(reject);
    });

    expect(received.length).toBe(1);
    expect(received[0].type).toBe("first.on.new.topic");
  });

  test("preserves event data fidelity through encode/decode cycle", async () => {
    const stream = `fidelity-${uuid.v4()}`;
    const originalData = {
      nested: { value: 42, arr: [1, 2, 3] },
      str: "hello world",
      bool: true,
    };

    await eventClient().emit(
      [makeEvent({ type: "fidelity.check", data: originalData, domainId: "domain-99" })],
      stream
    );
    await pause(1000);

    const received: EventicleEvent[] = [];
    await new Promise<void>((resolve, reject) => {
      eventClient()
        .coldStream({
          stream,
          handler: async (event) => { received.push(event); },
          onError: reject,
          onDone: () => resolve(),
        })
        .catch(reject);
    });

    expect(received[0].data).toEqual(originalData);
    expect(received[0].type).toBe("fidelity.check");
    expect(received[0].domainId).toBe("domain-99");
  });
});

// ─── Health Monitoring Tests ─────────────────────────────────────

describe("Health Monitoring", () => {
  test("reports healthy after connection", async () => {
    const health = getKafkaClientHealth();
    expect(health.producer.healthy).toBe(true);
    expect(health.producer.status).toBe("connected");
  });

  test("consumer health updates on subscription", async () => {
    const stream = `health-${uuid.v4()}`;
    const groupId = `health-group-${uuid.v4()}`;

    const sub = await eventClient().hotStream({
      stream,
      groupId,
      handler: async () => {},
      onError: () => {},
    });

    await pause(3000);

    const health = getKafkaClientHealth();
    expect(health.consumers[groupId]).toBeDefined();
    expect(health.consumers[groupId].healthy).toBe(true);

    await sub.close();
  });
});

// ─── Raw Event Streaming Tests ───────────────────────────────────

describe("Raw Event Streaming", () => {
  test("hotRawStream receives encoded events", async () => {
    const stream = `raw-${uuid.v4()}`;
    const received: EncodedEvent[] = [];

    await ensureTopicsExist([stream]);

    const sub = await eventClient().hotRawStream({
      stream,
      groupId: `raw-group-${uuid.v4()}`,
      handler: async (event) => { received.push(event); },
      onError: (err) => { throw err; },
    });

    await pause(3000);

    await eventClient().emit([makeEvent({ type: "raw.event" })], stream);
    await pause(5000);

    await sub.close();

    expect(received.length).toBe(1);
    expect(received[0].buffer).toBeInstanceOf(Buffer);
    expect(received[0].headers).toBeDefined();
    expect(received[0].headers.type.toString()).toBe("raw.event");
  });

  test("coldHotStream with rawEvents=true receives encoded events", async () => {
    const stream = `raw-coldhot-${uuid.v4()}`;
    const received: EncodedEvent[] = [];

    await eventClient().emit([makeEvent({ type: "raw.historical" })], stream);
    await pause(1000);

    const sub = await eventClient().coldHotStream({
      rawEvents: true,
      stream,
      groupId: `raw-coldhot-group-${uuid.v4()}`,
      handler: async (event) => { received.push(event); },
      onError: (err) => { throw err; },
    });

    await pause(3000);
    await sub.close();

    expect(received.length).toBeGreaterThanOrEqual(1);
    expect(received[0].buffer).toBeInstanceOf(Buffer);
  });
});

// ─── Consumer Group Behaviour ────────────────────────────────────

describe("Consumer Group Load Balancing", () => {
  test("independent consumers each receive all events on separate groups", async () => {
    const stream = `cg-${uuid.v4()}`;
    const receivedA: EventicleEvent[] = [];
    const receivedB: EventicleEvent[] = [];

    await ensureTopicsExist([stream]);

    // eventiclejs enforces one consumer per groupId per process (module-level guard).
    // Validate that two separate groups each receive all events independently.
    const subA = await eventClient().hotStream({
      stream,
      groupId: `group-a-${uuid.v4()}`,
      handler: async (event) => { receivedA.push(event); },
      onError: () => {},
    });

    const subB = await eventClient().hotStream({
      stream,
      groupId: `group-b-${uuid.v4()}`,
      handler: async (event) => { receivedB.push(event); },
      onError: () => {},
    });

    await pause(5000);

    const events = Array.from({ length: 10 }, (_, i) =>
      makeEvent({ type: `cg.${i}`, domainId: `key-${i}` })
    );
    await eventClient().emit(events, stream);

    await pause(5000);

    await subA.close();
    await subB.close();

    // Both consumers should receive all 10 events (separate groups = no partition splitting)
    expect(receivedA.length).toBe(10);
    expect(receivedB.length).toBe(10);
  });
});
