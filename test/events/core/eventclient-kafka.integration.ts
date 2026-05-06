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

jest.setTimeout(10000);

const TEST_STREAMS = {
  hot: `mystream-${uuid.v4()}`,
  cold: `thestream-${uuid.v4()}`,
  coldHot: `last-stream-${uuid.v4()}`,
};

beforeAll(async function () {
  // await initConfig();
  let clientId = "testclient-" + uuid.v4();

  setDataStore(new InMemDatastore());
  setEventClient(
    await eventClientOnKafka({
      brokers: ["localhost:9092"],
      clientId: clientId,
    })
  );
  await testDbPurge();
  await pause(5000);
});
beforeEach(async () => {
  console.log("STARTING DATA PUURGE");
  await testDbPurge();
});
afterEach(async () => {
  await testDbPurge();
});

afterAll(async () => {
  await eventClient().shutdown();
});

test("hot stream receives events", async function () {
  let myevents = [] as EventicleEvent[];

  let consumer = await eventClient().hotStream({
    stream: TEST_STREAMS.hot,
    groupId: "me",
    handler: async (event) => {
      myevents.push(event);
    },
    onError: (error) => {
      logger.error("BORKED", error);
    }
  });

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

  await pause(1500);
  await consumer.close();

  console.log("DOOPEY");

  expect(myevents.length).toEqual(1);
  expect(myevents[0].id).toEqual("epic");
});

test("cold stream fully replays historical", async function () {
  let myevents = [] as EventicleEvent[];

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

  await pause(100).catch((reason) => console.log(reason));

  await new Promise((resolve) => {
    eventClient()
      .coldStream({
        stream: TEST_STREAMS.cold,
        handler: async (event) => {
          myevents.push(event);
        },
        onError: (done) => console.log("ERROR"),
        onDone: () => {
          resolve(null);
        }
      })
      .catch((reason) => logger.error("Failed cold stream", reason));
  });

  await pause(2000);

  console.log(myevents);
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

  await pause(500);

  let control = await eventClient().coldHotStream({
    stream: TEST_STREAMS.coldHot,
    groupId: "test-group",
    handler: async (event) => {
      myevents.push(event);
    },
    onError: (done) => console.log("ERROR: " + done),
  });
  await pause(500);
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

  await pause(3000);
  await control.close();

  console.log(myevents);

  expect(myevents.length).toEqual(2);
  expect(myevents[0].id).toEqual("epic");
});
