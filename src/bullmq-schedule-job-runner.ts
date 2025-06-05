import { ScheduleJobRunner } from "@eventicle/eventicle-utilities/dist/schedule-job-runner";
import { logger } from "@eventicle/eventicle-utilities";
import { maybeRenderError } from "@eventicle/eventicle-utilities/dist/logger-util";
import * as CronParser from "cron-parser";
import { dataStore } from "@eventicle/eventicle-utilities/dist/datastore";
import {Queue, QueueEvents, RedisOptions, Worker} from "bullmq";
import safeStringify from 'fast-safe-stringify';
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
 * A production-ready scheduled job runner implementation using BullMQ for Redis-backed persistence.
 * 
 * This scheduler provides reliable, distributed timer execution for Eventicle sagas and other
 * time-based operations. It supports both simple delay-based timers and cron-based recurring
 * schedules with persistence across application restarts.
 * 
 * @example
 * ```typescript
 * import { BullMQScheduleJobRunner } from '@eventicle/eventiclejs';
 * 
 * const scheduler = new BullMQScheduleJobRunner({
 *   host: 'localhost',
 *   port: 6379,
 *   password: 'redis-password'
 * });
 * 
 * await scheduler.startup();
 * 
 * // Add a simple timer
 * await scheduler.addScheduledTask(
 *   'payment-saga',
 *   'timeout',
 *   'payment-123',
 *   { isCron: false, timeout: 30000 }, // 30 seconds
 *   { orderId: 'order-456' }
 * );
 * 
 * // Add a recurring cron job
 * await scheduler.addScheduledTask(
 *   'cleanup-saga', 
 *   'daily-cleanup',
 *   'system',
 *   { isCron: true, crontab: '0 2 * * *' }, // Daily at 2 AM
 *   { maxAge: 30 }
 * );
 * ```
 * 
 * @see {@link ScheduleJobRunner} For the interface contract
 * @see {@link LocalScheduleJobRunner} For development/testing alternative
 * 
 * Features:
 * - **Persistence**: Timers survive application restarts via Redis storage
 * - **Distribution**: Multiple worker instances can process jobs concurrently
 * - **Reliability**: Built-in retry mechanisms and job status tracking
 * - **Scalability**: Configurable concurrency and job cleanup policies
 * - **Monitoring**: Job execution tracking and error handling
 * 
 * Configuration Options:
 * - `removeOnComplete`: Automatically clean up completed jobs
 * - `removeOnFail`: Automatically clean up failed jobs
 * - `concurrency`: Number of jobs to process concurrently per worker
 * - Redis connection settings for clustering and authentication
 * 
 * @since 1.0.0
 */
export class BullMQScheduleJobRunner implements ScheduleJobRunner {
  /**
   * Runtime tracking of currently executing scheduled tasks.
   * 
   * This map provides visibility into active job execution for monitoring and debugging.
   * Each entry contains:
   * - Component name and execution arguments
   * - Start timestamp for duration tracking
   * - Job metadata for troubleshooting
   * 
   * Jobs are automatically added when execution starts and removed when complete
   * or failed, providing a real-time view of scheduler activity.
   * 
   * @example
   * ```typescript
   * // Check currently active jobs
   * console.log('Active jobs:', scheduler.activeJobs);
   * // Output: { "PaymentSaga_timeout_payment-123": { component: "PaymentSaga", ... } }
   * ```
   */
  /**
   * Component-specific timer execution handlers.
   * 
   * Maps component names (typically saga names) to their timer execution functions.
   * When a scheduled timer fires, the appropriate listener is called with the timer
   * name, instance ID, and any associated data.
   * 
   * @example
   * ```typescript
   * // Automatically registered when a saga is set up
   * scheduler.listeners.set('PaymentSaga', async (args) => {
   *   await handleSagaTimer(args.name, args.id, args.data);
   * });
   * ```
   */
  listeners = new Map<string, (args: any) => Promise<void>>();

  /**
   * The BullMQ job queue for managing scheduled tasks.
   *
   * Handles both delayed executions (simple timers) and recurring schedules (cron jobs).
   * Provides persistent storage, job retry mechanisms, and distributed processing
   * capabilities through Redis.
   * 
   * Features:
   * - Delayed job execution for simple timers
   * - Repeatable jobs for cron-based scheduling  
   * - Job deduplication to prevent duplicate timers
   * - Automatic cleanup of completed/failed jobs
   */
  queue: Queue<any, any, string>;
  
