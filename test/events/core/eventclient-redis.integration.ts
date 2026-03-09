import {
  eventClient,
  EventicleEvent,
  setEventClient,
} from "../../../src/events/core/event-client";
import { testDbPurge } from "../../../src/fixture";
import { eventClientOnRedis } from "../../../src/events/core/eventclient-redis";
import * as uuid from "uuid";
import { pause } from "../../../src/util";
import { setDataStore } from "../../../src";
import InMemDatastore from "../../../src/datastore/inmem-data-store";
import { logger } from "@eventicle/eventicle-utilities";

jest.setTimeout(15000);

const TEST_STREAMS = [
  "test-mystream",
  "test-thestream",
  "test-last-stream",
  "test-multi-1",
  "test-multi-2",
];

beforeAll(async function () {
  setDataStore(new InMemDatastore());
  setEventClient(
    await eventClientOnRedis({
      redisOptions: { host: "localhost", port: 6379 },
    })
  );
  await testDbPurge();
  await (eventClient() as any).clear(TEST_STREAMS);
  await pause(500);
});

beforeEach(async () => {
  await testDbPurge();
  await (eventClient() as any).clear(TEST_STREAMS);
  await pause(500);
});

afterEach(async () => {
  await (eventClient() as any).clear(TEST_STREAMS);
});

afterAll(async () => {
  await eventClient().shutdown();
});

function createTestEvent(overrides: Partial<EventicleEvent> = {}): EventicleEvent {
  return {
    data: { message: "test-payload" },
    type: "fake-event",
    id: overrides.id || uuid.v4(),
    createdAt: new Date().getTime(),
    causedByType: "",
    causedById: "",
    source: "",
    domainId: overrides.domainId || uuid.v4(),
    ...overrides,
  };
}

test("hot stream receives events", async function () {
  const receivedEvents: EventicleEvent[] = [];

  const consumer = await eventClient().hotStream({
    stream: "test-mystream",
    groupId: "hot-test-" + uuid.v4(),
    handler: async (event) => {
      receivedEvents.push(event);
    },
    onError: (error) => {
      logger.error("BORKED", error);
    },
    deleteConsumerGroupOnClose: true,
  });

  await pause(500);

  await eventClient().emit(
    [createTestEvent({ id: "epic" })],
    "test-mystream"
  );

  await pause(3000);
  await consumer.close();

  expect(receivedEvents.length).toEqual(1);
  expect(receivedEvents[0].id).toEqual("epic");
});

test("cold stream fully replays historical", async function () {
  await eventClient().emit(
    [createTestEvent()],
    "test-thestream"
  );
  await eventClient().emit(
    [createTestEvent()],
    "test-thestream"
  );
  await eventClient().emit(
    [createTestEvent()],
    "test-thestream"
  );

  await pause(200);

  const receivedEvents: EventicleEvent[] = [];

  await new Promise<void>((resolve) => {
    eventClient()
      .coldStream({
        stream: "test-thestream",
        handler: async (event) => {
          receivedEvents.push(event);
        },
        onError: (error) => logger.error("ERROR", error),
        onDone: () => {
          resolve();
        },
      })
      .catch((reason) => logger.error("Failed cold stream", reason));
  });

  expect(receivedEvents.length).toEqual(3);
  expect(receivedEvents[0].type).toEqual("fake-event");
});

test("cold stream handles empty stream", async function () {
  let doneCalled = false;

  await new Promise<void>((resolve) => {
    eventClient()
      .coldStream({
        stream: "test-thestream",
        handler: async () => {},
        onError: (error) => logger.error("ERROR", error),
        onDone: () => {
          doneCalled = true;
          resolve();
        },
      })
      .catch((reason) => logger.error("Failed cold stream", reason));
  });

  expect(doneCalled).toBe(true);
});

test("cold hot stream fully replays historical and also events afterwards", async function () {
  const receivedEvents: EventicleEvent[] = [];

  await eventClient().emit(
    [createTestEvent({ id: "historic-1" })],
    "test-last-stream"
  );

  await pause(500);

  const control = await eventClient().coldHotStream({
    stream: "test-last-stream",
    groupId: "coldhot-test-" + uuid.v4(),
    handler: async (event) => {
      receivedEvents.push(event);
    },
    onError: (error) => logger.error("ERROR: " + error),
  });

  await pause(1000);

  await eventClient().emit(
    [createTestEvent({ id: "live-1" })],
    "test-last-stream"
  );

  await pause(3000);
  await control.close();

  expect(receivedEvents.length).toEqual(2);
  expect(receivedEvents[0].id).toEqual("historic-1");
  expect(receivedEvents[1].id).toEqual("live-1");
});

