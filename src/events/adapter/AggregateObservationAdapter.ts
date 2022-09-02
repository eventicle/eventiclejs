import * as uuid from "uuid";
import { EventAdapter } from "./index";
import { AggregateRoot, aggregates, EventicleEvent } from "../..";
import { logger } from "@eventicle/eventicle-utilities";
import { EventEmitter } from "events";
class InternalEv extends EventEmitter {}

let emitter = new InternalEv();

/**
 * Reads streams and allows short lived observers to be notified if a particular AggregateRoot instance has been modified.
 * This is picked out based on the `domainId` of the event.
 *
 * This allows a synchronous API to block and wait for asynchronous changes to finish occurring before continuing processing
 *
 * @example
 * For example, given a `User` {@link AggregateRoot}, you can wait for a Saga (or other operational component)
 * to approve a user account, by blocking until the given `User` has raised the `user.approved` event.
 *
 * ```
 * export class UserAggregate extends AggregateRoot {
 *   approved: boolean = false
 *
 *   constructor() {
 *      super("User")
 *
 *      this.reducers = []
 *      // persist the approval in the current aggregate state.
 *      // This avoids any potential race conditions between performing the action that requires
 *      // approval and the observer starting to monitor. See below.
 *      this.reducers["user.approved"] = (ev) => {
 *        this.approved = true
 *      }
 *   }
 *
 *   approve() {
 *     this.raiseEvent({
 *       type: "user.approved",
 *       data: {}
 *       // other event fields
 *     })
 *   }
 * }
 * ``
 * First register the observer. This will open a new event subscription, with a dynamically generated consumer group.
 * All events on the topic will be received by this instances, so be mindful of doing this on topics with large volumes
 * of data.
 *
 * ```
 *   await registerAdapter(createAggregateObservationAdapter([AnAggregate]));
 * ```
 *
 * In your synchronous API (eg, HTTP/ REST, GQL).
 *
 * ```
 * // The userId is the domainId of the UserAggregate instance we want to observe
 * export doActionThatRequiresApproval(userId: string) {
 *
 *   // perform some action that triggers async workflows
 *
 *   // now wait for the User to be approved
 *   const user = await aggregateObserver(
 *                             UserAggregate,
 *                             userId,  // the UserAggregate domainId
 *                             10000,   // max time to wait for the User instance to come into the required state
 *                             (ar, ev) => {
 *           // this is called once straight away with just the current state of the User aggregate (ev is null)
 *           // then, every time an event is observed for the UserAggregate with the domainId == userId
 *           // check the current state of the aggregate is what you want to see, or the event being received
 *           // is the one you are waiting for.  Or, ideally, both of those things
 *           // doing both will avoid any race conditions.
 *      return ev && ev.type == "user.approved" || ar.approved
 *   });
 *
 *   // user is now approved, or an Error has been thrown
 *   // perform any ops on the user as required.
 *
 * }
 * ```
 */
class AggregateObservationAdapter implements EventAdapter {
  readonly name = "aggregate-observer";

  constructor(readonly streamsToSubscribe: string[]) {
    logger.debug("Aggregate Observer Started for streams ", streamsToSubscribe);
  }

  readonly consumerGroup = "aggregate-observation-" + uuid.v4();

  async handleEvent(event: EventicleEvent): Promise<void> {
    logger.trace("AR Observer has an event", event);
    emitter.emit("event", event);
  }
}

let VIEW: AggregateObservationAdapter;

/**
 * Create a new EventAdapter with a dynamic Consumer group id that will subscribe to the topics for the
 * given AggregateRoots
 *
 * @param aggregates the list of aggregate roots to observe. Their topic names will be extracted.
 */
export function createAggregateObservationAdapter<AR extends AggregateRoot>(
  aggregates: { new (): AR }[]
) {
  VIEW = new AggregateObservationAdapter(
    aggregates.map((value) => new value().type)
  );
  return VIEW;
}
export const aggregateObservationAdapter = () => VIEW;

/**
 * Observe an aggregate root instance.
 *
 * The handler will be executed :-
 * * once with the current state of the aggregate root instance, the event property will be empty
 * * once for every subsequent event that modifies the aggregate root instance
 *
 * The ar property will contain the state of the AR _after_ the event has been applied to it. The ar has been persisted before the handler observes it.
 *
 * This observer operates on a shared eventclient consumer on the underlying aggregate stream, and so does not block
 * event replay per observer.  The exec is not async for this reason and should not perform any expensive processing or it will
 * cause a slowdown in throughput across all other observers.
 *
 * It is possible that events may be presented in parallel to the exec function. If you expect that a single AR instance mey be in a data race,
 * do not use this shared observer view, and build a dedicated event adapter instead.
 *
 * @see AggregateObservationAdapter
 */
export async function aggregateObserver<AR extends AggregateRoot>(
  aggregateType: { new (...params): AR },
  id: string,
  timeout: number,
  exec: (ar: AR, event?: EventicleEvent) => boolean
): Promise<AR> {
  return aggregateObserverFactory(
    aggregateType,
    id,
    timeout,
    () => aggregates.load(aggregateType, id),
    exec
  );
}

/**
 * Permit override of how to load the aggregate if you have an alternate aggregates subsystem
 */
export async function aggregateObserverFactory<AR extends AggregateRoot>(
  aggregateType: { new (...params): AR },
  id: string,
  timeout: number,
  aggregateLoader: () => Promise<AR>,
  exec: (ar: AR, event?: EventicleEvent) => boolean
): Promise<AR> {
  let instance = await aggregateLoader();

  if (exec(instance, null)) {
    return instance;
  }

  return new Promise((resolve, reject) => {
    let timeHandler = setTimeout(() => {
      reject(
        new Error(
          "aggregateObserve timeout occurred " +
            JSON.stringify({ type: new aggregateType().type, id })
        )
      );
    }, timeout);

    let listener = async (ev: EventicleEvent) => {
      if (ev.domainId == id) {
        let instance = await aggregateLoader();
        try {
          if (exec(instance, ev)) {
            clearTimeout(timeHandler);
            emitter.removeListener("event", listener);
            resolve(instance);
          }
        } catch (e) {
          clearTimeout(timeHandler);
          emitter.removeListener("event", listener);
          reject(e);
        }
      }
    };

    emitter.addListener("event", listener);
  });
}
