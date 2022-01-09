import {LocalScheduleJobRunner} from "../src/local-schedule-job-runner";
import {testDbPurge} from "../src/fixture";
import {InMemoryDatastore, setDataStore} from "../src";
import {pause} from "../src/util";
import {dataStore} from "../src";

describe('Schedule Job Runner on LockManager', function () {

  jest.setTimeout(15000)

  let scheduler:LocalScheduleJobRunner

  const listener1Data = []
  const listener2Data = []


  beforeAll(async () => {
    scheduler = new LocalScheduleJobRunner

    await scheduler.addScheduleTaskListener("listener1", async (name, data) => {
      listener1Data.push({
        name, data
      })
    })

    await scheduler.addScheduleTaskListener("listener2", async (name, data) => {
      listener2Data.push({
        name, data
      })
    })

    setDataStore(new InMemoryDatastore)
  })

  beforeEach(async function () {

    scheduler.clearAllTimers()
    await testDbPurge();
    listener1Data.length = 0
    listener2Data.length = 0
  })

  it('if schedule a simple timer, will trigger and pass the data to the listener with meta', async function () {

    scheduler.addScheduledTask("listener1", "do-something", {
      isCron: false, timeout: 100
    }, { hello: "there" })

    let dataBeforeFire = await dataStore().findEntity("system", "lock-manager-timer", {})

    await pause(200)

    let dataAfterFire = await dataStore().findEntity("system", "lock-manager-timer", {})

    expect(listener2Data.length).toBe(0)
    expect(listener1Data.length).toBe(1)
    expect(listener1Data[0]).toStrictEqual({ name: "do-something", data: { hello: "there" }})

    expect(dataBeforeFire.length).toBe(1)
    expect(dataAfterFire.length).toBe(0)

  })

  it('if schedule cron timer, will trigger and pass the data to the listener with meta', async function () {
    scheduler.addScheduledTask("listener1", "do-something", {
      isCron: true, crontab: "* * * * * *"
    }, { hello: "there" })

    let dataBeforeFire = await dataStore().findEntity("system", "lock-manager-cron", {})

    await pause(1000)

    let dataAfterFire = await dataStore().findEntity("system", "lock-manager-cron", {})

    expect(listener2Data.length).toBe(0)
    expect(listener1Data.length).toBe(1)
    expect(listener1Data[0]).toStrictEqual({ name: "do-something", data: { hello: "there" }})

    expect(dataBeforeFire.length).toBe(1)
    expect(dataAfterFire.length).toBe(1)

    // exists in datastore before the timer runs
    // also exists after the timer has run (check datastore)
  })

  it('if schedule simple timer, then removeSchedule, will not fire.', async function () {
    scheduler.addScheduledTask("listener1", "do-something", {
      isCron: false, timeout: 100
    }, { hello: "there" })

    let dataBeforeFire = await dataStore().findEntity("system", "lock-manager-timer", {})

    await pause(50)

    await scheduler.removeSchedule("listener1", "do-something")

    await pause(200)

    let dataAfterFire = await dataStore().findEntity("system", "lock-manager-timer", {})

    expect(listener2Data.length).toBe(0)
    expect(listener1Data.length).toBe(0)

    expect(dataBeforeFire.length).toBe(1)
    expect(dataAfterFire.length).toBe(0)
  })

  it('if schedule cron timer, then removeSchedule, will not fire.', async function () {
    scheduler.addScheduledTask("listener1", "do-something", {
      isCron: true, crontab: "* * * * * *"
    }, { hello: "there" })

    let dataBeforeFire = await dataStore().findEntity("system", "lock-manager-cron", {})

    await pause(50)

    await scheduler.removeSchedule("listener1", "do-something")

    await pause(1100)

    let dataAfterFire = await dataStore().findEntity("system", "lock-manager-cron", {})

    expect(listener2Data.length).toBe(0)
    expect(listener1Data.length).toBe(0)

    expect(dataBeforeFire.length).toBe(1)
    expect(dataAfterFire.length).toBe(0)
  })

  it('loads existing timer schedules from DB and fires them on startup', async function () {

    await pause(100)

    await dataStore().createEntity("system", "lock-manager-timer", {
      component: "listener1",
      name: "do-something",
      config: { isCron: false, timeout: 100},
      data: { "hello": "there"},
      nextExecutionTime: Date.now() + 100
    })

    await scheduler.startup()

    let dataBeforeFire = await dataStore().findEntity("system", "lock-manager-timer", {})

    await pause(300)

    let dataAfterFire = await dataStore().findEntity("system", "lock-manager-timer", {})

    expect(listener2Data.length).toBe(0)
    expect(listener1Data.length).toBe(1)

    expect(dataBeforeFire.length).toBe(1)
    expect(dataAfterFire.length).toBe(0)
  })

  it('loads existing cron schedules from DB and fires them on startup', async function () {

    await pause(100)

    await dataStore().createEntity("system", "lock-manager-cron", {
      component: "listener1",
      name: "do-something",
      config: { isCron: true, crontab: "* * * * * *"},
      data: { "hello": "there"},
      nextExecutionTime: Date.now() + 100
    })

    await scheduler.startup()

    let dataBeforeFire = await dataStore().findEntity("system", "lock-manager-cron", {})

    // the cron can theoretically fire twice in this period, but it's unlikely.
    await pause(1000)

    let dataAfterFire = await dataStore().findEntity("system", "lock-manager-cron", {})

    expect(listener2Data.length).toBe(0)
    expect(listener1Data.length).toBe(1)

    expect(dataBeforeFire.length).toBe(1)
    expect(dataAfterFire.length).toBe(1)
  })
})
