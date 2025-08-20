
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

import {BullMQScheduleJobRunner} from "../../src/bullmq-schedule-job-runner";
import {setScheduler} from "../../src";
import {scheduler} from "../../api/eventiclejs";
import {SagaScheduler, DefaultSagaScheduler} from "../../src/events/saga/saga-scheduler";
import {setSagaScheduler} from "../../src/events/saga";

describe('Sagas', function () {

  jest.setTimeout(15000)
  let sched:BullMQScheduleJobRunner

  beforeAll(async () => {

    setDataStore(new InMemDatastore())
    // setEventClient(await eventClientOnKafka({
    //   brokers: ['192.168.99.103:30992'], clientId: "COOL_AWESOME" + uuid.v4()
    // }))
    setEventClient(eventClientOnDatastore())
    sched = new BullMQScheduleJobRunner({})
    await sched.startup()
    setScheduler(sched)
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
    await sched.clearAllTimers()
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

    expect(firstActiveTimers).toStrictEqual({
      "registration_timeout": "timeout",
      "reminder_notifications": "cron"
    })

    // registration_timeout is auto removed, reminder_notifications is manually removed
    expect(activeTimersAfterFirstTimerFired).toEqual({})
    expect(secondActiveTimers).toEqual({})
  });

  it('a simple timer can add itself again to retry an action', async function () {
    let instances1 = await allSagaInstances()
    console.log(instances1)

    await registerSaga(saga<timeouts, SagaData>("Simple Retrying Saga")
        .subscribeStreams(["users"])
        .startOn("EventThatNeedsRetry", {},async (instance, created: EventicleEvent) => {
          logger.info("CREATING FROM EVENT!", created)
          instance.upsertTimer("registration_timeout", {
            isCron: false, timeout: 100
          })
        })
        .onTimer("registration_timeout", async instance => {
          logger.info("Removing timers")
          let timerCount = instance.get("user_registration_timeout") || 0
          instance.set("user_registration_timeout", timerCount + 1)
          if (timerCount < 2) {
            logger.info(`Re-adding timer, ${timerCount} not at 2 yet`)
            instance.upsertTimer("registration_timeout", {
              isCron: false, timeout: 100
            })
          } else {
            logger.info("Reached 2, no more timers")
          }
        }))

    let id = uuid.v4()

    await eventClient().emit([{
      data: { id },
      type: "EventThatNeedsRetry",
      id: uuid.v4(),
      domainId: "epic"
    }], "users")

    await pause(1000)

    let instances = await allSagaInstances()

    console.log(instances)

    let user_registration_timeout_fired = instances[0].get("user_registration_timeout")
    let secondActiveTimers = instances[0].get("activeTimers")

    expect(user_registration_timeout_fired).toEqual(3)
    expect(secondActiveTimers).toEqual({})
  });

  it("should handle overlap between timer and event triggered workflow", async () => {
    // Variables to track handler execution times
    let timerStartTime: number = 0;
    let timerEndTime: number = 0;
    let eventStartTime: number = 0;
    let eventEndTime: number = 0;
    await registerSaga(
      saga<"timeout", { payment_id: string }>("verify-me")
        // this should impact both kafka and redis
        .parallelEvents(20)
        .subscribeStreams(["event-stream"])
        .startOn("starting.event", {}, async (saga1, event) => {
          console.log("Starting saga", event);
          saga1.set("payment_id", event.domainId);
          saga1.upsertTimer("timeout", {
            isCron: false,
            timeout: 100,
          });
        })
        .onTimer("timeout", async (saga1) => {
          console.log("Timer fired");
          timerStartTime = Date.now();
          await pause(2000);
          timerEndTime = Date.now();
          console.log("Timer complete");
        })
        // this will potentially overlap with the timer
        .on(
          "second.event",
          {
            matchInstance: (ev) => ({
              instanceProperty: "payment_id",
              value: ev.domainId,
            }),
          },
          async (saga1, event) => {
            console.log("Second event starting");
            eventStartTime = Date.now();
            await pause(2000);
            eventEndTime = Date.now();
            console.log("Second event complete");
          },
        ),
    );

    // start the saga up
    await eventClient().emit(
      [
        {
          id: uuid.v4(),
          type: "starting.event",
          domainId: "1234",
          causedByType: "",
          causedById: "",
          source: "",
          createdAt: new Date().getTime(),
          data: {
            some: "data",
          },
        },
      ],
      "event-stream",
    );
    await pause(100);
    await eventClient().emit(
      [
        {
          id: uuid.v4(),
          type: "second.event",
          domainId: "1234",
          causedByType: "",
          causedById: "",
          source: "",
          createdAt: new Date().getTime(),
          data: {
            some: "data",
          },
        },
      ],
      "event-stream",
    );

    await pause(4000);

    // Check for overlap between timer and event handler
    console.log(`Timer: ${timerStartTime} - ${timerEndTime}`);
    console.log(`Event: ${eventStartTime} - ${eventEndTime}`);

    // Two time ranges overlap if one starts before the other ends and ends after the other starts
    const hasOverlap = timerStartTime < eventEndTime && timerEndTime > eventStartTime;

    if (timerStartTime == timerEndTime) {
      throw new Error(
        `Timer (range ${timerStartTime}-${timerEndTime}) did not appear to fire`,
      );
    }

    // Fail the test if there's overlap
    if (hasOverlap) {
      throw new Error(
        `Timer (${timerStartTime}-${timerEndTime}) and event handler (${eventStartTime}-${eventEndTime}) time ranges overlap`,
      );
    }

    // If we get here, there's no overlap
    expect(hasOverlap).toBe(false);
  });

  it('should handle errors thrown in custom saga scheduler', async function () {
    class ErrorThrowingSagaScheduler implements SagaScheduler {
      private eventCallCount = 0;
      private timerCallCount = 0;
      
      async sagaHandleEvent(saga: Saga<any, any>, event: EventicleEvent, instanceId: string): Promise<void> {
        this.eventCallCount++;
        throw new Error(`Custom scheduler error on event ${event.type} for instance ${instanceId}`);
      }
      
      async handleTimer(saga: Saga<any, any>, name: string, data: { instanceId: string }): Promise<void> {
        this.timerCallCount++;
        throw new Error(`Custom scheduler error on timer ${name} for instance ${data.instanceId}`);
      }
      
      getCallCounts() {
        return { events: this.eventCallCount, timers: this.timerCallCount };
      }
    }
    
    const errorScheduler = new ErrorThrowingSagaScheduler();
    const originalScheduler = new DefaultSagaScheduler();
    
    let errorHandlerCalled = false;
    let capturedError: Error | null = null;
    let capturedEvent: EventicleEvent | null = null;
    
    const testSaga = saga<"errorTimer", { domainId: string }>("ErrorHandlingSaga")
      .subscribeStreams(["test-stream"])
      .startOn("TestEvent", {}, async (instance, event) => {
        instance.set("domainId", event.domainId);
        instance.upsertTimer("errorTimer", {
          isCron: false,
          timeout: 100
        });
      })
      .on("SecondEvent", {
        matchInstance: ev => ({
          instanceProperty: "domainId",
          value: ev.domainId
        })
      }, async (instance, event) => {
        instance.set("secondEventReceived", true);
      })
      .onTimer("errorTimer", async (instance) => {
        instance.set("timerFired", true);
      })
      .onError(async (saga, event, error) => {
        errorHandlerCalled = true;
        capturedError = error;
        capturedEvent = event;
      });
    
    setSagaScheduler(errorScheduler);
    
    try {
      await registerSaga(testSaga);
      
      const testId = uuid.v4();
      
      await eventClient().emit([{
        id: uuid.v4(),
        type: "TestEvent",
        domainId: testId,
        data: { test: true }
      }], "test-stream");
      
      await pause(200);
      
      await eventClient().emit([{
        id: uuid.v4(),
        type: "SecondEvent",
        domainId: testId,
        data: { test: true }
      }], "test-stream");
      
      await pause(500);
      
      expect(errorHandlerCalled).toBe(true);
      expect(capturedError).not.toBeNull();
      expect(capturedError?.message).toContain("Custom scheduler error");
      expect(capturedEvent).not.toBeNull();
      
      const callCounts = errorScheduler.getCallCounts();
      expect(callCounts.events).toBeGreaterThan(0);
      
      const instances = await allSagaInstances();
      const sagaInstance = instances.find(i => i.get("domainId") === testId);
      expect(sagaInstance).toBeDefined();
      expect(sagaInstance?.get("secondEventReceived")).toBeUndefined();
      expect(sagaInstance?.get("timerFired")).toBeUndefined();
      
    } finally {
      setSagaScheduler(originalScheduler);
    }
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
  user_registration_timeout: number
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
        isCron: false, timeout: 2950
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
