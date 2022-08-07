import { EventicleEvent, eventSourceName } from "./core/event-client";
import uuid = require("uuid");
import { logger } from "@eventicle/eventicle-utilities";
import aggregatesTenant from "./tenant-aggregate-root";
import {
  DataQuery,
  PagedRecords,
  Query,
  Record,
} from "@eventicle/eventicle-utilities/dist/datastore";
import { isString } from "util";

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

export interface AggregateRepository {
  load<T extends AggregateRoot>(type: { new (): T }, id: string): Promise<T>;

  /**
   * Load bulk aggregate instances, according to the given query.
   *
   * The query is only marginally useful, as the current aggregate state is not persisted.
   */
  loadBulk<T extends AggregateRoot>(
    type: { new (): T },
    filter: Query,
    page: number,
    pageSize: number
  ): Promise<{
    totalCount: number;
    pageInfo: {
      currentPage: number;
      pageSize: number;
    };
    entries: T[];
  }>;
  history<T extends AggregateRoot>(
    type: { new (): T },
    id: string
  ): Promise<EventicleEvent[]>;
  persist<T extends AggregateRoot>(aggregate: T): Promise<EventicleEvent[]>;
}

export default {
  loadBulk<T extends AggregateRoot>(
    type: { new (): T },
    filter: Query,
    page: number,
    pageSize: number
  ): Promise<{
    totalCount: number;
    pageInfo: {
      currentPage: number;
      pageSize: number;
    };
    entries: T[];
  }> {
    return aggregatesTenant.loadBulk(type, "system", filter, page, pageSize);
  },

  /**
   * Replay and build an aggregate root into its current state.
   * @param type
   * @param id
   */
  load: async <T extends AggregateRoot>(
    type: { new (): T },
    id: string
  ): Promise<T> => {
    let t = new type();
    return aggregatesTenant.load(t, "system", id);
  },

  /**
   * Obtain the full stream of events that make up the history of an aggregate root.
   * @param type
   * @param id
   */
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
