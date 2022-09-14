import {
  interpret,
  Interpreter,
  DefaultContext,
  EventObject,
  TypegenDisabled,
  State,
} from "xstate";
import {EventicleEvent} from "./core/event-client";
import {AggregateRoot} from "./aggregate-root";
import {logger} from "@eventicle/eventicle-utilities";

export class XStateWorkflowError extends Error {}

interface XstateStatusEvent extends EventicleEvent {
  data: any;
  type: "xstate-status";
}

export const XSTATE_STATE_EVENTICLE_EVENT = "xstate-status";

/**
 * This function removes any internal xstate-status events from the given list.
 * Use inside a {@link Command} in conjunction with an {@link XStateAggregate} to filter out any
 * XState internal status events and not emit them to the event bus.
 */
export function removeXstateEvents(events: EventicleEvent[]): EventicleEvent[] {
  return events.filter((value) => value.type !== XSTATE_STATE_EVENTICLE_EVENT);
}


/**
 * An Eventicle Aggregate that uses the XState statechart to manage its internal state.
 *
 * @see https://book.eventicle.com/eventiclejs/book/aggregate-root-xstate.html
 */
export class XStateAggregate<MACHINE> extends AggregateRoot {
  /**
   * XState State chart service for this aggregate instance
   */
  service: Interpreter<
    DefaultContext,
    any,
    EventObject,
    { value: any; context: DefaultContext },
    TypegenDisabled
  >;

  /**
   * Constructor
   *
   * @param type the name of the aggregate (e.g. "complaints")
   * @param machineFactory a function that returns a XState StateMachine (from a XState createMachine() function call)
   */
  constructor(type: string, readonly machineFactory: (_this: any) => any) {
    super({ type, storeCheckpoint: true });

    this.initStateMachineService();
  }

  raiseEvent(event: EventicleEvent): EventicleEvent {
    if (!event.causedByType) event.causedByType = "";
    if (!event.causedById) event.causedById = "";
    return super.raiseEvent(event);
  }

  protected initStateMachineService(initialState?: any) {
    const agg = this;

    // Serialises the current State of XState state machine,
    // removing the injected Eventicle aggregate's own instance object first.
    function getSerialisedXstateStateWithoutAggregate(
      state: State<
        DefaultContext,
        EventObject,
        any,
        { value: any; context: DefaultContext },
        TypegenDisabled
      >
    ) {
      state.context.aggregate = null;
      const data = JSON.stringify(state);
      state.context.aggregate = agg;
      return data;
    }

    if (initialState) {
      initialState.context.aggregate = this;
    }

    // Starts a XState state machine and registers an onTransition event handler
    // @ts-ignore
    this.service = interpret(this.machineFactory(this), { logger: logger })
      .onTransition((state, event) => {
        // If the state transition has been triggered whilst Eventicle is replaying past events into the Aggregate, do not take further action.
        if (this.replaying) return;

        // If event is the XState - generated "xstate.init", fired when it starts a new interpreted service, ignore.
        if (event.type == "xstate.init") {
          return;
        }

        // If XState state (or context has changed, or one or more new actions triggered during the transition) changed...
        if (state.changed) {
          // Serialise current XState instance State and record it in the Aggregate's event stream by emitting a "xstate-status" Eventicle Event
          const serialised = getSerialisedXstateStateWithoutAggregate(state);
          this.raiseEvent({
            type: XSTATE_STATE_EVENTICLE_EVENT,
            data: serialised,
          } as XstateStatusEvent);
        } else {
          // TODO, do we want to throw errors when the event causes no transition?
          throw new XStateWorkflowError(
            "Cannot apply event " + event.type + ": Not permitted"
          );
        }
      })
      .start(initialState);
  }

  handleEvent(event: EventicleEvent) {
    // If Eventicle is replaying Events from the Aggregate's Event Stream, and the replayed event contains previous XState State, initialise a new XState service.
    // Note this may happen several times during the event replay sequence, until the most recent xstate-status event is reached.
    if (this.replaying && event.type === XSTATE_STATE_EVENTICLE_EVENT) {
      if (this.service) {
        // If we have already created a XState service, gracefully shut it down (remove listeners etc)
        // to prevent any memory leaks before re-creating it
        this.service.stop();
      }
      this.initStateMachineService(JSON.parse(event.data));
    } else {
      // Else delegate to standard Eventicle aggregate handleEvent (which calls Aggregate reducer functions to re-build aggregate's own state)
      super.handleEvent(event);
    }
  }

  shutdown() {
    // Shutdown the XState service interpreter
    if (this.service) this.service.stop();
  }

  /**
   * Sends a XState Event into the interpreted XState machine
   * @param msg
   */
  protected xsend(msg: any) {
    if (this.service) this.service.send(msg);
  }
}