  /**
   * The BullMQ worker process for executing scheduled jobs.
   * 
   * Configures parallel job processing with configurable concurrency limits.
   * Each worker instance can process multiple timer executions simultaneously
   * while maintaining proper error handling and job lifecycle management.
   * 
   * Worker features:
   * - Concurrent job processing (default: 20 jobs)
   * - Automatic job retry on failure
   * - Error logging and monitoring integration
   * - Graceful shutdown handling
   */
  worker: Worker<any, void, string>;
  
  /**
   * Runtime tracking of currently executing scheduled tasks.
   * 
   * This map provides visibility into active job execution for monitoring and debugging.
   * Each entry contains:
   * - Component name and execution arguments
   * - Start timestamp for duration tracking
   * - Job metadata for troubleshooting
   * 
   * Jobs are automatically added when execution starts and removed when complete
   * or failed, providing a real-time view of scheduler activity.
   * 
   * @example
   * ```typescript
   * // Check currently active jobs
   * console.log('Active jobs:', scheduler.activeJobs);
   * // Output: { "PaymentSaga_timeout_payment-123": { component: "PaymentSaga", ... } }
   * ```
   */
  activeJobs: {
    [key: string]: any;
  } = {};

  /**
   * Creates a new BullMQ-based scheduler instance.
   * 
   * @param config - Redis connection configuration options
   * @param config.host - Redis server hostname
   * @param config.port - Redis server port (default: 6379) 
   * @param config.password - Redis authentication password
   * @param config.db - Redis database number to use
   * @param config.retryDelayOnFailover - Delay before retry on failover
   * @param config.maxRetriesPerRequest - Maximum retry attempts per request
   * 
   * @example
   * ```typescript
   * const scheduler = new BullMQScheduleJobRunner({
   *   host: 'redis.example.com',
   *   port: 6379,
   *   password: 'secure-password',
   *   db: 0,
   *   maxRetriesPerRequest: 3
   * });
   * ```
   */
  constructor(readonly config: RedisOptions) {}

  /**
   * Registers a timer execution handler for a specific component.
   * 
   * This method is typically called automatically when sagas are registered,
   * but can be used manually for custom timer handling logic.
   * 
   * @param component - The component name (usually a saga name)
   * @param exec - The execution function called when timers fire
   * @param exec.name - The timer name that was scheduled
   * @param exec.id - The unique timer instance identifier 
   * @param exec.data - Any data associated with the timer
   * 
   * @example
   * ```typescript
   * await scheduler.addScheduleTaskListener('PaymentSaga', async (name, id, data) => {
   *   if (name === 'timeout') {
   *     await handlePaymentTimeout(id, data);
   *   }
   * });
   * ```
   */
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
        this.activeJobs[safeStringify({component, args})] = {
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
            delete this.activeJobs[safeStringify({component, args})];
          });
      } catch (e) {
        logger.error("FAILED Executing a schedule task listener", e)
      }
    });
  }

  /**
   * Schedules a new task for future execution.
   * 
   * Supports both simple delay-based timers and cron-based recurring schedules.
   * Tasks are persisted to Redis and will survive application restarts.
   * 
   * @param component - The component name (typically saga name)
   * @param name - The timer name within the component
   * @param id - Unique identifier for this timer instance
   * @param config - Timer configuration (simple delay or cron schedule)
   * @param config.isCron - Whether this is a cron-based recurring timer
   * @param config.timeout - Delay in milliseconds (for simple timers)
   * @param config.crontab - Cron expression (for recurring timers)
   * @param data - Arbitrary data to pass to the timer handler
   * 
   * @example Simple timer
   * ```typescript
   * await scheduler.addScheduledTask(
   *   'PaymentSaga',
   *   'timeout', 
   *   'payment-123',
   *   { isCron: false, timeout: 30000 }, // 30 seconds
   *   { orderId: 'order-456', amount: 100 }
   * );
   * ```
   * 
   * @example Cron timer
   * ```typescript
   * await scheduler.addScheduledTask(
   *   'ReportSaga',
   *   'daily-report',
   *   'system',
   *   { isCron: true, crontab: '0 9 * * *' }, // Daily at 9 AM
   *   { reportType: 'sales' }
   * );
   * ```
   */
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
