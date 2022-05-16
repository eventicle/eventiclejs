import {AggregateRoot, eventClient, EventicleEvent} from "..";

export function loadTestAggregate<T extends AggregateRoot>(type: { new (): T }, events: EventicleEvent[]): T {
  let t = new type()

  t.history = events
  for(const ev of events) {
    t.handleEvent(ev)
  }

  return t
}

export async function consumeFullEventLog(stream: string): Promise<EventicleEvent[]> {
  let events: EventicleEvent[] = []
  await new Promise(resolve => {
    eventClient().coldStream(stream, async event => {
      events.push(event)
    }, error => console.log(error), resolve as any)
  })

  return events
}

