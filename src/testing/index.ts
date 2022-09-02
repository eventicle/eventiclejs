import { AggregateRoot, eventClient, EventicleEvent } from "..";

/**
 * Create a new instance of the given aggregate and populate it from the list of events
 * @param type The AggregateRoot type to create
 * @param events the event list to populate the aggregate from.
 */
export function loadTestAggregate<T extends AggregateRoot>(
  type: { new (): T },
  events: EventicleEvent[]
): T {
  let t = new type();

  t.history = events;
  for (const ev of events) {
    t.handleEvent(ev);
  }

  return t;
}

/**
 * Will cold replay the entire event stream into a list.
 *
 * Mostly useful for testing, use against long running event streams/ Kafka will blow your local memory!
 *
 * @see EventClient#coldStream
 *
 * @param stream The event stream to cold replay
 */
export async function consumeFullEventLog(
  stream: string
): Promise<EventicleEvent[]> {
  let events: EventicleEvent[] = [];
  await new Promise((resolve) => {
    eventClient().coldStream(
      stream,
      async (event) => {
        events.push(event);
      },
      (error) => console.log(error),
      resolve as any
    );
  });

  return events;
}
