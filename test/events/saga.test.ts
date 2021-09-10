
import * as uuid from "uuid"
import {
  allSagaInstances,
  allSagas,
  registerSaga,
  removeAllSagas,
  saga, SagaInstance
} from "../../src/events/saga";
import {dataStore, setDataStore} from "../../src/datastore";
import {testDbPurge} from "../../src/fixture";
import {eventClient, EventicleEvent, setEventClient} from "../../src/events/core/event-client";
import {pause} from "../../src/util";
import InMemDatastore from "../../src/datastore/inmem-data-store";
import {eventClientOnDatastore} from "../../src/events/core/eventclient-datastore";
import {eventClientOnKafka} from "../../src/events/core/eventclient-kafka";

describe('Sagas', function () {

  jest.setTimeout(15000)

  beforeAll(async () => {

    setDataStore(new InMemDatastore())
    // setEventClient(await eventClientOnKafka({
    //   brokers: ['192.168.99.103:30992'], clientId: "COOL_AWESOME" + uuid.v4()
    // }))
    setEventClient(eventClientOnDatastore())


  })

  beforeEach(async function() {
    let instances = await allSagaInstances()
    await Promise.all(instances.map(async value => {
      console.log(value)
      await dataStore().deleteEntity("system", "saga-instance", value.internalData.id)
    }))

    await removeAllSagas()
    await testDbPurge();
  })

  it('saga is in list after registration', async function () {
    await registerSaga(basicSaga())
    expect((await allSagas()).length).toBe(1);
    expect((await allSagas())[0].name).toBe("User Registered");
  });

  it('on startOn event instance data', async function () {
    await registerSaga(basicSaga())

    let id = uuid.v4()

    await eventClient().emit([{
      data: { id },
      type: "UserCreated",
      id: "epic"
    }], "users")

    await pause(100)

    let instances = await allSagaInstances()

    console.dir(instances, { depth:10})

    expect(instances.length).toBe(1)    // this one and the default.
    expect(instances[0].get("usercreated")).toBe(true)
  });

  it('existing saga onEvent handler is called when matching event appears in stream', async function () {

    let instances1 = await allSagaInstances()
    console.log(instances1)

    await registerSaga(basicSaga())

    let id = uuid.v4()

    console.log("STARTING WITH EXEC " + id)

    await eventClient().emit([{
      data: { id },
      type: "UserCreated",
      id: "epic"
    }], "users").catch(reason => console.log("OOF< WRECKED!"))

    await pause(100)

    console.log("Emitted event 1")

    await eventClient().emit([{
      data: { id },
      type: "UserDidStuff",
      id: "epic"
    }], "users")

    await pause(100)
    console.log("Emitted event 2")
    let instances = await allSagaInstances()
    console.log(instances)

    expect(instances.length).toBe(1)
    expect(instances[0].get("userdidstuff")).toBe(true)
  });

  it('when handler calls endSaga, saga instance is closed and notifies are removed.', async function () {
    let instances1 = await allSagaInstances()
    console.log(instances1)

    await registerSaga(basicSaga())

    let id = uuid.v4()

    console.log("STARTING WITH EXEC " + id)

    await eventClient().emit([{
      data: { id },
      type: "UserCreated",
      id: "epic"
    }], "users")

    await pause(100)

    await eventClient().emit([{
      data: { id },
      type: "EndEvent",
      id: "epic"
    }], "users")

    await pause(100)

    let instances = await allSagaInstances()
    console.log(instances)
    let notifies = await dataStore().findEntity("system", "saga-notify-intent", {})

    expect(notifies.length).toBe(0)
    expect(instances.length).toBe(1)
    expect(instances[0].get("ended")).toBe(true)
  });
});

interface SagaData {
  usercreated: boolean
  userdidstuff: boolean
}

function basicSaga() {
  return saga<SagaData>("User Registered")
    .subscribeStreams(["users"])
    .startOn("UserCreated", {

    },async (instance, created: EventicleEvent) => {
      instance.set("usercreated", true)
    })
    // event listener triggered by the above notifyOn
    .on("UserDidStuff", {
      matchInstance: ev => ({
        instanceProperty: "usercreated",
        value: ev.domainId
      })
    },async (instance, rejection: EventicleEvent) => {
      instance.set("userdidstuff", true)
    })
    .on("EndEvent", {
      matchInstance: ev => ({
        instanceProperty: "userdidstuff",
        value: ev.domainId
      })
    },async (instance, approved: EventicleEvent) => {
      console.log("Ending the saga now")
      instance.endSaga()
    })
}
