// tag::deps[]
import {
  setEventSourceName,
  eventClientOnDatastore,
  InMemoryDatastore,
  setDataStore,
  setEventClient, eventClient, EventicleEvent
} from '@eventicle/eventiclejs';


// end::deps[]

async function execute() {
// the "source" of the events created by this application, most commonly, the application name.
  // tag::config[]
  setEventSourceName('my-cool-service');

// in service data storage abstraction. Used by the internals of eventicle, can also be used in app code
  setDataStore(new InMemoryDatastore());

// The connection to the event transport, this is in memory and stores events and state in the current datastore
  setEventClient(eventClientOnDatastore());
// end::config[]

// tag::observe[]
  eventClient().hotStream("app.streamname", "my-consumer", async (event: EventicleEvent) => {
    console.log("An event of type " + event.type)
    console.log(event)
  }, error => {
    console.log("An error occurred");
    console.log(error)
  })
// end::observe[]

// tag::emit[]
  // raw event client. Used mainly for special case external integration
  await eventClient().emit([
    {
      type: "user.created",
      data: { // <1>
        userName: "Personal Person"
      }
    }
  ], "app.streamname")
// end::emit[]

  // tag::replay[]
  await eventClient().coldStream("app.streamname", async (event: EventicleEvent) => {
    console.log("An event of type " + event.type)
    console.log(event)
  }, error => {
    console.log("An error occurred");
    console.log(error)
  }, () => console.log("Event stream has fully replayed"))
  // end::replay[]
}
