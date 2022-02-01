import {ScheduleJobRunner} from "@eventicle/eventicle-utilities/dist/schedule-job-runner";
import {LocalScheduleJobRunner} from "./local-schedule-job-runner";

let SCHEDULER: ScheduleJobRunner = new LocalScheduleJobRunner()

export function setScheduler(scheduler: ScheduleJobRunner) {
  SCHEDULER = scheduler
}

export function scheduler(): ScheduleJobRunner {
  return SCHEDULER
}
