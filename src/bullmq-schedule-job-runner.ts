import { ScheduleJobRunner } from "@eventicle/eventicle-utilities/dist/schedule-job-runner";
import { logger } from "@eventicle/eventicle-utilities";
import { maybeRenderError } from "@eventicle/eventicle-utilities/dist/logger-util";
import * as CronParser from "cron-parser";
import { dataStore } from "@eventicle/eventicle-utilities/dist/datastore";
import {Queue, QueueEvents, RedisOptions, Worker} from "bullmq";
import stableStringify from "json-stable-stringify";
import {eventSourceName} from "./events/core/event-client";
import * as uuid from "uuid";
import { als } from "asynchronous-local-storage";

const deepEqual = require("deep-equal");

function jobId(component: string, name: string, id: string) {
  return `SCHEDULER_${component}__${name}__${id}`;
}

const TIMER = "lock-manager-timer";
const CRON = "lock-manager-cron";

/**
 * A Scheduled Job Runner that uses BullMQ
 *
 * Compatible with LocalScheduleRunner data types (ie, lock-manager-cron)
 */
export class BullMQScheduleJobRunner implements ScheduleJobRunner {
  /**
   * Listeners are functions that are called on a per component basis
   * a component would be, in the case of sagas, the Saga name. So, there is a single
   * timer listener function for the Saga, which takes all timed executions and dispatches them
   * internally inside the saga
   */
  listeners = new Map<string, (args: any) => Promise<void>>();

  /**
   * The BullMQ execution queue.
   *
   * This supports delayed (eg, simple timers) and cron executions (repeatables, in BullMQ terms)
   */
  queue: Queue<any, any, string>;
  /**
   * The BullMQ job executor. There will be one per process, that will run multiple timed executions in
   * parallel.
   */
  worker: Worker<any, void, string>;
  /**
   * Local metadata about what this scheduler is executing at the moment.
   */
  activeJobs: {
    [key: string]: any;
  } = {};

  constructor(readonly config: RedisOptions) {}

  async addScheduleTaskListener(
    component: string,
    exec: (name: string, id: string, data: any) => Promise<void>
  ): Promise<void> {
    this.listeners.set(component, async (args) => {
      try {
        logger.debug("Executing a schedule task listener", {
          component,
          args,
        });
        this.activeJobs[stableStringify({component, args})] = {
          component,
          args,
          startedAt: new Date().toISOString(),
        };
        await exec(args.name, args.id, args.data)
          .catch((reason) =>
            logger.error(`Uncaught error in timer handler: ${component}/ ${args.name}`, {
              error: maybeRenderError(reason),
              data: args.data,
            })
          )
          .finally(() => {
            delete this.activeJobs[stableStringify({component, args})];
          });
      } catch (e) {
        logger.error("FAILED Executing a schedule task listener", e)
      }
    });
  }

  async addScheduledTask(
    component: string,
    name: string,
    id: string,
    config: { isCron: true; crontab: string } | { isCron: false; timeout: number },
    data: any
  ): Promise<void> {
    logger.debug("Adding a scheduled task in BullMQ", {
      component,
      name,
      id,
      config,
      data,
    });

    if (!config.isCron) {
      await this.manageSimpleTimerSchedule(
        component,
        name,
        id,
        config as any,
        data,
        true
      );
    } else {
      await this.manageCronTimerSchedule(component, name, id, config as any, data, true);
    }
  }

  private async manageCronTimerSchedule(
    component: string,
    name: string,
    id: string,
    config: { isCron: true; crontab: string },
    data: any,
    createRecord: boolean
  ) {
    if (createRecord) {
      const existing = await dataStore().findEntity("system", CRON, {
        component,
        name,
        timerId: id,
      });

      if (existing.length > 0) {
        logger.debug("Attempted to add cron timer again", { component, name, id });

        existing[0].content = {
          component,
          name,
          timerId: id,
          config,
          data,
          nextExecutionTime: CronParser.parseExpression(config.crontab).next().getTime(),
        };

        await dataStore().saveEntity("system", CRON, existing[0]);
      } else {
        await dataStore().createEntity("system", CRON, {
          component,
          name,
          timerId: id,
          config,
          data,
          nextExecutionTime: CronParser.parseExpression(config.crontab).next().getTime(),
        });
      }
    }
    const job = jobId(component, name, id);

    if (this.queue) {
      const existing = await this.queue.getJob(jobId(component, name, id));
      if (
        existing &&
        deepEqual(existing.data, { name, id, data, requestedCron: config.crontab })
      ) {
        // do nothing, is fine
        return;
      }

      if (existing) {
        await this.queue.removeRepeatable(name, {
          jobId: job,
          pattern: config.crontab,
        });
      }

      await this.queue.add(
        component,
        { name, id, data, requestedCron: config.crontab },
        {
          repeat: {
            jobId: job,
            pattern: config.crontab,
          },
        }
      );
    }
  }

