import {
  setEventSourceName,
  eventClientOnDatastore,
  InMemoryDatastore,
  setDataStore,
  setEventClient, eventClient, EventicleEvent, EventView, dataStore, registerView
} from '@eventicle/eventiclejs';

class UserLoginView implements EventView {

  consumerGroup: string = "user_login_view"  // <1>
  streamsToSubscribe: string[] = ["app.users"]    // <2>

  /**
   * View reducer function.
   */
  async handleEvent(event: EventicleEvent): Promise<void> {

    switch(event.type) {  // <3>
      case "user.register":
        // Insert into some data store.  Here using the built in datastore abstraction so we can do InMem during testing
        await dataStore().createEntity("example", "user-view-record", {
          username: event.data.username,
          password: event.data.password
        })

        break;

      default:
        console.log("UserLoginView ignoring event type " + event.type)
    }
  }

  /*
   * An operation on the view. These will most commonly be API driven, and can any for of query.
   * They should only read the data, not attempt to mutate it
   */
  async checkPassword(username: string, password: string) {  // <4>
    // do a hash/ password comparison
  }

  async allUsers() {  // <5>
    (await dataStore().findEntity("example", "user-view-record", {})).map(value => {
      return value.content
    })
  }
}

async function execute() {
  setEventSourceName('my-cool-service');
  setDataStore(new InMemoryDatastore());
  setEventClient(eventClientOnDatastore());

  let view = new UserLoginView()
  await registerView(view) // <6>

  await eventClient().emit([
    {
      type: "user.created",
      data: {
        userName: "Personal Person"
      }
    }
  ], "app.users")

  console.log(await view.allUsers())   // <7>


}

execute()
