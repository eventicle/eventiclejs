import {
  setEventSourceName,
  eventClientOnDatastore,
  InMemoryDatastore,
  setDataStore,
  setEventClient, eventClient, EventicleEvent, EventView, dataStore, registerView
} from '@eventicle/eventiclejs';
import * as uuid from "uuid";
import {pause} from "@eventicle/eventiclejs/dist/util";

class UserLoginView implements EventView {

  consumerGroup: string = "user_count_view" + uuid.v4()  // <1>
  streamsToSubscribe: string[] = ["app.users"]

  userRegistrations:number = 0; // <2>

  async handleEvent(event: EventicleEvent): Promise<void> {
    switch(event.type) {
      case "user.register":
        this.userRegistrations++;  // <3>
        break;
    }
  }
}

async function execute() {
  setEventSourceName('my-cool-service');
  setDataStore(new InMemoryDatastore());
  setEventClient(eventClientOnDatastore());

  await eventClient().emit([
    {
      type: "user.created",
      data: {
        userName: "Personal Person"
      }
    }
  ], "app.users")

  let view = new UserLoginView()
  await registerView(view)  // <5>

  await pause(2000) // let the view come up to date

  console.log(await view.userRegistrations)   // <4>


}

execute()
