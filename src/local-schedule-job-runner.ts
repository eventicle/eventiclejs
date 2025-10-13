import {ScheduleJobRunner} from "@eventicle/eventicle-utilities/dist/schedule-job-runner";
import {EventEmitter} from "events";
import {logger} from "@eventicle/eventicle-utilities";
import {maybeRenderError} from "@eventicle/eventicle-utilities/dist/logger-util";
import {dataStore} from "./";
import * as nodeCron from "node-cron"
import * as CronParser from "cron-parser"


/**
 * A Scheduled Job Runner that uses node-cron, setTimeout and runs as a single node.
 *
 * Persists and loads schedules on process stop/ start in the datastore with the types `lock-manager-timer` and `lock-manager-cron`
 */
export class LocalScheduleJobRunner implements ScheduleJobRunner {

  timers: Map<string, NodeJS.Timeout> = new Map
  crons: Map<string, nodeCron.ScheduledTask> = new Map
  events = new EventEmitter()

  constructor() {
  }

  async addScheduleTaskListener(component: string, exec: (name: string, id: string, data: any) => Promise<void>): Promise<void> {
    // store in a listener
    this.events.addListener(component, args => {
      exec(args.name, args.id, args.data).catch(reason => logger.warn(`Uncaught error in timer handler: ${component}/ ${args.name}`, {
        error: maybeRenderError(reason),
        data: args.data
      }))
    })
  }

  async addScheduledTask(component: string, name: string, id: string, config: { isCron: true; crontab: string } | { isCron: false; timeout: number }, data: any): Promise<void> {

    if (!config.isCron) {
      await this.manageSimpleTimerSchedule(component, name, id, config as any, data, true);
    } else {
      await this.manageCronTimerSchedule(component, name, id, config as any, data, true);
    }
  }

  private async manageCronTimerSchedule(component: string, name: string, id: string, config: { isCron: true; crontab: string }, data: any, createRecord: boolean) {

    if (createRecord) {
      const existing = await dataStore().findEntity("system", "lock-manager-cron", {component, name, timerId: id})

      if (existing.length > 0) {
        logger.debug("Attempted to add cron timer again", {component, name, id})

        existing[0].content = {
          component,
          name,
          timerId: id,
          config,
          data,
          nextExecutionTime: CronParser.parseExpression(config.crontab).next().getTime()
        }

        await dataStore().saveEntity("system", "lock-manager-cron", existing[0])
      } else {
        await dataStore().createEntity("system", "lock-manager-cron", {
          component,
          name,
          timerId: id,
          config,
          data,
          nextExecutionTime: CronParser.parseExpression(config.crontab).next().getTime()
        })
      }
    }

    if (this.crons.has(component + name + id)) {
      this.crons.get(component + name + id).stop()
    }
    const sched = nodeCron.schedule(config.crontab, now => {
      this.events.emit(component, {name, id, data})
    }, {
      scheduled: true
    })

    this.crons.set(component + name + id, sched)
  }

  private async manageSimpleTimerSchedule(component: string, name: string, id: string, config: { isCron: false; timeout: number }, data: any, createRecord: boolean) {

    if (this.timers.has(component + name + id)) {
      clearTimeout(this.timers.get(component + name + id))
    }

    if (createRecord) {
      await dataStore().createEntity("system", "lock-manager-timer", {
        component,
        name,
        timerId: id,
        config,
        data,
        nextExecutionTime: Date.now() + config.timeout
      })
    }

    let timer = setTimeout(() => {
      dataStore().findEntity("system", "lock-manager-timer", {component, name, timerId: id}).then(value => {
        if (value.length > 0) {
          value.forEach(value1 => {
            dataStore().deleteEntity("system", "lock-manager-timer", value1.id)
          })
        }
      })

      this.events.emit(component, {name, id, data})
    }, config.timeout)
    if (typeof timer === 'number') {
      logger.warn("Timer returned a number, not a Timer")
    } else {
      this.timers.set(component + name + id, timer)
    }
  }

  async hasSchedule(component: string, name: string, id: string): Promise<boolean> {
    let timers = await dataStore().findEntity("system", "lock-manager-cron", {component, name, timerId: id})

    return timers.length > 0
  }

  async removeSchedule(component: string, name: string, id: string): Promise<void> {
    let timers = await dataStore().findEntity("system", "lock-manager-timer", {component, name, timerId: id})

    if (timers.length > 0) {
      timers.forEach(value => {

        let name = value.content.component + value.content.name + value.content.timerId

        let timer = this.timers.get(name)
        if (timer) {
          clearTimeout(timer)
          this.timers.delete(name)
        }
        dataStore().deleteEntity("system", "lock-manager-timer", value.id)
      })
    }

    let crons = await dataStore().findEntity("system", "lock-manager-cron", {component, name, timerId: id})

    if (crons.length > 0) {
      crons.forEach(value => {

        let name = value.content.component + value.content.name + value.content.timerId

        let cron = this.crons.get(name)
        if (cron) {
          cron.stop()
          this.crons.delete(name)
        }
        dataStore().deleteEntity("system", "lock-manager-cron", value.id)
      })
    }

  }

  async startup() {
    // load all the timers
    await dataStore().findEntity("system", "lock-manager-timer", {}).then(value => {

      if (value.length > 0) {
        value.forEach(value1 => {
          this.manageSimpleTimerSchedule(value1.content.component, value1.content.name, value1.content.timerId, value1.content.config, value1.content.data, false);
        })
      }
    })

    // load all the crons
    await dataStore().findEntity("system", "lock-manager-cron", {}).then(value => {

      if (value.length > 0) {
        value.forEach(value1 => {
          this.manageCronTimerSchedule(value1.content.component, value1.content.name, value1.content.timerId, value1.content.config, value1.content.data, false);
        })
      }
    })
  }

  clearAllTimers() {
    for (let t of this.timers.values()) {
      clearTimeout(t)
    }

    this.timers.clear()

    for (let t of this.crons.values()) {
      t.stop()
    }

    this.crons.clear()

  }
}
