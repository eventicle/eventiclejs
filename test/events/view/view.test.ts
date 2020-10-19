import {EventView, registerView} from "../../../src/events/view";
import {eventClient, EventicleEvent, setEventClient} from "../../../src/events/core/event-client";
import {setDataStore} from "../../../src/datastore";
import InMemDatastore from "../../../src/datastore/inmem-data-store";
import {eventClientOnDatastore} from "../../../src/events/core/eventclient-datastore";

describe('View dispatch', function() {

  it('View can be constructed from an event stream', async function() {
    setDataStore(new InMemDatastore())
    setEventClient(eventClientOnDatastore())

    let myevents = [] as EventicleEvent[]

    await registerView({
      handleEvent: event => {
        myevents.push(event)
      },
      streamsToSubscribe: ["mystream"]
    } as EventView)

    await eventClient().emit([{
      data: { message: "ends"},
      type: "fake-event",
      id: "epic"
    }], "mystream")

    expect(myevents.length).toBe(1);
    expect(myevents[0].id).toBe("epic");
  });
});


