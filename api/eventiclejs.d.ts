import { ConsumerConfig } from 'kafkajs';
import { ConsumerRunConfig } from 'kafkajs';
import { DataQuery } from '@eventicle/eventicle-utilities/dist/datastore';
import { DataSorting } from '@eventicle/eventicle-utilities/dist/datastore';
import { DataStore } from '@eventicle/eventicle-utilities/dist/datastore';
import { dataStore } from '@eventicle/eventicle-utilities/dist/datastore';
import { EventEmitter } from 'events';
import { KafkaConfig } from 'kafkajs';
import { LockManager } from '@eventicle/eventicle-utilities';
import { lockManager } from '@eventicle/eventicle-utilities';
import { LogApi } from '@eventicle/eventicle-utilities';
import * as nodeCron from 'node-cron';
import { PagedRecords } from '@eventicle/eventicle-utilities/dist/datastore';
import { Query } from '@eventicle/eventicle-utilities/dist/datastore';
import { Record as Record_2 } from '@eventicle/eventicle-utilities/dist/datastore';
import { ScheduleJobRunner } from '@eventicle/eventicle-utilities/dist/schedule-job-runner';
import { setDataStore } from '@eventicle/eventicle-utilities/dist/datastore';
import { setLockManager } from '@eventicle/eventicle-utilities';
import { setLogApi } from '@eventicle/eventicle-utilities';
import { TransactionData } from '@eventicle/eventicle-utilities/dist/datastore';
import { TransactionListener } from '@eventicle/eventicle-utilities/dist/datastore';
import { TransactionOptions } from '@eventicle/eventicle-utilities/dist/datastore';

/**
 * Configuration options for aggregate root behavior.
 *
 * @see {@link AggregateRoot} For usage details
 */
declare interface AggregateConfig {
    /** The aggregate type name used for stream naming and identification */
    type: string;
    /** Whether to store periodic checkpoints for performance optimization */
    storeCheckpoint: boolean;
}

declare class AggregateObservationAdapter implements EventAdapter {
    readonly streamsToSubscribe: string[];
    readonly name = "aggregate-observer";
    constructor(streamsToSubscribe: string[]);
    readonly consumerGroup: string;
    handleEvent(event: EventicleEvent): Promise<void>;
}

export declare const aggregateObservationAdapter: () => AggregateObservationAdapter;

/**
 * Block for an asynchronous, event based, workflow to occur.
 *
 * Reads streams and allows short lived observers to be notified if a particular AggregateRoot instance has been modified.
 * This is picked out based on the `domainId` of the event.
 *
 * This allows a synchronous API to block and wait for asynchronous changes to finish occurring before continuing processing
 *
 * For example, given a `User` {@link AggregateRoot}, you can wait for a Saga (or other operational component)
 * to approve a user account, by blocking until the given `User` has raised the `user.approved` event.
 *
 * ```
 * export class UserAggregate extends AggregateRoot {
 *   approved: boolean = false
 *
 *   constructor() {
 *      super("User")
 *
 *      this.reducers = []
 *      // persist the approval in the current aggregate state.
 *      // This avoids any potential race conditions between performing the action that requires
 *      // approval and the observer starting to monitor. See below.
 *      this.reducers["user.approved"] = (ev) => {
 *        this.approved = true
 *      }
 *   }
 *
 *   approve() {
 *     this.raiseEvent({
 *       type: "user.approved",
 *       data: {}
 *       // other event fields
 *     })
 *   }
 * }
 * ```
 * First register the observer. This will open a new event subscription, with a dynamically generated consumer group.
 * All events on the topic will be received by this instances, so be mindful of doing this on topics with large volumes
 * of data.
 *
 * ```
 *   await registerAdapter(createAggregateObservationAdapter([AnAggregate]));
 * ```
 *
 * In your synchronous API (eg, HTTP/ REST, GQL).
 *
 * ```
 * // The userId is the domainId of the UserAggregate instance we want to observe
 * export doActionThatRequiresApproval(userId: string) {
 *
 *   // perform some action that triggers async workflows
 *
 *   // now wait for the User to be approved
 *   const user = await aggregateObserver(
 *                             UserAggregate,
 *                             userId,  // the UserAggregate domainId
 *                             10000,   // max time to wait for the User instance to come into the required state
 *                             (ar, ev) => {
 *           // this is called once straight away with just the current state of the User aggregate (ev is null)
 *           // then, every time an event is observed for the UserAggregate with the domainId == userId
 *           // check the current state of the aggregate is what you want to see, or the event being received
 *           // is the one you are waiting for.  Or, ideally, both of those things
 *           // doing both will avoid any race conditions.
 *      return ev && ev.type == "user.approved" || ar.approved
 *   });
 *
 *   // user is now approved, or an Error has been thrown
 *   // perform any ops on the user as required.
 *
 * }
 * ```
 */
export declare function aggregateObserver<AR extends AggregateRoot>(aggregateType: {
    new (...params: any[]): AR;
}, id: string, timeout: number, exec: (ar: AR, event?: EventicleEvent) => boolean): Promise<AR>;

