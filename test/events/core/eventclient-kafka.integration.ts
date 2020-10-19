import {eventClient, EventicleEvent, setEventClient} from "../../../src/events/core/event-client";
import {testDbPurge} from "../../../src/fixture";
import {eventClientOnKafka} from "../../../src/events/core/eventclient-kafka";
import * as uuid from "uuid"
import {errorComparator} from "tslint/lib/verify/lintError";
import {pause} from "../../../src/util";
import {setDataStore} from "../../../src/datastore";
import InMemDatastore from "../../../src/datastore/inmem-data-store"
import logger from "../../../src/logger";

jest.setTimeout(10000)

beforeAll(async function () {
  // await initConfig();
  let clientId = "testclient-" + uuid.v4()

  setDataStore(new InMemDatastore())
  setEventClient(await eventClientOnKafka({
    brokers: ['192.168.99.103:30992'], clientId: clientId
  }))
  await testDbPurge();
});

afterEach(async () => {
  await testDbPurge();
  await (eventClient() as any).clear(["mystream", "thestream", "test-mystream"])
})

test('hot stream recieves events', async function () {

  let myevents = [] as EventicleEvent[]

  let consumer = await eventClient().hotStream("mystream", "me", async event => {
    myevents.push(event)
  }, error => {
    logger.error("BORKED", error)
  })

  await eventClient().emit([{
    data: {message: "ends"},
    type: "fake-event",
    id: "epic"
  }], "mystream")

  await pause(1500)
  await consumer.close()

  expect(myevents.length).toEqual(1);
  expect(myevents[0].id).toEqual("epic");
});

test('cold stream fully replays historical', async function (done) {

  await (eventClient() as any).clear(["thestream"])

  let myevents = [] as EventicleEvent[]

  await eventClient().emit([{
    data: {message: "ends"},
    type: "fake-event",
    id: uuid.v4()
  }], "thestream")

  await eventClient().emit([{
    data: {message: "ends"},
    type: "fake-event",
    id: uuid.v4()
  }], "thestream")

  await eventClient().emit([{
    data: {message: "ends"},
    type: "fake-event",
    id: uuid.v4()
  }], "thestream")

  await pause(100).catch(reason => console.log(reason))

  await new Promise(resolve => {
    eventClient().coldStream("thestream",
      async event => {
        myevents.push(event)
      }, (done) => console.log("ERROR"), () => {
      resolve()
      }).catch(reason => logger.error("Failed cold stream", reason))
  })

  await pause(2000)

  console.log(myevents)
  expect(myevents.length).toEqual(3);
  expect(myevents[0].type).toEqual("fake-event");
  done()
});

test('cold hot stream fully replays historical and also events afterwards', async function () {

  let myevents = [] as EventicleEvent[]

  await eventClient().emit([{
    data: {message: "ends"},
    type: "fake-event",
    id: "epic"
  }], "mystream")

  await pause(500)

  let control = await eventClient().coldHotStream({
    stream: "mystream",
    handler: async event => {
      myevents.push(event)
    },
    onError: (done) => console.log("ERROR: " + done)
  })
  await pause(500)
  await eventClient().emit([{
    data: {message: "ends"},
    type: "fake-event",
    id: "epic2"
  }], "mystream")

  await pause(3000)
  await control.close()

  expect(myevents.length).toEqual(2);
  expect(myevents[0].id).toEqual("epic");
});
