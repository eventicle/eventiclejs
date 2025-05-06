import {EventicleEvent} from "../core/event-client";
import {Saga} from "./index";
import {handleTimerEvent, sagaHandleEvent} from "./handlers";
import {Record} from "../../index";

export interface SagaScheduler {
  sagaHandleEvent(saga: Saga<any, any>, event: EventicleEvent, instanceId: string): Promise<void>
  handleTimer(saga: Saga<any, any>, name: string, data: { instanceId: string }): Promise<void>
}

/**
 * Simple pass through scheduler
 */
export class DefaultSagaScheduler implements SagaScheduler {
  sagaHandleEvent(saga: Saga<any, any>, event: EventicleEvent, instanceId: string): Promise<void> {
    return sagaHandleEvent(saga, event, instanceId)
  }

  handleTimer(saga: Saga<any, any>, name: string, data: { instanceId: string }): Promise<void> {
    return handleTimerEvent(saga, name, data);
  }
}
