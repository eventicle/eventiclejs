import {EventicleEvent, eventSourceName} from "./core/event-client";
import aggregatesTenant, {BulkResponse} from "./tenant-aggregate-root";
import {DataSorting, Query} from "@eventicle/eventicle-utilities/dist/datastore";
import uuid = require("uuid");

/**
 * Configuration options for aggregate root behavior.
 * 
 * @see {@link AggregateRoot} For usage details
 */
export interface AggregateConfig {
  /** The aggregate type name used for stream naming and identification */
  type: string;
  /** Whether to store periodic checkpoints for performance optimization */
  storeCheckpoint: boolean;
}

/**
 * Base class for implementing event-sourced aggregate roots.
 * 
 * Aggregate roots are the core building blocks of domain-driven design and event sourcing.
 * They encapsulate business logic, maintain consistency boundaries, and generate events
 * that represent state changes. The aggregate's current state is rebuilt by replaying
 * its historical events through reducer functions.
 * 
 * Key Features:
 * - **Event Sourcing**: State is derived from events, not stored directly
 * - **Business Logic**: Encapsulates domain rules and invariants
 * - **Event Generation**: Emits events when state changes occur
 * - **Immutable History**: Complete audit trail of all changes
 * - **Checkpointing**: Optional performance optimization for large event histories
 * 
 * @example Basic aggregate
 * ```typescript
 * class BankAccount extends AggregateRoot {
 *   balance: number = 0;
 *   status: 'active' | 'frozen' = 'active';
 * 
 *   constructor() {
 *     super('bank-accounts');
 *     
 *     this.reducers = {
 *       AccountOpened: (event) => {
 *         this.id = event.data.accountId;
 *         this.balance = event.data.initialDeposit;
 *       },
 *       MoneyDeposited: (event) => {
 *         this.balance += event.data.amount;
 *       },
 *       MoneyWithdrawn: (event) => {
 *         this.balance -= event.data.amount;
 *       }
 *     };
 *   }
 * 
 *   static open(accountId: string, initialDeposit: number): BankAccount {
 *     const account = new BankAccount();
 *     account.raiseEvent({
 *       type: 'AccountOpened',
 *       data: { accountId, initialDeposit }
 *     });
 *     return account;
 *   }
 * 
 *   deposit(amount: number) {
 *     if (this.status !== 'active') {
 *       throw new Error('Account is not active');
 *     }
 *     this.raiseEvent({
 *       type: 'MoneyDeposited',
 *       data: { amount, timestamp: new Date() }
 *     });
 *   }
 * }
 * ```
 * 
 * @example With checkpointing
 * ```typescript
 * class HighVolumeAggregate extends AggregateRoot {
 *   constructor() {
 *     super({ type: 'high-volume', storeCheckpoint: true });
 *   }
 * 
 *   currentCheckpoint() {
 *     return {
 *       balance: this.balance,
 *       transactionCount: this.transactionCount
 *     };
 *   }
 * }
 * ```
 * 
 * @see {@link AggregateRepository} For persistence operations
 * @see {@link XStateAggregate} For state machine-based aggregates
 * @see {@link TenantAggregateRoot} For multi-tenant scenarios
 */
export abstract class AggregateRoot {
  /** Complete event history for this aggregate instance */
  history: EventicleEvent[] = [];
  /** Events raised since last persistence (pending events) */
  newEvents: EventicleEvent[] = [];
  /** Unique identifier for this aggregate instance */
  id: string;
  /** Event reducer functions mapping event types to state update logic */
  reducers: any;
  /** Flag indicating if aggregate is currently replaying historical events */
  replaying: boolean;
  /** Aggregate configuration settings */
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

  /**
   * Returns the current state as a checkpoint for performance optimization.
   * 
   * Checkpoints allow aggregates with long event histories to snapshot their
   * current state, reducing the time needed to rebuild from events. This method
   * should be implemented when `storeCheckpoint` is enabled in the config.
   * 
   * @returns Object representing the current aggregate state
   * 
   * @example
   * ```typescript
   * currentCheckpoint() {
   *   return {
   *     balance: this.balance,
   *     status: this.status,
   *     lastTransactionDate: this.lastTransactionDate
   *   };
   * }
   * ```
   */
  currentCheckpoint(): object {
    throw new Error(`
    Checkpoint is not implemented, but has been configured.
    Implement the currentCheckpoint() function on your aggregate.
    `);
  }

  /**
   * Raises a new domain event and applies it to the aggregate state.
   * 
   * This is the primary method for recording state changes in event-sourced
   * aggregates. The event is automatically assigned metadata (ID, timestamp,
   * source) and applied through the appropriate reducer function.
   * 
   * @param event - The domain event to raise
   * @returns The event with populated metadata
   * 
   * @example
   * ```typescript
   * deposit(amount: number) {
   *   // Validate business rules first
   *   if (amount <= 0) {
   *     throw new Error('Amount must be positive');
   *   }
   * 
   *   // Raise the event
   *   this.raiseEvent({
   *     type: 'MoneyDeposited',
   *     data: { amount, timestamp: new Date() }
   *   });
   * }
   * ```
   */
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

  /**
   * Applies an event to the aggregate state using the appropriate reducer.
   * 
   * This method is called automatically by `raiseEvent` and during event
   * replay. It looks up the reducer function for the event type and applies
   * the event to update the aggregate's state.
   * 
   * @param event - The event to apply to the aggregate state
   * 
   * @example Reducer function
   * ```typescript
   * this.reducers = {
   *   MoneyDeposited: (event) => {
   *     this.balance += event.data.amount;
   *     this.lastActivity = event.data.timestamp;
   *   }
   * };
   * ```
   */
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