  private async manageSimpleTimerSchedule(
    component: string,
    name: string,
    id: string,
    config: { isCron: false; timeout: number },
    data: any,
    createRecord: boolean
  ) {
    if (createRecord) {
      await dataStore().createEntity("system", TIMER, {
        component,
        name,
        timerId: id,
        config,
        data,
        nextExecutionTime: Date.now() + config.timeout,
      });
    }

    const job = jobId(component, name, id);

    if (this.queue) {
      const exec = async () => {
        // force removal of old job, if already exists.
        const foundJobs = (await this.queue.getJobs()).filter(val => {
          return val?.opts?.jobId == job
        })
        if (foundJobs && foundJobs.length > 0) {
          logger.debug(`Removed old jobs to make way for new ones ${foundJobs.map(value => value.id)}`)
        }

        const addedJob = await this.queue.add(
          component,
          {name, id: uuid.v4(), data},
          {
            delay: config.timeout,
            jobId: job,
            removeOnComplete: true,
            removeOnFail: true
          }
        );
        logger.debug("Job added to queue ", addedJob)
      }
      if (als.get("in-context")) {
        (als.get("ops") as any[]).push(exec)
      } else {
        exec().catch(reason => logger.warn("Failed to manage timers in Saga instance " + reason.message, reason))
      }
    }
  }

  async hasSchedule(component: string, name: string, id: string): Promise<boolean> {
    const timers = await dataStore().findEntity("system", CRON, {
      component,
      name,
      timerId: id,
    });

    return timers.length > 0;
  }

  async hasTimer(component: string, name: string, id: string): Promise<boolean> {
    const timers = await dataStore().findEntity("system", TIMER, {
      component,
      name,
      timerId: id,
    });

    return timers.length > 0;
  }

  async removeSchedule(component: string, name: string, id: string): Promise<void> {
    logger.debug("Removing timer schedule ", { component, name, id });
    const timers = await dataStore().findEntity("system", TIMER, {
      component,
      name,
      timerId: id,
    });

    if (timers.length > 0) {
      for (let value of timers) {
        logger.debug("Removing simple timer ", value);
        const bullMqRemoval = async () => {
          const job = await this.queue.getJob(jobId(component, value.content.name, id))
          await job?.remove()
        }
        if (als.get("in-context")) {
          (als.get("ops") as any[]).push(bullMqRemoval)
        } else {
          await bullMqRemoval()
        }
        await dataStore().deleteEntity("system", TIMER, value.id);
      }
    }

    const crons = await dataStore().findEntity("system", CRON, {
      component,
      name,
      timerId: id,
    });

    if (crons.length > 0) {
      crons.forEach((value) => {
        logger.debug("Removing cron timer ", value);
        const name = value.content.component + value.content.name;

        const job = jobId(component, name, id);

        if (this.queue) {
          this.queue.removeRepeatable(name, {
            jobId: job,
            pattern: value.content.config.crontab,
          });
        }
        dataStore().deleteEntity("system", CRON, value.id);
      });
    }
  }

  async startup() {
    logger.info("Booting up BULL MQ Schedule Job Runner");
    this.queue = new Queue(eventSourceName() + "SchedulerJobRunner", {
      connection: this.config,
      defaultJobOptions: {
        removeOnComplete: true,
        removeOnFail: true
      },
    });

    const listener = new QueueEvents("Listener", { connection: this.config })
    listener.on("duplicated", (args, id) => {
      logger.debug("Duplicate job added, and will be ignored", {
        args, id
      })
    })

    this.worker = new Worker(
      eventSourceName() + "SchedulerJobRunner",
      async (job) => {
        logger.debug("Scheduled Job triggered ", job);
        als.runWith(async () => {
          // run in own ALS context.
          als.set("in-context", true);
          als.set("ops", []);
          const exec = this.listeners.get(job.name);
          if (!exec) {
            logger.warn("No handler for job type " + job.name);
            return;
          }
          await exec({name: job.data.name, id: job.data.id, data: job.data.data});
        })
      },
      {
        connection: this.config,
        concurrency: 20,
      }
    );

    // load all the timers
    await dataStore()
      .findEntity("system", TIMER, {})
      .then((value) => {
        if (value.length > 0) {
          value.forEach((value1) => {

            this.manageSimpleTimerSchedule(
              value1.content.component,
              value1.content.name,
              value1.content.timerId,
              value1.content.config,
              value1.content.data,
              false
            );
          });
        }
      });

    // load all the crons
    await dataStore()
      .findEntity("system", CRON, {})
      .then((value) => {
        if (value.length > 0) {
          value.forEach((value1) => {
            this.manageCronTimerSchedule(
              value1.content.component,
              value1.content.name,
              value1.content.timerId,
              value1.content.config,
              value1.content.data,
              false
            );
          });
        }
      });
  }

  clearAllTimers(): Promise<any> {
    return Promise.all([
      this.queue.drain(true),
      this.queue.clean(0, 100000, "active"),
      this.queue.clean(0, 100000, "completed"),
      this.queue.clean(0, 100000, "delayed"),
      this.queue.clean(0, 100000, "failed"),
      this.queue.clean(0, 100000, "wait"),
      this.queue.clean(0, 100000, "paused"),
    ]);
  }
}
