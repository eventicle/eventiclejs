import {eventClient, EventicleEvent, setEventClient} from "../../../src/events/core/event-client";
import {setDataStore} from "../../../src/datastore";
import InMemDatastore from "../../../src/datastore/inmem-data-store";
import {eventClientOnDatastore} from "../../../src/events/core/eventclient-datastore";
import {testDbPurge} from "../../../src/fixture";
import {AggregateRoot, aggregates, eventStreamObserver, registerAdapter} from "../../../src";
import * as uuid from "uuid"
import {EventStreamObservationAdapter} from "../../../src/events/adapter/EventStreamObservationAdapter";

describe('Aggregate Observer', function() {

  beforeEach(async() => {
    setDataStore(new InMemDatastore());
    await testDbPurge();
    setEventClient(eventClientOnDatastore());
    (eventClient() as any).clear();
  })

  it('observer reads hot events', async function() {
    setDataStore(new InMemDatastore())
    setEventClient(eventClientOnDatastore())
    await registerAdapter(new EventStreamObservationAdapter([
      "user"
    ]))

    // simulate command execution
    let user = User.create("Fakerson")
    let events = await aggregates.persist(user)

    setTimeout(() => {
      eventClient().emit(events, "user")
    }, 1000)

    const mockESOCallback = jest.fn(() => true)

    let instance = await eventStreamObserver("User", user.id, 2000, mockESOCallback)

    expect(instance).toBeDefined();
    expect(instance.domainId).toBe(user.id);
    expect(mockESOCallback).toHaveBeenCalled()
  });

  it('observer throws error on timeout', async function() {
    setDataStore(new InMemDatastore())
    setEventClient(eventClientOnDatastore())
    await registerAdapter(new EventStreamObservationAdapter([
      "user"
    ]))

    let fail: any;
    try {
      await eventStreamObserver("User", "fakeId", 100, () => true)
    } catch (e) {
      fail = e
    }

    expect(fail).toBeDefined();
  });
});

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
