import {EventicleEvent, eventSourceName} from "./core/event-client";
import aggregatesTenant, {BulkResponse} from "./tenant-aggregate-root";
import {DataSorting, Query} from "@eventicle/eventicle-utilities/dist/datastore";
import uuid = require("uuid");

export interface AggregateConfig {
  type: string;
  storeCheckpoint: boolean;
}

export abstract class AggregateRoot {
  history: EventicleEvent[] = [];
  newEvents: EventicleEvent[] = [];
  id: string;
  reducers: any;
  replaying: boolean;
  readonly config: AggregateConfig;

  constructor(type: string | AggregateConfig) {
    this.replaying = false;
    if (typeof type === "string") {
      this.config = {
        type: type,
        storeCheckpoint: false,
      };
    } else {
      this.config = type;
    }
  }

  currentCheckpoint(): object {
    throw new Error(`
    Checkpoint is not implemented, but has been configured.
    Implement the currentCheckpoint() function on your aggregate.
    `);
  }

  raiseEvent(event: EventicleEvent) {
    event.id = uuid.v4();
    if (!event.createdAt) {
      event.createdAt = new Date().getTime();
    }
    if (!event.source) {
      event.source = eventSourceName();
    }
    if (!event.domainId) {
      event.domainId = this.id;
    }
    this.handleEvent(event);
    this.newEvents.push(event);
    return event;
  }

  handleEvent(event: EventicleEvent) {
    let func = this.reducers[event.type];
    if (func) func.call(this, event);
  }

  get type(): string {
    return this.config.type;
  }
}

type BulkQuery<T> = {
  type: { new (): T },
  filter?: Query
  sort?: DataSorting,
  page?: number
  pageSize?: number
}

type LoadBulk = {
  <T extends AggregateRoot>(config: BulkQuery<T>): Promise<BulkResponse<T>>
  <T extends AggregateRoot>(type: { new (type?: string | AggregateConfig): T },
                            filter?: Query,
                            page?: number,
                            pageSize?: number): Promise<BulkResponse<T>>
}

export interface AggregateRepository {
  /**
   * Replay and build an aggregate root into its current state.
   * @param type
   * @param id
   */
  load<T extends AggregateRoot>(type: { new (): T }, id: string): Promise<T>;
  /**
   * Load bulk aggregate instances, according to the given query.
   *
   * The query is only marginally useful, as the current aggregate state is not persisted.
   *
   * Overloaded for backwards compatibility
   */
  loadBulk: LoadBulk
  /**
   * Obtain the full stream of events that make up the history of an aggregate root.
   * @param type
   * @param id
   */
  history<T extends AggregateRoot>(
    type: { new (): T },
    id: string
  ): Promise<EventicleEvent[]>;
  /**
   * Persist an aggregate to the datastore.
   * @param aggregate
   */
  persist<T extends AggregateRoot>(aggregate: T): Promise<EventicleEvent[]>;
}

export default {
  loadBulk: async (...args) => {
    let type
    let filter: Query = {}
    let sort: DataSorting
    let page, pageSize
    if(args.length > 1) {
      type = args[0]
      filter = args[1]
      page = args[2]
      pageSize = args[3]
      sort = {}
    } else {
      const conf = args[0]
      type = conf.type
      filter = conf.filter ?? {}
      page = conf.page ?? 0
      pageSize = conf.pageSize ?? undefined
      sort = conf.sort ?? {}
    }

    return aggregatesTenant.loadBulk({type, tenant: "system", filter, page, pageSize, sort});
  },

  load: async <T extends AggregateRoot>(
    type: { new (): T },
    id: string
  ): Promise<T> => {
    let t = new type();
    return aggregatesTenant.load(t, "system", id);
  },

  history: async <T extends AggregateRoot>(
    type: { new (): T },
    id: string
  ): Promise<EventicleEvent[]> => {
    let t = new type();
    return aggregatesTenant.history(t.type, "system", id);
  },

  persist: async <T extends AggregateRoot>(
    aggregate: T
  ): Promise<EventicleEvent[]> => {
    return aggregatesTenant.persist(aggregate, "system");
  },
} as AggregateRepository;
