import {EventView, registerView} from "../../../src/events/view";
import {eventClient, EventicleEvent, setEventClient} from "../../../src/events/core/event-client";
import {setDataStore} from "../../../src/datastore";
import InMemDatastore from "../../../src/datastore/inmem-data-store";
import {eventClientOnDatastore} from "../../../src/events/core/eventclient-datastore";
import {testDbPurge} from "../../../src/fixture";
import {aggregateObserver, AggregateRoot, aggregates, createAggregateObservationAdapter} from "../../../src";
import * as uuid from "uuid"
import {pause} from "../../../src/util";
import logger from "../../../src/logger";

describe('Aggregate Observer', function() {

  beforeEach(async() => {
    setDataStore(new InMemDatastore());
    await testDbPurge();
    setEventClient(eventClientOnDatastore());
    (eventClient() as any).clear();
  })

  it('observer receives initial AR state on first observe', async function() {
    setDataStore(new InMemDatastore())
    setEventClient(eventClientOnDatastore())
    await registerView(createAggregateObservationAdapter([
      User
    ]))

    // simulate command execution
    let user = User.create("Fakeson")
    let events = await aggregates.persist(user)
    await eventClient().emit(events, "user")

    let instance = await aggregateObserver(User, user.id, 5000, (ar, event) => {
      logger.info("Got a user?", {ar, event})
      return true
    })

    expect(instance).toBeDefined();
    expect(instance.id).toBe(user.id);
  });

  it('observer throws error on timeout', async function() {
    setDataStore(new InMemDatastore())
    setEventClient(eventClientOnDatastore())
    await registerView(createAggregateObservationAdapter([
      User
    ]))

    // simulate command execution
    let user = User.create("Cool Person")
    let events = await aggregates.persist(user)
    await eventClient().emit(events, "user")

    let ret = await new Promise((resolve, reject) => {
      aggregateObserver(User, user.id, 100, (ar, event) => {
        logger.info("Got a user?", {ar, event})
        return false
      }).then(reject)
        .catch(resolve)
    })

    console.log(ret)

    expect(ret).toBeDefined();
    // expect(instance.id).toBe(user.id);
  });

  it('observer is shown an AR + event for the given AR type/id', async function() {
    setDataStore(new InMemDatastore())
    setEventClient(eventClientOnDatastore())
    await registerView(createAggregateObservationAdapter([
      User
    ]))

    // simulate command execution
    let user = User.create("Cool Person")
    let events = await aggregates.persist(user)
    await eventClient().emit(events, "user")

    let ret

    aggregateObserver(User, user.id, 1000, (ar, event) => {
      logger.info("User change observed", {ar, event})
      if (!event) return false
      return event.type == "UserNameSet"
    }).then(value => {
      ret = value
    })

    await pause(100)

    // simulate command execution
    user = await aggregates.load(User, user.id)
    user.name = "Coolness"
    events = await aggregates.persist(user)
    await eventClient().emit(events, "user")

    await pause(500)

    expect(ret).toBeDefined();
    // expect(instance.id).toBe(user.id);
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
