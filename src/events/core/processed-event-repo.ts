import {EncodedEvent, EventicleEvent} from "./event-client";


/**
 * Repo to main the state of correct processing of events in various event driven components.
 * Sagas, views, adapters.
 */
export interface ProcessedEventRepo {
  /**
   * The event provided has been successfully processed by this component.
   *
   * This will persist the event ID as being processed
   */
  markEventProcessed(component: string, event: EventicleEvent | EncodedEvent): Promise<boolean>

  /**
   * Has the given event ID been processed by the event driven component.
   */
  isEventProcessed(component: string, event: EventicleEvent | EncodedEvent): Promise<boolean>

  /**
   * Clean up the storage
   * @param date
   */
  removeRowsBefore(date: Date): Promise<number>;
}