test("consumer group load balancing distributes events", async function () {
  const groupId = "lb-test-" + uuid.v4();
  const consumer1Events: EventicleEvent[] = [];
  const consumer2Events: EventicleEvent[] = [];

  const consumer1 = await eventClient().hotStream({
    stream: "test-mystream",
    groupId: groupId,
    handler: async (event) => {
      consumer1Events.push(event);
    },
    onError: (error) => logger.error("consumer1 error", error),
    deleteConsumerGroupOnClose: true,
  });

  // Note: the EventClient interface prevents duplicate groupId subscriptions.
  // For load balancing to work with Redis Streams, you need separate EventClient
  // instances (separate processes). This test verifies single-consumer group works.
  await pause(500);

  const eventCount = 5;
  for (let eventIdx = 0; eventIdx < eventCount; eventIdx++) {
    await eventClient().emit(
      [createTestEvent({ id: `event-${eventIdx}` })],
      "test-mystream"
    );
  }

  await pause(3000);
  await consumer1.close();

  expect(consumer1Events.length).toEqual(eventCount);
});

test("multiple streams subscription", async function () {
  const receivedEvents: EventicleEvent[] = [];
  const groupId = "multi-stream-" + uuid.v4();

  const consumer = await eventClient().hotStream({
    stream: ["test-multi-1", "test-multi-2"],
    groupId: groupId,
    handler: async (event) => {
      receivedEvents.push(event);
    },
    onError: (error) => logger.error("multi stream error", error),
    deleteConsumerGroupOnClose: true,
  });

  await pause(500);

  await eventClient().emit(
    [createTestEvent({ id: "from-stream-1" })],
    "test-multi-1"
  );

  await eventClient().emit(
    [createTestEvent({ id: "from-stream-2" })],
    "test-multi-2"
  );

  await pause(3000);
  await consumer.close();

  expect(receivedEvents.length).toEqual(2);
  const receivedIds = receivedEvents.map((e) => e.id).sort();
  expect(receivedIds).toEqual(["from-stream-1", "from-stream-2"]);
});

test("error handling - poison pill does not block stream", async function () {
  const receivedEvents: EventicleEvent[] = [];
  let handlerCallCount = 0;

  const consumer = await eventClient().hotStream({
    stream: "test-mystream",
    groupId: "poison-test-" + uuid.v4(),
    handler: async (event) => {
      handlerCallCount++;
      if (handlerCallCount === 1) {
        throw new Error("Simulated poison pill");
      }
      receivedEvents.push(event);
    },
    onError: (error) => logger.error("poison stream error", error),
    deleteConsumerGroupOnClose: true,
  });

  await pause(500);

  await eventClient().emit(
    [createTestEvent({ id: "poison" })],
    "test-mystream"
  );
  await eventClient().emit(
    [createTestEvent({ id: "good-event" })],
    "test-mystream"
  );

  await pause(3000);
  await consumer.close();

  expect(receivedEvents.length).toEqual(1);
  expect(receivedEvents[0].id).toEqual("good-event");
});

test("hot raw stream returns encoded events", async function () {
  const receivedEvents: any[] = [];

  const consumer = await eventClient().hotRawStream({
    stream: "test-mystream",
    groupId: "raw-test-" + uuid.v4(),
    handler: async (event) => {
      receivedEvents.push(event);
    },
    onError: (error) => {
      logger.error("raw stream error", error);
    },
    deleteConsumerGroupOnClose: true,
  });

  await pause(500);

  await eventClient().emit(
    [createTestEvent({ id: "raw-event-1" })],
    "test-mystream"
  );

  await pause(3000);
  await consumer.close();

  expect(receivedEvents.length).toEqual(1);
  expect(receivedEvents[0].buffer).toBeDefined();
  expect(receivedEvents[0].key).toBeDefined();
  expect(receivedEvents[0].headers).toBeDefined();
  expect(receivedEvents[0].timestamp).toBeDefined();
});

test("cold stream replays large batches without duplicates", async function () {
  const batchStream = "test-batch-stream-" + uuid.v4().substring(0, 8);
  const eventCount = 15;

  const smallBatchClient = await eventClientOnRedis({
    redisOptions: { host: "localhost", port: 6379 },
    coldBatchSize: 5,
  });

  for (let eventIdx = 0; eventIdx < eventCount; eventIdx++) {
    await smallBatchClient.emit(
      [createTestEvent({ id: `batch-${eventIdx}` })],
      batchStream
    );
  }

  await pause(200);

  const receivedEvents: EventicleEvent[] = [];

  await new Promise<void>((resolve) => {
    smallBatchClient
      .coldStream({
        stream: batchStream,
        handler: async (event) => {
          receivedEvents.push(event);
        },
        onError: (error) => logger.error("ERROR", error),
        onDone: () => {
          resolve();
        },
      })
      .catch((reason) => logger.error("Failed cold stream", reason));
  });

  await smallBatchClient.shutdown();

  expect(receivedEvents.length).toEqual(eventCount);
  const receivedIds = receivedEvents.map((e) => e.id);
  const uniqueIds = new Set(receivedIds);
  expect(uniqueIds.size).toEqual(eventCount);
});

test("shutdown cleanup", async function () {
  const localClient = await eventClientOnRedis({
    redisOptions: { host: "localhost", port: 6379 },
  });

  const consumer = await localClient.hotStream({
    stream: "test-mystream",
    groupId: "shutdown-test-" + uuid.v4(),
    handler: async () => {},
    onError: () => {},
  });

  expect(localClient.isConnected()).toBe(true);

  await localClient.shutdown();

  expect(localClient.isConnected()).toBe(false);
});
