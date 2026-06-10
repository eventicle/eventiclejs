import {
  eventClient,
  EventicleEvent,
  setEventClient,
} from "../../../src/events/core/event-client";
import { testDbPurge } from "../../../src/fixture";
import { eventClientOnKafka } from "../../../src/events/core/eventclient-kafka";
import * as uuid from "uuid";
import { pause } from "../../../src/util";
import { setDataStore } from "../../../src";
import InMemDatastore from "../../../src/datastore/inmem-data-store";
import { logger } from "@eventicle/eventicle-utilities";
import { KafkaContainer, StartedKafkaContainer } from "@testcontainers/kafka";

jest.setTimeout(120000);

let kafkaContainer: StartedKafkaContainer;

const TEST_STREAMS = {
  hot: `mystream-${uuid.v4()}`,
  cold: `thestream-${uuid.v4()}`,
  coldHot: `last-stream-${uuid.v4()}`,
};

async function waitFor(predicate: () => boolean, timeoutMs = 30000, intervalMs = 200): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) {
    await pause(intervalMs);
  }
}

beforeAll(async function () {
  kafkaContainer = await new KafkaContainer("confluentinc/cp-kafka:7.5.0")
    .withExposedPorts(9093)
    .start();

  const brokerAddress = `${kafkaContainer.getHost()}:${kafkaContainer.getMappedPort(9093)}`;

  setDataStore(new InMemDatastore());
  setEventClient(
    await eventClientOnKafka(
      { brokers: [brokerAddress], clientId: "testclient-" + uuid.v4() },
      {
        consumerConfig: (_stream, consumerName, _type) => ({
          maxWaitTimeInMs: 100,
          groupId: consumerName,
        }),
        consumerRunConfig: (_stream, _consumerName, _type) => ({
          autoCommit: true,
          autoCommitInterval: 500,
          autoCommitThreshold: 50,
        }),
      }
    )
  );
  await testDbPurge();
  await pause(3000);
});

beforeEach(async () => {
  await testDbPurge();
});

afterEach(async () => {
  await testDbPurge();
});

afterAll(async () => {
  await eventClient().shutdown();
  await kafkaContainer.stop();
});

test("hot stream receives events", async function () {
  let myevents = [] as EventicleEvent[];

  let consumer = await eventClient().hotStream({
    stream: TEST_STREAMS.hot,
    groupId: "me-" + uuid.v4(),
    handler: async (event) => {
      myevents.push(event);
    },
    onError: (error) => {
      logger.error("BORKED", error);
    }
  });

  // Emit repeatedly until consumer picks it up (handles rebalance delays)
  const deadline = Date.now() + 60000;
  while (myevents.length === 0 && Date.now() < deadline) {
    await eventClient().emit(
      [
        {
          data: { message: "ends" },
          type: "fake-event",
          id: "epic",
          createdAt: new Date().getTime(),
          causedByType: "",
          causedById: "",
          source: "",
          domainId: uuid.v4(),
        },
      ],
      TEST_STREAMS.hot
    );
    await pause(2000);
  }

  await consumer.close();

  expect(myevents.length).toBeGreaterThanOrEqual(1);
  expect(myevents[0].id).toEqual("epic");
});

test("cold stream fully replays historical", async function () {
  let myevents = [] as EventicleEvent[];

  for (let i = 0; i < 3; i++) {
    await eventClient().emit(
      [
        {
          data: { message: "ends" },
          type: "fake-event",
          id: uuid.v4(),
          createdAt: new Date().getTime(),
          causedByType: "",
          causedById: "",
          source: "",
          domainId: uuid.v4(),
        },
      ],
      TEST_STREAMS.cold
    );
  }

  await pause(2000);

  await new Promise<void>((resolve) => {
    eventClient()
      .coldStream({
        stream: TEST_STREAMS.cold,
        handler: async (event) => {
          myevents.push(event);
        },
        onError: (error) => logger.error("ERROR", error),
        onDone: () => {
          resolve();
        }
      })
      .catch((reason) => logger.error("Failed cold stream", reason));
  });

  expect(myevents.length).toEqual(3);
  expect(myevents[0].type).toEqual("fake-event");
});

test("cold hot stream fully replays historical and also events afterwards", async function () {
  let myevents = [] as EventicleEvent[];

  await eventClient().emit(
    [
      {
        data: { message: "ends" },
        type: "fake-event",
        id: "epic",
        createdAt: new Date().getTime(),
        causedByType: "",
        causedById: "",
        source: "",
        domainId: uuid.v4(),
      },
    ],
    TEST_STREAMS.coldHot
  );

  await pause(2000);

  let control = await eventClient().coldHotStream({
    stream: TEST_STREAMS.coldHot,
    groupId: "test-group-" + uuid.v4(),
    handler: async (event) => {
      myevents.push(event);
    },
    onError: (error) => logger.error("ERROR: " + error),
  });

  await pause(5000);

  await eventClient().emit(
    [
      {
        data: { message: "ends" },
        type: "fake-event",
        id: "epic2",
        createdAt: new Date().getTime(),
        causedByType: "",
        causedById: "",
        source: "",
        domainId: uuid.v4(),
      },
    ],
    TEST_STREAMS.coldHot
  );

  await waitFor(() => myevents.length >= 2);
  await control.close();

  expect(myevents.length).toEqual(2);
  expect(myevents[0].id).toEqual("epic");
});