declare interface AggregateRepository {
    /**
     * Replay and build an aggregate root into its current state.
     * @param type
     * @param id
     */
    load<T extends AggregateRoot>(type: {
        new (): T;
    }, id: string): Promise<T>;
    /**
     * Load bulk aggregate instances, according to the given query.
     *
     * The query is only marginally useful, as the current aggregate state is not persisted.
     *
     * Overloaded for backwards compatibility
     */
    loadBulk: LoadBulk;
    /**
     * Obtain the full stream of events that make up the history of an aggregate root.
     * @param type
     * @param id
     */
    history<T extends AggregateRoot>(type: {
        new (): T;
    }, id: string): Promise<EventicleEvent[]>;
    /**
     * Persist an aggregate to the datastore.
     * @param aggregate
     */
    persist<T extends AggregateRoot>(aggregate: T): Promise<EventicleEvent[]>;
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
export declare abstract class AggregateRoot {
    /** Complete event history for this aggregate instance */
    history: EventicleEvent[];
    /** Events raised since last persistence (pending events) */
    newEvents: EventicleEvent[];
    /** Unique identifier for this aggregate instance */
    id: string;
    /** Event reducer functions mapping event types to state update logic */
    reducers: any;
    /** Flag indicating if aggregate is currently replaying historical events */
    replaying: boolean;
    /** Aggregate configuration settings */
    readonly config: AggregateConfig;
    constructor(type: string | AggregateConfig);
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
    currentCheckpoint(): object;
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
    raiseEvent(event: EventicleEvent): EventicleEvent<any>;
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
    handleEvent(event: EventicleEvent): void;
    get type(): string;
}

export declare const aggregates: AggregateRepository;

export declare function allSagaInstances(workspaceId?: string): Promise<SagaInstance<any, any>[]>;

export declare function allSagas(): Promise<Saga<any, any>[]>;

declare namespace apm {
    export {
        apmJoinEvent
    }
}
export { apm }

/**
 * Will join the APM transaction that is stamped in the event header - `apmTrace`
 *
 * This will generate a new span within the APM transaction.
 *
 * @param event the event to join the APM trace on
 * @param name The name of the APM transaction
 * @param type the APM type
 * @param subtype the APM subtype
 */
declare function apmJoinEvent(event: EventicleEvent, name: string, type: string, subtype: string): void;

declare type BulkQuery<T> = {
    type: {
        new (): T;
    };
    filter?: Query;
    sort?: DataSorting;
    page?: number;
    pageSize?: number;
};

declare type BulkResponse<T> = {
    totalCount: number;
    pageInfo: {
        currentPage: number;
        pageSize: number;
    };
    entries: T[];
};

/**
 * Defines a command handler in Eventicle's CQRS architecture.
 *
 * Commands encapsulate business operations that change system state and emit domain events.
 * They provide the "C" in CQRS, handling write operations while maintaining strong consistency
 * and business rule enforcement.
 *
 * @template I - Input data type for the command
 * @template O - Output/response type from the command
 *
 * Key Features:
 * - **Business Logic**: Encapsulates domain operations and invariants
 * - **Event Generation**: Produces events representing state changes
 * - **Type Safety**: Strongly-typed input/output contracts
 * - **Transactional**: Atomic execution with event emission
 * - **Scalable**: Can be distributed across multiple instances
 *
 * @example User management command
 * ```typescript
 * const createUserCommand: Command<{email: string, name: string}, {userId: string}> = {
 *   type: 'CreateUser',
 *   streamToEmit: 'users',
 *   execute: async (data) => {
 *     // Validate business rules
 *     await validateUniqueEmail(data.email);
 *
 *     // Create aggregate and apply business logic
 *     const user = User.create(data.email, data.name);
 *
 *     // Persist and get generated events
 *     const events = await aggregates.persist(user);
 *
 *     return {
 *       response: { userId: user.id },
 *       events
 *     };
 *   }
 * };
 * ```
 *
 * @example Order processing with error handling
 * ```typescript
 * const processOrderCommand: Command<OrderData, {orderId: string}> = {
 *   type: 'ProcessOrder',
 *   streamToEmit: 'orders',
 *   execute: async (data) => {
 *     try {
 *       const order = await aggregates.load(Order, data.orderId);
 *       order.process(data.items);
 *
 *       return {
 *         response: { orderId: order.id },
 *         events: await aggregates.persist(order)
 *       };
 *     } catch (error) {
 *       // Emit failure event and propagate error
 *       return {
 *         events: [{
 *           type: 'OrderProcessingFailed',
 *           domainId: data.orderId,
 *           data: { error: error.message }
 *         }],
 *         webError: new Error('Order processing failed')
 *       };
 *     }
 *   }
 * };
 * ```
 *
 * @see {@link CommandIntent} For command requests
 * @see {@link CommandReturn} For command results
 * @see {@link dispatchCommand} For command execution
 * @see {@link registerCommand} For command registration
 */
export declare interface Command<I, O> {
    /**
     * Unique command type identifier used for registration and dispatch.
     *
     * Should be descriptive and follow consistent naming conventions
     * (e.g., 'CreateUser', 'ProcessPayment', 'CancelOrder').
     */
    type: string;
    /**
     * Target event stream for publishing generated events.
     *
     * All events returned by the command execution will be published to this stream,
     * making them available to event views, sagas, and other subscribers.
     */
    streamToEmit: string;
    /**
     * The command handler function.
     * The data will be received from the CommandIntent
     *
     * This may be called concurrently.
     *
     * This should attempt to modify the system and then emit events to represent
     * the change.
     *
     * @example
     * the most command pattern is to use an AggregateRoot to generate the events
     *
     * ```
     *  const myCommand = {
     *    type: "approve-user",
     *    streamToEmit: "user",
     *    execute: async (data) => {
     *       const user = await aggregates.load(UserAggregate, data.userId);
     *       user.approve();
     *       return {
     *         // aggregates returns all the events that were generated after the
     *         // aggregate was loaded, after it has persisted.
     *         events: await aggregates.persist(user);
     *       }
     *    }
     *  }
     *  ```
     *  this can be called like so
     *
     *  ```
     *  async function example() {
     *    // other setup
     *    await registerCommand(myCommand);
     *
     *    await dispatchCommand({
     *       type: "something",
     *       data: {
     *         userId: "theuser"
     *       }
     *     });
     *  }
     *
     *  example();
     *  ```
     *
     * @param data
     */
    execute: (data: I) => Promise<CommandReturn<O>>;
}

/**
 * Represents a request to execute a command with typed payload data.
 *
 * CommandIntent provides a standardized way to request command execution in Eventicle's
 * CQRS architecture. It decouples command requests from their implementations, enabling
 * features like remote command execution, load balancing, and message-based architectures.
 *
 * @template T - The type of the command payload data
 *
 * @example
 * ```typescript
 * const createUserIntent: CommandIntent<{email: string, name: string}> = {
 *   type: 'CreateUser',
 *   data: {
 *     email: 'john@example.com',
 *     name: 'John Doe'
 *   }
 * };
 *
 * await dispatchCommand(createUserIntent);
 * ```
 *
 * @see {@link Command} For the command implementation
 * @see {@link dispatchCommand} For command execution
 * @see {@link dispatchDirectCommand} For simplified inline commands
 */
export declare interface CommandIntent<T> {
    /**
     * Unique identifier for the command type (e.g., 'CreateUser', 'ProcessPayment').
     *
     * Must match a registered command's type for successful dispatch.
     */
    type: string;
    /**
     * Strongly-typed payload data passed to the command handler.
     *
     * Contains all information needed to execute the command business logic.
     */
    data: T;
}

/**
 * Standard return type for all command executions in Eventicle.
 *
 * CommandReturn provides a consistent interface for command results, separating
 * the response data (returned to caller) from domain events (published to streams).
 * This enables clean separation between synchronous API responses and asynchronous
 * event-driven side effects.
 *
 * @template T - Type of the response data returned to the caller
 *
 * @example Successful command with response
 * ```typescript
 * const result: CommandReturn<{userId: string}> = {
 *   response: { userId: 'user-123' },
 *   events: [{
 *     type: 'UserCreated',
 *     domainId: 'user-123',
 *     data: { email: 'john@example.com', name: 'John Doe' }
 *   }]
 * };
 * ```
 *
 * @example Command with business error
 * ```typescript
 * const result: CommandReturn<void> = {
 *   events: [{
 *     type: 'PaymentFailed',
 *     domainId: 'payment-456',
 *     data: { reason: 'Insufficient funds' }
 *   }],
 *   webError: new Error('Payment processing failed')
 * };
 * ```
 *
 * @see {@link Command} For command definitions
 * @see {@link EventicleEvent} For event structure
 */
export declare interface CommandReturn<T> {
    /**
     * Optional response data returned to the command caller.
     *
     * Typically contains generated IDs, confirmation data, or other information
     * needed by the synchronous caller. This data is NOT published as events.
     */
    response?: T;
    /**
     * Domain events generated during command execution.
     *
     * These events are automatically published to the command's configured stream
     * and become part of the permanent event history. Events represent facts about
     * what happened and drive all downstream processing.
     */
    events: EventicleEvent[];
    /**
     * Optional error to throw after event emission.
     *
     * Allows commands to emit failure events while still signaling errors to callers.
     * The events are published first, then this error is thrown to the caller,
     * enabling both event-driven error handling and traditional exception handling.
     */
    webError?: Error;
}

export declare function connectBroker(config: KafkaConfig): Promise<void>;

/**
 * Will cold replay the entire event stream into a list.
 *
 * Mostly useful for testing, use against long running event streams/ Kafka will blow your local memory!
 *
 * @see EventClient#coldStream
 *
 * @param stream The event stream to cold replay
 */
export declare function consumeFullEventLog(stream: string): Promise<EventicleEvent[]>;

declare interface ConsumerConfigFactory {
    consumerConfig?: (stream: string | string[], consumerName: string, type: ConsumerConfigStreamType) => Partial<ConsumerConfig>;
    consumerRunConfig?: (stream: string | string[], consumerName: string, type: ConsumerConfigStreamType, partitionsConsumedConcurrently: number) => Partial<ConsumerRunConfig>;
}

declare type ConsumerConfigStreamType = "HOT" | "COLD" | "COLD_HOT";

/**
 * Create a new EventAdapter with a dynamic Consumer group id that will subscribe to the topics for the
 * given AggregateRoots
 *
 * @param aggregates the list of aggregate roots to observe. Their topic names will be extracted.
 */
export declare function createAggregateObservationAdapter<AR extends AggregateRoot>(aggregates: {
    new (): AR;
}[]): AggregateObservationAdapter;

export { DataQuery }

export { DataSorting }

export { DataStore }

export { dataStore }

/**
 * This will lookup a pre-registered {@link Command} from the {@link CommandIntent#type},
 * then execute the command with the given payload.
 *
 * It is generally preferred {@link dispatchDirectCommand} where the command
 * definition is implicit, and more fully type checked.
 *
 * This, along with {@link dispatchCommand} is available if you wish to separate
 * your code more fully, or introduce a remote capable message based command bus.
 * @param commandIntent
 */
export declare function dispatchCommand<T>(commandIntent: CommandIntent<T>): Promise<CommandReturn<T>>;

/**
 * Dispatch a command directly, without a CommandIntent message in between.
 *
 * Cannot be distributed or load balanced, but requires less boilerplate.
 *
 * @example
 *
 * Note that no registration of the Command is necessary.
 * This is functionally the same as in {@link Command#execute}
 *
 * ```
 *  await dispatchDirectCommand(() => {
 *       const user = await aggregates.load(UserAggregate, data.userId);
 *       user.approve();
 *       return {
 *         // aggregates returns all the events that were generated after the
 *         // aggregate was loaded, after it has persisted.
 *         events: await aggregates.persist(user);
 *       }
 *  }, "user")
 * ```
 */
export declare function dispatchDirectCommand<T>(command: () => Promise<CommandReturn<T>>, streamToEmit: string, transactionControl?: TransactionOptions): Promise<T>;

/**
 * Represents an event in its encoded, wire-ready format.
 *
 * EncodedEvent is the transport representation of an EventicleEvent, containing
 * the serialized event data as a buffer along with metadata headers. This format
 * is used by EventClient implementations for efficient network transmission and
 * storage.
 *
 * @example
 * ```typescript
 * const encodedEvent: EncodedEvent = {
 *   buffer: Buffer.from(JSON.stringify(eventData)),
 *   key: 'user-123',
 *   timestamp: Date.now(),
 *   headers: {
 *     type: 'UserCreated',
 *     domainId: 'user-123',
 *     id: 'event-456',
 *     source: 'user-service'
 *   }
 * };
 * ```
 *
 * @see {@link EventicleEvent} For the domain event representation
 * @see {@link EventClientCodec} For encoding/decoding between formats
 */
export declare interface EncodedEvent {
    /** Serialized event data as binary buffer */
    buffer: Buffer;
    /** Partitioning key for event streaming (typically domainId) */
    key: string;
    /** Event creation timestamp in milliseconds */
    timestamp: number;
    /** Event metadata headers for routing and processing */
    headers: {
        [key: string]: any;
    };
}

/**
 * Defines an event adapter for real-time event processing and integration.
 *
 * EventAdapter provides a hot-subscription pattern for processing live events as they
 * occur, without replaying historical data. Unlike EventView which processes both
 * historical and live events, adapters focus on real-time integration scenarios
 * like external system synchronization, notifications, and live data feeds.
 *
 * Key Characteristics:
 * - **Hot Subscription Only**: Processes new events, never replays history
 * - **External Integration**: Designed for pushing data to external systems
 * - **Transactional**: Each event is processed within a database transaction
 * - **Error Handling**: Built-in error recovery and monitoring
 * - **Consumer Groups**: Supports load balancing across multiple instances
 *
 * @example External system synchronization
 * ```typescript
 * const crmSyncAdapter: EventAdapter = {
 *   name: 'crm-synchronizer',
 *   consumerGroup: 'crm-sync',
 *   streamsToSubscribe: ['users', 'contacts'],
 *
 *   handleEvent: async (event) => {
 *     switch (event.type) {
 *       case 'UserCreated':
 *         await crmClient.createContact({
 *           externalId: event.domainId,
 *           email: event.data.email,
 *           name: event.data.name,
 *           source: 'app'
 *         });
 *         break;
 *
 *       case 'UserUpdated':
 *         await crmClient.updateContact(event.domainId, {
 *           email: event.data.email,
 *           name: event.data.name
 *         });
 *         break;
 *     }
 *   },
 *
 *   errorHandler: async (adapter, event, error) => {
 *     await errorTracking.report({
 *       adapter: adapter.name,
 *       eventType: event.type,
 *       eventId: event.id,
 *       error: error.message,
 *       timestamp: new Date()
 *     });
 *   }
 * };
 *
 * await registerAdapter(crmSyncAdapter);
 * ```
 *
 * @example Real-time notifications
 * ```typescript
 * const notificationAdapter: EventAdapter = {
 *   name: 'push-notifications',
 *   consumerGroup: 'notifications',
 *   streamsToSubscribe: ['orders', 'payments'],
 *
 *   handleEvent: async (event) => {
 *     const userId = event.data.userId || event.data.customerId;
 *     if (!userId) return;
 *
 *     let message: string;
 *     switch (event.type) {
 *       case 'OrderShipped':
 *         message = `Your order ${event.data.orderNumber} has been shipped!`;
 *         break;
 *       case 'PaymentFailed':
 *         message = 'Payment failed. Please update your payment method.';
 *         break;
 *       default:
 *         return;
 *     }
 *
 *     await pushNotificationService.send(userId, {
 *       title: 'Order Update',
 *       message,
 *       data: { eventId: event.id, type: event.type }
 *     });
 *   }
 * };
 * ```
 *
 * @see {@link registerAdapter} For adapter registration
 * @see {@link EventView} For read-model projections with history replay
 * @see {@link RawEventAdapter} For binary event processing
 */
export declare interface EventAdapter {
    /**
     * Unique adapter identifier for monitoring and debugging.
     *
     * Should be descriptive of the adapter's purpose (e.g., 'crm-sync', 'email-notifications').
     */
    name: string;
    /**
     * Consumer group identifier for load balancing and failure recovery.
     *
     * Multiple adapter instances with the same consumer group will share event
     * processing, enabling horizontal scaling and fault tolerance.
     */
    consumerGroup: string;
    /**
     * Event processing function called for each live event.
     *
     * Should be idempotent as events may be redelivered during failures.
     * Typically integrates with external systems or triggers side effects.
     *
     * @param event - The domain event to process
     */
    handleEvent: (event: EventicleEvent) => Promise<void>;
    /**
     * List of event streams to monitor for live events.
     *
     * Adapter will receive all new events from these streams. Use specific
     * stream names to reduce noise and improve performance.
     */
    streamsToSubscribe: string[];
    /**
     * Optional custom error handler for event processing failures.
     *
     * If not provided, a default handler logs the error and continues processing.
     * Use this for custom error reporting, retry logic, or dead letter queues.
     *
     * @param adapter - The adapter that encountered the error
     * @param event - The event that failed to process
     * @param error - The error that occurred
     */
    errorHandler?: (adapter: EventAdapter, event: EventicleEvent, error: Error) => Promise<void>;
}

/**
 * Core interface for event streaming clients in Eventicle.
 *
 * EventClient provides the fundamental operations for working with event streams:
 * publishing events, subscribing to streams, and replaying historical events.
 * Different implementations support various backends like Kafka, Redis, or in-memory
 * storage for development and testing.
 *
 * Stream Types:
 * - **Hot Streams**: Only new events (live subscription)
 * - **Cold Streams**: Historical events from the beginning
 * - **Cold-Hot Streams**: Historical events followed by live subscription
 *
 * @example Basic usage
 * ```typescript
 * // Emit events
 * await eventClient.emit([{
 *   type: 'UserCreated',
 *   domainId: 'user-123',
 *   data: { email: 'john@example.com' }
 * }], 'users');
 *
 * // Subscribe to live events
 * const subscription = await eventClient.hotStream({
 *   stream: 'users',
 *   groupId: 'user-processor',
 *   handler: async (event) => {
 *     console.log('New user:', event.data.email);
 *   }
 * });
 * ```
 *
 * @see {@link eventClientInMemory} For development/testing
 * @see {@link eventClientOnKafka} For production Kafka implementation
 * @see {@link eventClientOnDatastore} For PostgreSQL-backed storage
 */
export declare interface EventClient {
    /**
     * Publishes events to the specified stream.
     *
     * Events are processed atomically and will be available to subscribers
     * after successful emission. The method supports both domain events
     * (EventicleEvent) and pre-encoded events (EncodedEvent).
     *
     * @param event - Array of events to publish (domain or encoded format)
     * @param stream - Target stream name for the events
     *
     * @example
     * ```typescript
     * await eventClient.emit([{
     *   type: 'OrderCreated',
     *   domainId: 'order-123',
     *   data: { customerId: 'cust-456', total: 99.99 }
     * }], 'orders');
     * ```
     */
    emit: (event: EventicleEvent[] | EncodedEvent[], stream: string) => Promise<void>;
    /**
     * Replays historical events from the beginning of a stream.
     *
     * Cold streams process all existing events in the stream from the start,
     * then complete. This is useful for building projections, migrating data,
     * or analyzing historical event patterns.
     *
     * @param config - Cold stream configuration
     * @param config.stream - Stream name to replay
     * @param config.parallelEventCount - Number of events to process concurrently
     * @param config.handler - Function called for each event
     * @param config.onError - Error handler for processing failures
     * @param config.onDone - Callback when replay is complete
     *
     * @example
     * ```typescript
     * await eventClient.coldStream({
     *   stream: 'orders',
     *   parallelEventCount: 10,
     *   handler: async (event) => {
     *     await updateProjection(event);
     *   },
     *   onError: (error) => console.error('Replay error:', error),
     *   onDone: () => console.log('Replay complete')
     * });
     * ```
     */
    coldStream: (config: {
        stream: string;
        parallelEventCount?: number;
        handler: (event: EventicleEvent) => Promise<void>;
        onError: (error: any) => void;
        onDone: () => void;
    }) => Promise<EventSubscriptionControl>;
    /**
     * Subscribes to live events from one or more streams.
     *
     * Hot streams only receive new events published after the subscription
     * is established. Multiple subscribers with the same groupId will share
     * the event processing load (consumer group pattern).
     *
     * @param config - Hot stream configuration
     * @param config.stream - Stream name(s) to subscribe to
     * @param config.groupId - Consumer group ID for load balancing
     * @param config.parallelEventCount - Concurrent event processing limit
     * @param config.handler - Function called for each new event
     * @param config.onError - Error handler for processing failures
     *
     * @example Single stream
     * ```typescript
     * await eventClient.hotStream({
     *   stream: 'orders',
     *   groupId: 'order-processor',
     *   handler: async (event) => {
     *     await processOrder(event);
     *   },
     *   onError: (error) => console.error('Processing error:', error)
     * });
     * ```
     *
     * @example Multiple streams
     * ```typescript
     * await eventClient.hotStream({
     *   stream: ['orders', 'payments', 'shipments'],
     *   groupId: 'fulfillment-processor',
     *   handler: async (event) => {
     *     await handleFulfillmentEvent(event);
     *   }
     * });
     * ```
     */
    hotStream: (config: {
        parallelEventCount?: number;
        stream: string | string[];
        groupId: string;
        handler: (event: EventicleEvent) => Promise<void>;
        onError: (error: any) => void;
    }) => Promise<EventSubscriptionControl>;
    /**
     * Only play hot data.
     */
    hotRawStream: (config: {
        parallelEventCount?: number;
        stream: string | string[];
        groupId: string;
        handler: (event: EncodedEvent) => Promise<void>;
        onError: (error: any) => void;
    }) => Promise<EventSubscriptionControl>;
    /**
     * Play from persisted storage the continue from in memory
     */
    coldHotStream: (config: {
        parallelEventCount?: number;
        rawEvents: true;
        stream: string | string[];
        groupId: string;
        handler: (event: EncodedEvent) => Promise<void>;
        onError: (error: any) => void;
    } | {
        parallelEventCount?: number;
        rawEvents: false;
        stream: string | string[];
        groupId: string;
        handler: (event: EventicleEvent) => Promise<void>;
        onError: (error: any) => void;
    } | {
        parallelEventCount?: number;
        stream: string | string[];
        groupId: string;
        handler: (event: EventicleEvent) => Promise<void>;
        onError: (error: any) => void;
    }) => Promise<EventSubscriptionControl>;
    shutdown: () => Promise<void>;
    isConnected: () => boolean;
}

export declare function eventClient(): EventClient;

/**
 * Codec interface for converting between domain events and wire format.
 *
 * EventClientCodec provides the serialization/deserialization layer between
 * EventicleEvent (domain representation) and EncodedEvent (wire representation).
 * Different implementations can provide JSON, Avro, Protocol Buffers, or custom
 * encoding schemes.
 *
 * The codec is responsible for:
 * - Serializing event payloads and metadata
 * - Handling distributed tracing headers
 * - Version compatibility and schema evolution
 * - Compression and encryption (if needed)
 *
 * @example
 * ```typescript
 * class CustomCodec implements EventClientCodec {
 *   async encode(event: EventicleEvent): Promise<EncodedEvent> {
 *     return {
 *       buffer: Buffer.from(JSON.stringify(event)),
 *       key: event.domainId,
 *       timestamp: event.createdAt,
 *       headers: { type: event.type, version: '1.0' }
 *     };
 *   }
 *
 *   async decode(encoded: EncodedEvent): Promise<EventicleEvent> {
 *     return JSON.parse(encoded.buffer.toString());
 *   }
 * }
 * ```
 *
 * @see {@link EventClientJsonCodec} For the default JSON implementation
 * @see {@link AvroCodec} For Avro-based schema evolution support
 */
export declare interface EventClientCodec {
    /**
     * Converts a domain event into its wire-ready encoded format.
     *
     * @param event - The domain event to encode
     * @returns Promise resolving to the encoded event ready for transmission
     */
    encode: (event: EventicleEvent) => Promise<EncodedEvent>;
    /**
     * Converts an encoded event back into its domain representation.
     *
     * @param encoded - The encoded event received from the wire
     * @returns Promise resolving to the decoded domain event
     */
    decode: (encoded: EncodedEvent) => Promise<EventicleEvent>;
}

export declare function eventClientCodec(): EventClientCodec;

/**
 * This is a test capable event client.
 *
 * It fully implements the event client semantics, and persists its events into the given data store.
 *
 * Good to pair with the InMemDataStore for testing and local dev usage.
 *
 * Not recommended for production (really!), as you disable any possibility of distribution
 */
export declare function eventClientOnDatastore(): EventClient;

/**
 * https://kafka.js.org/docs/admin#a-name-create-topics-a-create-topics
 *
 * @param config as per kafkjs
 * @param consumerConfig as per kafkajs
 * @param onTopicFailureConfig If a consumer fails because the topic doesn't exist, configure this to request the topic is auto generated with the given config
 */
export declare function eventClientOnKafka(config: KafkaConfig, consumerConfig?: ConsumerConfigFactory, onTopicFailureConfig?: (topicName: any) => Promise<TopicFailureConfiguration>): Promise<EventClient>;

/**
 * Core event interface representing something that happened in the system.
 *
 * EventicleEvent is the fundamental building block of event-driven architectures
 * in Eventicle. Events are immutable facts about state changes that occurred,
 * providing the foundation for event sourcing, CQRS, and saga coordination.
 *
 * @template T - The type of the event payload data
 *
 * @example Basic event
 * ```typescript
 * const userCreated: EventicleEvent<{email: string, name: string}> = {
 *   type: 'UserCreated',
 *   domainId: 'user-123',
 *   data: {
 *     email: 'john@example.com',
 *     name: 'John Doe'
 *   }
 * };
 * ```
 *
 * @example Event with causation tracking
 * ```typescript
 * const orderShipped: EventicleEvent = {
 *   type: 'OrderShipped',
 *   domainId: 'order-456',
 *   causedById: 'payment-789',
 *   causedByType: 'PaymentProcessed',
 *   data: { trackingNumber: 'TRK123456' }
 * };
 * ```
 *
 * Key Properties:
 * - **Immutable**: Events cannot be changed once created
 * - **Causally Linked**: Events can reference what caused them
 * - **Timestamped**: Automatic timestamp assignment
 * - **Traceable**: Support for distributed tracing
 * - **Typed**: Strong typing for event payloads
 */
export declare interface EventicleEvent<T = any> {
    /** Unique identifier for this event (auto-generated if not provided) */
    id?: string;
    /** Event type name (e.g., 'UserCreated', 'OrderShipped') */
    type: string;
    /** Source system or service that generated this event */
    source?: string;
    /** ID of the event that caused this event (for causation tracking) */
    causedById?: string;
    /** Type of the event that caused this event */
    causedByType?: string;
    /** Event stream name (often matches aggregate type) */
    stream?: string;
    /** Domain entity ID this event relates to */
    domainId?: string;
    /** Event creation timestamp in milliseconds (auto-generated if not provided) */
    createdAt?: number;
    /** The event payload containing the actual event data */
    data: T;
}

export declare function eventSourceName(): string;

/**
 * Control interface for managing event stream subscriptions.
 *
 * Provides lifecycle management for active event subscriptions,
 * allowing graceful shutdown and resource cleanup.
 *
 * @example
 * ```typescript
 * const subscription = await eventClient.hotStream({
 *   stream: 'orders',
 *   groupId: 'order-processor',
 *   handler: async (event) => {
 *     await processOrder(event);
 *   }
 * });
 *
 * // Later, when shutting down
 * await subscription.close();
 * ```
 */
declare interface EventSubscriptionControl {
    /** Closes the subscription and releases associated resources */
    close: () => Promise<void>;
}

/**
 * Defines an event view for building read-side projections in CQRS architectures.
 *
 * EventView implements the "Q" (Query) side of CQRS, processing domain events to build
 * optimized read models, projections, and materialized views. Views enable efficient
 * querying by maintaining denormalized data structures tailored for specific read patterns.
 *
 * Key Features:
 * - **Event Processing**: Handles events from multiple streams
 * - **Consumer Groups**: Enables load balancing across multiple instances
 * - **Parallel Processing**: Configurable concurrency for high throughput
 * - **Cold/Hot Replay**: Processes historical events then continues with live events
 * - **Error Handling**: Built-in error recovery and monitoring
 *
 * @example User profile projection
 * ```typescript
 * const userProfileView: EventView = {
 *   consumerGroup: 'user-profile-projection',
 *   parallelEventCount: 10,
 *   streamsToSubscribe: ['users', 'preferences'],
 *
 *   handleEvent: async (event) => {
 *     switch (event.type) {
 *       case 'UserCreated':
 *         await db.userProfiles.create({
 *           userId: event.domainId,
 *           email: event.data.email,
 *           name: event.data.name,
 *           createdAt: new Date(event.createdAt)
 *         });
 *         break;
 *
 *       case 'UserProfileUpdated':
 *         await db.userProfiles.update(
 *           { userId: event.domainId },
 *           { name: event.data.name }
 *         );
 *         break;
 *
 *       case 'PreferenceSet':
 *         await db.userProfiles.update(
 *           { userId: event.data.userId },
 *           { preferences: event.data.preferences }
 *         );
 *         break;
 *     }
 *   }
 * };
 *
 * await registerView(userProfileView);
 * ```
 *
 * @example Analytics aggregation
 * ```typescript
 * const analyticsView: EventView = {
 *   consumerGroup: 'analytics-aggregator',
 *   parallelEventCount: 20,
 *   streamsToSubscribe: ['orders', 'payments', 'shipments'],
 *
 *   handleEvent: async (event) => {
 *     switch (event.type) {
 *       case 'OrderCreated':
 *         await updateDailyMetrics('orders_created', event.createdAt);
 *         await updateCustomerMetrics(event.data.customerId, 'order_count');
 *         break;
 *
 *       case 'PaymentProcessed':
 *         await updateDailyMetrics('revenue', event.createdAt, event.data.amount);
 *         await updateCustomerMetrics(event.data.customerId, 'total_spent', event.data.amount);
 *         break;
 *     }
 *   }
 * };
 * ```
 *
 * @see {@link registerView} For view registration
 * @see {@link RawEventView} For binary event processing
 * @see {@link EventicleEvent} For event structure
 */
export declare interface EventView {
    /**
     * Number of events to process concurrently (default varies by implementation).
     *
     * Higher values increase throughput but may impact memory usage and database
     * connection pools. Tune based on your processing requirements.
     */
    parallelEventCount?: number;
    /**
     * Unique consumer group identifier for load balancing.
     *
     * Multiple view instances with the same consumer group will share event
     * processing, enabling horizontal scaling and fault tolerance.
     */
    consumerGroup: string;
    /**
     * Event processing function called for each received event.
     *
     * Should be idempotent as events may be redelivered during failures.
     * Typically updates read models, projections, or external systems.
     *
     * @param event - The domain event to process
     */
    handleEvent: (event: EventicleEvent) => Promise<void>;
    /**
     * List of event streams to subscribe to.
     *
     * View will receive all events from these streams. Use specific stream
     * names to reduce processing overhead and improve performance.
     */
    streamsToSubscribe: string[];
}

declare interface HandlerConfig<T extends EventicleEvent, Y, TimeoutNames> {
    /**
     * Obtain a lock during the processing of this event.
     * Defaults to no lock
     */
    withLock?: (instance: SagaInstance<TimeoutNames, Y>, event: T) => string;
    /**
     * Given an event, describe how to find a saga instance that can handle it.
     * @param ev
     */
    matchInstance: (ev: T) => {
        instanceProperty: keyof Y;
        value: any;
    };
}

/**
 * In memory Datastore implementation.
 *
 * This is suitable for testing and single instance demonstration purposes.
 *
 * @see DataStore
 */
export declare class implements DataStore {
    events: EventEmitter<[never]>;
    hasTransactionData(): boolean;
    on(event: "transaction.start" | "transaction.commit", listener: (name: string, data: TransactionData) => void): this;
    getTransactionData(): TransactionData;
    transaction<T>(exec: () => Promise<T>): Promise<T>;
    /**
     *
     * @param {*} type Entity type or "table" name
     * @param {*} id
     */
    getEntity(workspaceId: string, type: any, id: string): Promise<Record_2>;
    /**
     *
     * @param workspaceId
     * @param {*} type Entity type or "table" name
     * @param {*} query  Json object to match fields
     * @param sorting
     */
    findEntity(workspaceId: string, type: any, query: Query, sorting?: DataSorting): Promise<Record_2[]>;
    /**
     *
     * @param workspaceId
     * @param {*} type Entity type or "table" name
     * @param {*} query  Json object to match fields
     * @param sorting
     * @param {*} page page count
     * @param {*} pageSize page size
     */
    findEntityPaginated(workspaceId: string, type: string, query: Query, sorting: DataSorting, page: number, pageSize: number): Promise<PagedRecords>;
    /**
     *
     * @param {*} type Entity type or "table" name
     * @param {*} item
     */
    createEntity(workspaceId: string, type: string, item: any): Promise<any>;
    saveEntity(workspaceId: string, type: string, item: Record_2): Promise<Record_2>;
    deleteEntity(workspaceId: string, type: string, id: string): Promise<void>;
    deleteMany(workspaceId: string, type: string, query: Query): Promise<void>;
    purge(): Promise<void>;
}

declare type LoadBulk = {
    <T extends AggregateRoot>(config: BulkQuery<T>): Promise<BulkResponse<T>>;
    <T extends AggregateRoot>(type: {
        new (type?: string | AggregateConfig): T;
    }, filter?: Query, page?: number, pageSize?: number): Promise<BulkResponse<T>>;
};

/**
 * A Scheduled Job Runner that uses node-cron, setTimeout and runs as a single node.
 *
 * Persists and loads schedules on process stop/ start in the datastore with the types `lock-manager-timer` and `lock-manager-cron`
 */
export declare class LocalScheduleJobRunner implements ScheduleJobRunner {
    timers: Map<string, NodeJS.Timeout>;
    crons: Map<string, nodeCron.ScheduledTask>;
    events: EventEmitter<[never]>;
    constructor();
    addScheduleTaskListener(component: string, exec: (name: string, id: string, data: any) => Promise<void>): Promise<void>;
    addScheduledTask(component: string, name: string, id: string, config: {
        isCron: true;
        crontab: string;
    } | {
        isCron: false;
        timeout: number;
    }, data: any): Promise<void>;
    private manageCronTimerSchedule;
    private manageSimpleTimerSchedule;
    hasSchedule(component: string, name: string, id: string): Promise<boolean>;
    removeSchedule(component: string, name: string, id: string): Promise<void>;
    startup(): Promise<void>;
    clearAllTimers(): void;
}

export { LockManager }

export { lockManager }

export { LogApi }

export declare function metrics(): {
    "view-latency": any;
    "adapter-latency": any;
    "saga-latency": any;
};

export { PagedRecords }

/**
 * Defines a view for processing events in their raw, encoded format.
 *
 * RawEventView enables processing events without decoding them into domain objects,
 * which is useful for scenarios requiring high performance, binary storage, or
 * custom encoding schemes. Events are processed as EncodedEvent objects containing
 * the raw buffer and metadata headers.
 *
 * Use Cases:
 * - **High Performance**: Avoid decoding overhead for throughput-sensitive scenarios
 * - **Binary Storage**: Store events in their original encoded format
 * - **Custom Processing**: Implement custom decoding or transformation logic
 * - **Event Forwarding**: Route events to external systems without modification
 * - **Audit Trails**: Preserve exact event format for compliance requirements
 *
 * @example Binary event archival
 * ```typescript
 * const eventArchiveView: RawEventView = {
 *   consumerGroup: 'event-archiver',
 *   streamsToSubscribe: ['users', 'orders', 'payments'],
 *
 *   handleEvent: async (encodedEvent) => {
 *     // Store raw event data with metadata
 *     await archiveStorage.store({
 *       eventId: encodedEvent.headers.id,
 *       eventType: encodedEvent.headers.type,
 *       timestamp: encodedEvent.timestamp,
 *       rawData: encodedEvent.buffer,
 *       headers: encodedEvent.headers
 *     });
 *   }
 * };
 *
 * await registerRawView(eventArchiveView);
 * ```
 *
 * @example High-performance event forwarding
 * ```typescript
 * const eventForwarder: RawEventView = {
 *   consumerGroup: 'external-forwarder',
 *   streamsToSubscribe: ['public-events'],
 *
 *   handleEvent: async (encodedEvent) => {
 *     // Forward to external webhook without decoding
 *     await httpClient.post('/webhook', {
 *       headers: {
 *         'Content-Type': 'application/octet-stream',
 *         'X-Event-Type': encodedEvent.headers.type,
 *         'X-Event-Id': encodedEvent.headers.id
 *       },
 *       body: encodedEvent.buffer
 *     });
 *   }
 * };
 * ```
 *
 * @see {@link registerRawView} For view registration
 * @see {@link EventView} For decoded event processing
 * @see {@link EncodedEvent} For raw event structure
 */
export declare interface RawEventView {
    /**
     * Unique consumer group identifier for load balancing.
     *
     * Multiple raw view instances with the same consumer group will share event
     * processing, enabling horizontal scaling and fault tolerance.
     */
    consumerGroup: string;
    /**
     * Raw event processing function called for each received encoded event.
     *
     * Receives events in their binary format without decoding. Use this for
     * high-performance scenarios or when you need access to the raw event data.
     *
     * @param event - The encoded event with buffer and metadata
     */
    handleEvent: (event: EncodedEvent) => Promise<void>;
    /**
     * List of event streams to subscribe to.
     *
     * View will receive all raw events from these streams. Consider the
     * performance implications of subscribing to high-volume streams.
     */
    streamsToSubscribe: string[];
}

export { Record_2 as Record }

/**
 * This will connect the given EventAdapter to event streams.
 *
 * An EventAdapter is a `hot` subscription, and will receive events emitted after
 * it first connects.
 *
 * If it is offline for a period, the backing event store (eg, Kafka) will allow the adapter
 * to reconnect and pick up from where it had previous processed up to.
 *
 * @param adapter
 */
export declare function registerAdapter(adapter: EventAdapter): Promise<EventSubscriptionControl>;

export declare function registerCommand<I, O>(command: Command<I, O>): void;

/**
 * Will register a raw event view
 *
 * This subscribes it to the appropriate event streams. For every event received, handeEvent will be called.
 *
 * Events are not processed through the {@link EventClientCodec}, and so are observed encoded as an {@link EncodedEvent}
 *
 * This can be useful if you want to persist the event in a raw form, as a binary encoded stream.
 *
 * @param view The View to subscribe to event streams
 */
export declare function registerRawView(view: RawEventView): Promise<EventSubscriptionControl>;

export declare function registerSaga<TimeoutNames, Y>(saga: Saga<TimeoutNames, Y>): Promise<EventSubscriptionControl>;

export declare function registerView(view: EventView): Promise<EventSubscriptionControl>;

export declare function removeAllSagas(): Promise<void>;

/**
 * Defines a long-running business process that coordinates across events and time.
 *
 * Sagas implement the Saga pattern for managing complex workflows that span multiple
 * aggregates, external services, and time-based operations. They provide stateful
 * event processing with support for timers, error handling, and process coordination.
 *
 * @template TimeoutNames - Union type of timer names this saga can schedule
 * @template InstanceData - Type of the saga's persistent state data
 *
 * Key Features:
 * - **Stateful Processing**: Maintains state across multiple events
 * - **Timer Support**: Schedule delays and recurring operations
 * - **Error Handling**: Custom error handling and compensation logic
 * - **Event Correlation**: Match events to specific saga instances
 * - **Parallel Processing**: Configurable concurrency for high throughput
 *
 * @example Payment processing saga
 * ```typescript
 * interface PaymentData {
 *   orderId: string;
 *   amount: number;
 *   attempts: number;
 * }
 *
 * type PaymentTimers = 'timeout' | 'retry';
 *
 * export function paymentSaga() {
 *   return saga<PaymentTimers, PaymentData>('PaymentSaga')
 *     .subscribeStreams(['orders', 'payments'])
 *     .startOn('OrderCreated', {}, async (instance, event) => {
 *       instance.set('orderId', event.data.orderId);
 *       instance.set('amount', event.data.amount);
 *       instance.set('attempts', 0);
 *
 *       // Process payment
 *       await processPayment(event.data);
 *
 *       // Set timeout
 *       instance.upsertTimer('timeout', {
 *         isCron: false,
 *         timeout: 300000 // 5 minutes
 *       });
 *     })
 *     .on('PaymentSucceeded', {
 *       matchInstance: (event) => ({
 *         instanceProperty: 'orderId',
 *         value: event.data.orderId
 *       })
 *     }, async (instance, event) => {
 *       instance.removeTimer('timeout');
 *       instance.endSaga();
 *     })
 *     .onTimer('timeout', async (instance) => {
 *       const attempts = instance.get('attempts');
 *       if (attempts < 3) {
 *         instance.set('attempts', attempts + 1);
 *         await retryPayment(instance.get('orderId'));
 *       } else {
 *         await failPayment(instance.get('orderId'));
 *         instance.endSaga();
 *       }
 *     });
 * }
 * ```
 *
 * @see {@link SagaInstance} For instance state management
 * @see {@link registerSaga} For saga registration
 * @see {@link SagaScheduler} For advanced scheduling
 */
export declare class Saga<TimeoutNames, InstanceData> {
    readonly name: string;
    streams: string[];
    streamSubs: EventSubscriptionControl[];
    parallelEventCount: number;
    starts: Map<string, {
        config: StartHandlerConfig<any, InstanceData, TimeoutNames>;
        handle: (saga: SagaInstance<TimeoutNames, InstanceData>, event: EventicleEvent) => Promise<void>;
    }>;
    eventHandler: Map<string, {
        config: HandlerConfig<any, InstanceData, TimeoutNames>;
        handle: (saga: SagaInstance<TimeoutNames, InstanceData>, event: EventicleEvent) => Promise<void>;
    }>;
    errorHandler: (saga: any, event: EventicleEvent, error: Error) => Promise<void>;
    timerHandler: Map<TimeoutNames, {
        handle: (saga: SagaInstance<TimeoutNames, InstanceData>) => Promise<void>;
    }>;
    constructor(name: string);
    parallelEvents(val: number): Saga<TimeoutNames, InstanceData>;
    subscribeStreams(streams: string[]): Saga<TimeoutNames, InstanceData>;
    /**
     * Register a handler for a timer triggered saga step.
     *
     * This will be called on the timer.
     *
     * No event is present.
     *
     * @param name The name of the timer
     * @param handle the async function to execute.
     */
    onTimer(name: TimeoutNames, handle: (saga: SagaInstance<TimeoutNames, InstanceData>) => Promise<void>): Saga<TimeoutNames, InstanceData>;
    /**
     * Registers an event handler that can start new saga instances.
     *
     * When the specified event type is received and no existing saga instance
     * matches, a new saga instance will be created and the handler called.
     * Only one startOn handler per event type is allowed.
     *
     * @param eventName - The event type that can start new saga instances
     * @param config - Configuration for instance creation
     * @param handler - The function to execute when starting a new instance
     *
     * @example
     * ```typescript
     * saga.startOn('OrderCreated', {
     *   matches: async (event) => event.data.requiresPayment,
     *   withLock: (instance, event) => `payment-${event.data.orderId}`
     * }, async (instance, event) => {
     *   instance.set('orderId', event.data.orderId);
     *   await initiatePayment(event.data);
     * });
     * ```
     */
    startOn<T extends EventicleEvent>(eventName: string, config: StartHandlerConfig<T, InstanceData, TimeoutNames>, handler: (saga: SagaInstance<TimeoutNames, InstanceData>, event: T) => Promise<void>): Saga<TimeoutNames, InstanceData>;
    /**
     * Registers an event handler for existing saga instances.
     *
     * When the specified event type is received, the handler will be called
     * on any existing saga instances that match the event based on the
     * matchInstance configuration.
     *
     * @param eventName - The event type to handle
     * @param config - Configuration for instance matching and locking
     * @param handler - The function to execute for matching instances
     *
     * @example
     * ```typescript
     * saga.on('PaymentCompleted', {
     *   matchInstance: (event) => ({
     *     instanceProperty: 'orderId',
     *     value: event.data.orderId
     *   }),
     *   withLock: (instance, event) => `payment-${event.data.orderId}`
     * }, async (instance, event) => {
     *   instance.set('paymentId', event.data.paymentId);
     *   instance.removeTimer('timeout');
     *   await completeOrder(instance.get('orderId'));
     *   instance.endSaga();
     * });
     * ```
     */
    on<T extends EventicleEvent>(eventName: string, config: HandlerConfig<T, InstanceData, TimeoutNames>, handler: (saga: SagaInstance<TimeoutNames, InstanceData>, event: T) => Promise<void>): Saga<TimeoutNames, InstanceData>;
    onError(handler: (saga: any, event: EventicleEvent, error: Error) => Promise<void>): Saga<TimeoutNames, InstanceData>;
}

export declare function saga<TimeoutNames, SagaInstanceData>(name: string): Saga<TimeoutNames, SagaInstanceData>;

/**
 * Represents a single running instance of a saga workflow.
 *
 * SagaInstance contains the runtime state and execution context for a specific
 * saga execution. Each instance tracks its data, manages timers, and provides
 * methods for saga lifecycle management.
 *
 * @template TimeoutNames - Union type of timer names this saga can schedule
 * @template T - Type of the saga's persistent data
 *
 * @example
 * ```typescript
 * interface PaymentData {
 *   orderId: string;
 *   amount: number;
 *   attempts: number;
 * }
 *
 * type PaymentTimers = 'timeout' | 'retry';
 *
 * // In saga handler
 * async function handleOrderCreated(
 *   instance: SagaInstance<PaymentTimers, PaymentData>,
 *   event: OrderCreatedEvent
 * ) {
 *   instance.set('orderId', event.data.orderId);
 *   instance.set('amount', event.data.amount);
 *   instance.set('attempts', 0);
 *
 *   // Schedule timeout
 *   instance.upsertTimer('timeout', {
 *     isCron: false,
 *     timeout: 300000 // 5 minutes
 *   });
 * }
 * ```
 *
 * @see {@link Saga} For the saga definition
 * @see {@link SagaScheduler} For timer execution
 */
export declare class SagaInstance<TimeoutNames, T> {
    readonly internalData: any;
    readonly record?: Record_2;
    /** Timers pending removal in the next persistence cycle */
    readonly timersToRemove: TimeoutNames[];
    /** Timers pending addition in the next persistence cycle */
    readonly timersToAdd: {
        name: TimeoutNames;
        config: {
            isCron: true;
            crontab: string;
        } | {
            isCron: false;
            timeout: number;
        };
    }[];
    constructor(internalData: any, record?: Record_2);
    /**
     * Retrieves a piece of data from the saga instance state.
     *
     * @param name - The key of the data to retrieve
     * @returns The value associated with the key
     *
     * @example
     * ```typescript
     * const orderId = instance.get('orderId');
     * const attempts = instance.get('attempts');
     * ```
     */
    get<K extends keyof T>(name: K): T[K];
    /**
     * Sets a piece of data in the saga instance state.
     *
     * The value must be JSON-serializable as saga state is persisted.
     * The 'id' field is protected and cannot be modified.
     *
     * @param name - The key to set
     * @param value - The value to store (must be JSON-serializable)
     *
     * @throws Error if attempting to set the 'id' field
     *
     * @example
     * ```typescript
     * instance.set('status', 'processing');
     * instance.set('retryCount', 3);
     * instance.set('lastError', { code: 'TIMEOUT', message: 'Request timed out' });
     * ```
     */
    set(name: keyof T, value: any): void;
    lastEvent(): EventicleEvent;
    /**
     * Create (or overwrite) a timer to call. Can be either a simple timer (millis to wait), or a cron timer.
     *
     * If the timer is no longer wanted, it must be removed by calling {@see removeTimer}
     *
     * @param name The timer to call
     * @param config
     *
     * @example
     * ```
     *
     * export function sagaWithTimeouts() {
     *   return saga<"ShortTimeout" | "PollEveryDay", never>(
     *     "sagaWithTimeouts"
     *   )
     *     .subscribeStreams(["payments"])
     *     .startOn("payment.created", {}, async (instance, event) => {
     *       instance.upsertTimer("ShortTimeout", {
     *         isCron: false,
     *         timeout: 5000,    // wait for 5s and then call.
     *       });
     *       instance.upsertTimer("PollEveryDay", {
     *         isCron: true,
     *         crontab: "0 4 * * *" // will run every day at 4am
     *       });
     *     })
     *     .onTimer("ShortTimeout", async (instance) => {
     *       // this will fire 5000ms after the auction created event arrives
     *       instance.endSaga();
     *     });
     *     .onTimer("PollEveryDay", async (instance) => {
     *       // this will fire every day at 4am
     *       console.log("Running at 4am ... ")
     *     });
     * }
     * ```
     */
    upsertTimer(name: TimeoutNames, config: {
        isCron: true;
        crontab: string;
    } | {
        isCron: false;
        timeout: number;
    }): void;
    removeTimer(name: TimeoutNames): void;
    /**
     * Marks the saga instance as completed and schedules it for cleanup.
     *
     * Once a saga is ended, it will not receive any more events or timer
     * callbacks. The instance data can optionally be preserved for debugging
     * or audit purposes.
     *
     * @param preserveInstanceData - Whether to keep instance data after completion
     *
     * @example
     * ```typescript
     * // End saga and clean up data
     * instance.endSaga();
     *
     * // End saga but preserve data for audit
     * instance.endSaga(true);
     * ```
     */
    endSaga(preserveInstanceData?: boolean): void;
}

export declare function scheduler(): ScheduleJobRunner;

export { setDataStore }

export declare function setEventClient(cl: EventClient): void;

export declare function setEventClientCodec(cl: EventClientCodec): void;

export declare function setEventSourceName(name: string): void;

export { setLockManager }

export { setLogApi }

export declare function setScheduler(scheduler: ScheduleJobRunner): void;

declare interface StartHandlerConfig<T extends EventicleEvent, Y, TimeoutNames> {
    /**
     * Only start a saga instance if this function returns true
     *
     * @param event
     */
    matches?: (event: T) => Promise<boolean>;
    /**
     * Obtain a lock during the processing of this event.
     * Defaults to no lock
     */
    withLock?: (instance: SagaInstance<TimeoutNames, Y>, event: T) => string;
}

declare type TopicFailureConfiguration = {
    createTopic: boolean;
    numPartitions?: number;
    replicationFactor?: number;
    configEntries?: {
        name: string;
        value: string;
    }[];
};

export { TransactionData }

export { TransactionListener }

export { TransactionOptions }

export { }
