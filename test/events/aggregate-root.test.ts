import uuid = require("uuid");
import {
  AggregateRoot,
  default as aggregates,
} from "../../src/events/aggregate-root";
import {
  EventicleEvent,
  setEventClient,
} from "../../src/events/core/event-client";
import { testDbPurge } from "../../src/fixture";
import { setDataStore, dataStore } from "../../src";
import InMemDatastore from "../../src/datastore/inmem-data-store";
import { eventClientOnDatastore } from "../../src/events/core/eventclient-datastore";

class User extends AggregateRoot {
  private _name: string;
  happy: string;

  constructor() {
    super({ type: "user", storeCheckpoint: true });
    this.reducers = {
      UserNameSet: (ev: EventicleEvent) => {
        this._name = ev.data.name;
        this.happy = "yes";
      },
      UserCreated: (ev: EventicleEvent) => (this.id = ev.data.id),
    };
  }

  currentCheckpoint() {
    return {
      name: this.name,
    };
  }

  static create(name: string): User {
    const user = new User();
    user.id = uuid.v4();

    user.raiseEvent({
      data: { id: uuid.v4() },
      type: "UserCreated",
    });

    user.name = name;

    return user;
  }

  get name(): string {
    return this._name;
  }

  set name(name: string) {
    this.raiseEvent({
      data: { name },
      type: "UserNameSet",
      id: "faked",
    });
  }
}

describe("Aggregate Root", function () {
  beforeAll(async () => {
    setDataStore(new InMemDatastore());
    setEventClient(eventClientOnDatastore());
  });

  beforeEach(async () => {
    await testDbPurge();
  });

  it("AG applies events to internal reducer", async function () {
    let user = new User();
    user.name = "David Dawson";

    let events = user.newEvents;

    expect(user.name).toBe("David Dawson");
    expect(events.length).toBe(1);
    expect(events[0].type).toBe("UserNameSet");
  });

  it("can save, load a AG using repo functions and view history", async function () {
    let user = User.create("Happy Camper");
    user.name = "New Name";

    await aggregates.persist(user);

    user = await aggregates.load(User, user.id);

    user.name = "Simple Person";

    let events = user.newEvents;
    let replay = await aggregates.history(User, user.id);

    expect(user.name).toBe("Simple Person");
    expect(events.length).toBe(1);
    expect(replay.length).toBe(3);
    expect(replay[0].type).toBe("UserCreated");
    expect(replay[1].type).toBe("UserNameSet");
    expect(replay[2].type).toBe("UserNameSet");
    expect(replay[2].data.name).toBe("New Name");
  });

  it("if storeCheckpoint set, will persist the current state in the datastore", async function () {
    let user = User.create("Happy Camper");
    user.name = "New Name";

    await aggregates.persist(user);

    user = await aggregates.load(User, user.id);
    const userRecord = await dataStore().findEntity(
      "system",
      "aggregate-events-user",
      {},
      {}
    );

    const aggByQuery = await aggregates.loadBulk({
        type: User,
        filter: {name: "New Name"},
        page: 1,
        pageSize: 10,
      }
    );

    expect(user.name).toBe("New Name");
    expect(userRecord.length).toBe(1);
    expect(userRecord[0].content.name).toBe("New Name");
    expect(aggByQuery.totalCount).toBe(1);
    expect(aggByQuery.entries[0].name).toBe("New Name");
  });
});
