
import * as uuid from "uuid"
import {
  allSagaInstances,
  allSagas,
  registerSaga,
  removeAllSagas,
  saga
} from "../../src/events/saga";
import {testDbPurge} from "../../src/fixture";
import {eventClient, EventicleEvent, setEventClient} from "../../src/events/core/event-client";
import {pause} from "../../src/util";
import InMemDatastore from "../../src/datastore/inmem-data-store";
import {eventClientOnDatastore} from "../../src/events/core/eventclient-datastore";
import {setDataStore, dataStore} from "../../src";
import {logger} from "@eventicle/eventicle-utilities";

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
    await (eventClientOnDatastore() as any).clear()
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
      id: uuid.v4()
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

    console.log(await allSagas())

    await registerSaga(basicSaga())

    await pause(500)

    let id = uuid.v4()

    console.log("STARTING WITH EXEC " + id)

    await eventClient().emit([{
      domainId: "epic",
      data: { id },
      type: "UserCreated",
      id
    }], "users").catch(reason => console.log("OOF< WRECKED!"))

    await pause(100)

    console.log("Emitted event 1")

    await eventClient().emit([{
      domainId: "epic",
      data: { id },
      type: "UserDidStuff",
      id: uuid.v4()
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
      id: uuid.v4(),
      domainId: "epic"
    }], "users")

    await pause(100)

    await eventClient().emit([{
      data: { id },
      type: "EndEvent",
      id: uuid.v4(),
      domainId: "epic"
    }], "users")

    await pause(100)

    let instances = await allSagaInstances()
    console.log(instances)
    let notifies = await dataStore().findEntity("system", "saga-notify-intent", {})

    expect(notifies.length).toBe(0)
    expect(instances.length).toBe(1)
    expect(instances[0].get("ended")).toBe(true)
  });

  it('timers will fire appropriately and can be removed', async function () {
    let instances1 = await allSagaInstances()
    console.log(instances1)

    await registerSaga(timerSaga())

    let id = uuid.v4()

    console.log("STARTING WITH EXEC " + id)

    /*
    on start of saga, will start a simple timer and a cron

    the cron will execute a few times, then the simple timer will execute.

    the simple timer handler will remove the cron, then we wait a couple of seconds and see that the counter is not going up.

     */


    await eventClient().emit([{
      data: { id },
      type: "UserCreated",
      id: uuid.v4(),
      domainId: "epic"
    }], "users")

    await pause(100)
    let instances = await allSagaInstances()
    let firstActiveTimers = instances[0].get("activeTimers")

    await pause(3200)
    instances = await allSagaInstances()
    let activeTimersAfterFirstTimerFired = instances[0].get("activeTimers")
    let firstCount = instances[0].get("user_reminder_count")


    await pause(3000)
    instances = await allSagaInstances()

    console.log(instances)

    let timerFired = instances[0].get("user_registration_timeout_fired")
    let secondCount = instances[0].get("user_reminder_count")
    let secondActiveTimers = instances[0].get("activeTimers")

    expect(timerFired).toBeTruthy()
    expect(secondCount).toEqual(firstCount)

    expect(firstActiveTimers).toStrictEqual({
      "registration_timeout": "timeout",
      "reminder_notifications": "cron"
    })

    // registration_timeout is auto removed, reminder_notifications is manually removed
    expect(activeTimersAfterFirstTimerFired).toEqual({})
    expect(secondActiveTimers).toEqual({})
  });

  /*
  TODO, this is in flight

  upsertTimer
  clearTimer

  fires onTimer for a simple timeout

  fires onTimer for a cron expression

  if the saga ends, remove all the timers for it. (means that we need to persist the timer names in the saga data)

   */

});

interface SagaData {
  usercreated: boolean
  userdidstuff: boolean
  domainId: string

  user_registration_timeout_fired: boolean
  user_reminder_count: number
}

type timeouts = "registration_timeout" | "reminder_notifications"

function basicSaga() {
  return saga<timeouts, SagaData>("User Registered")
    .subscribeStreams(["users"])
    .startOn("UserCreated", {

    },async (instance, created: EventicleEvent) => {
      logger.info("CREATING FROM EVENT!", created)
      instance.set("usercreated", true)
      instance.set("domainId", created.domainId)
    })
    // event listener triggered by the above notifyOn
    .on("UserDidStuff", {
      matchInstance: ev => ({
        instanceProperty: "domainId",
        value: ev.domainId
      })
    },async (instance, rejection: EventicleEvent) => {
      instance.set("userdidstuff", true)
    })
    .on("EndEvent", {
      matchInstance: ev => ({
        instanceProperty: "domainId",
        value: ev.domainId
      })
    },async (instance, approved: EventicleEvent) => {
      console.log("Ending the saga now")

      instance.endSaga(true)
    })
}


function timerSaga() {
  return saga<timeouts, SagaData>("User Register Saga With Timers")
    .subscribeStreams(["users"])
    .startOn("UserCreated", {},async (instance, created: EventicleEvent) => {
      logger.info("CREATING FROM EVENT!", created)
      instance.set("usercreated", true)
      instance.set("domainId", created.domainId)

      instance.upsertTimer("reminder_notifications", {
        isCron: true, crontab: "* * * * * *" // every second
      })

      instance.upsertTimer("registration_timeout", {
        isCron: false, timeout: 3000
      })
    })
    .onTimer("registration_timeout", async instance => {
      logger.info("Removing timers")
      instance.set("user_registration_timeout_fired", true)
      instance.removeTimer("reminder_notifications")
    })
    .onTimer("reminder_notifications", async instance => {
      logger.info("Doing a reminder")
      if (!instance.get("user_reminder_count")) {
        instance.set("user_reminder_count", 1)
      } else {
        instance.set("user_reminder_count", instance.get("user_reminder_count") + 1)
      }
    })

}
