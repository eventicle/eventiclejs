import {eventClient, EventicleEvent} from "..";


export async function consumeFullEventLog(stream: string): Promise<EventicleEvent[]> {
  let events: EventicleEvent[] = []
  await new Promise(resolve => {
    eventClient().coldStream(stream, async event => {
      events.push(event)
    }, error => console.log(error), resolve as any)
  })

  return events
}

