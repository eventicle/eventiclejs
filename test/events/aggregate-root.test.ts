import uuid = require("uuid");
import {AggregateRoot, default as aggregates} from "../../src/events/aggregate-root";
import {EventicleEvent, setEventClient} from "../../src/events/core/event-client";
import {testDbPurge} from "../../src/fixture";
import {setDataStore} from "../../src/datastore";
import InMemDatastore from "../../src/datastore/inmem-data-store";
import {eventClientOnDatastore} from "../../src/events/core/eventclient-datastore";

class User extends AggregateRoot {

  private _name: string

  constructor() {
    super("user");
    this.reducers = {
      UserNameSet: (ev: EventicleEvent) => this._name = ev.data.name,
      UserCreated: (ev: EventicleEvent) => this.id = ev.data.id,
    }
  }

  static create(name:string): User {

    const user = new User()
    user.id = uuid.v4()

    user.raiseEvent({
      data: { id: uuid.v4() },
      type: "UserCreated"
    })

    user.name = name;

    return user
  }

  get name(): string {
    return this._name
  }

  set name(name: string) {
    this.raiseEvent({
      data: { name },
      type: "UserNameSet",
      id: "faked"
    })
  }
}

describe('Aggregate Root', function() {

  beforeAll(async() => {
    setDataStore(new InMemDatastore())
    setEventClient(eventClientOnDatastore())
  })

  beforeEach(async () => {
    await testDbPurge()
  })

  it('AG applies events to internal reducer', async function() {

    let user = new User()
    user.name = "David Dawson"

    let events = user.newEvents

    expect(user.name).toBe("David Dawson");
    expect(events.length).toBe(1);
    expect(events[0].type).toBe("UserNameSet");
  });

  it('can save, load a AG using repo functions and view history', async function() {

    let user = User.create("Happy Camper")
    user.name = "New Name"

    await aggregates.persist(user)

    user = await aggregates.load(User, user.id)

    user.name = "Simple Person"

    let events = user.newEvents
    let replay = await aggregates.history("user", user.id)

    expect(user.name).toBe("Simple Person");
    expect(events.length).toBe(1);
    expect(replay.length).toBe(3);
    expect(replay[0].type).toBe("UserCreated");
    expect(replay[1].type).toBe("UserNameSet");
    expect(replay[2].type).toBe("UserNameSet");
    expect(replay[2].data.name).toBe("New Name");
  });
});
