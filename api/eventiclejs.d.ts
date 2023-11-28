/// <reference types="node" />

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

declare interface AggregateConfig {
    type: string;
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

export declare abstract class AggregateRoot {
    history: EventicleEvent[];
    newEvents: EventicleEvent[];
    id: string;
    reducers: any;
    replaying: boolean;
    readonly config: AggregateConfig;
    constructor(type: string | AggregateConfig);
    currentCheckpoint(): object;
    raiseEvent(event: EventicleEvent): EventicleEvent;
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
 * A Command.
 *
 * It is generally preferred {@link dispatchDirectCommand} where the command
 * definition is implicit, and more fully type checked.
 *
 * This, along with {@link dispatchCommand} is available if you wish to separate
 * your code more fully, or introduce a remote capable message based command bus.
 */
export declare interface Command<I, O> {
    /**
     * The name of the Command. This is used to look it up
     * when the user calls {@link dispatchCommand}
     */
    type: string;
    /**
     * The event stream that any events in the CommandReturn should be emitted on
     *
     * @see EventClient
     * @see CommandReturn#events
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
 * A CommandIntent is a message instructing Eventicle to perform an action that
 * may emit events that should be sent externally using the {@link EventClient}
 */
export declare interface CommandIntent<T> {
    /**
     * The command type
     * @see Command#type
     */
    type: string;
    /**
     * The data that will be used when calling the Command instance.
     */
    data: T;
}

/**
 * The global return type for {@link Command}, whether the command is explicit, as in
 * {@link dispatchCommand}, or implicit, as in {@link dispatchDirectCommand}.
 *
 * This return type is passed to the caller, but before that happens, it will
 * be processed by the dispatcher to capture any events that need to be emitted.
 */
export declare interface CommandReturn<T> {
    /**
     * An optional response object.
     * This will be ignored by the command dispatcher, and passed through
     * to the calling code.  Most commonly used to pass IDs that have been generated
     * during command execution.
     */
    response?: T;
    /**
     * Any events that have been generated during command execution that should be
     * emitted externally onto the configured topic.
     * By the time the calling code receives the return, the events have already been
     * passed to {@link EventClient#emit}, and cannot be altered.
     */
    events: EventicleEvent[];
    /**
     * Optional error property.
     *
     * Used by some implementations to indicate that the Command finished in an Error,
     * which should now be thrown.
     *
     * This is performed so that the command can emit events (describing the error),
     * and also instruct the calling code (which is normally a synchronous API) to
     * subsequently throw the given Error back to the user.
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
    consumerRunConfig?: (stream: string | string[], consumerName: string, type: ConsumerConfigStreamType) => Partial<ConsumerRunConfig>;
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
export declare function dispatchDirectCommand<T>(command: () => Promise<CommandReturn<T>>, streamToEmit: string): Promise<T>;

export declare interface EncodedEvent {
    buffer: Buffer;
    key: string;
    timestamp: number;
    headers: {
        [key: string]: any;
    };
}

/**
 * An adapter is an observer on an event stream.
 *
 * It only operates on hot event data, and will never attempt to replay everything
 */
export declare interface EventAdapter {
    name: string;
    consumerGroup: string;
    handleEvent: (event: EventicleEvent) => Promise<void>;
    streamsToSubscribe: string[];
    errorHandler?: (adapter: EventAdapter, event: EventicleEvent, error: Error) => Promise<void>;
}

export declare interface EventClient {
    /**
     *
     * @param event
     * @param stream
     */
    emit: (event: EventicleEvent[] | EncodedEvent[], stream: string) => Promise<void>;
    /**
     * Play from persisted storage
     * @param stream
     * @param from
     * @param handler
     * @param onError
     * @param onDone
     */
    coldStream: (stream: string, handler: (event: EventicleEvent) => Promise<void>, onError: (error: any) => void, onDone: () => void) => Promise<EventSubscriptionControl>;
    /**
     * Only play hot data.
     * @param stream
     * @param consumerName
     * @param handler
     * @param onError
     */
    hotStream: (stream: string | string[], consumerName: string, handler: (event: EventicleEvent) => Promise<void>, onError: (error: any) => void) => Promise<EventSubscriptionControl>;
    /**
     * Only play hot data.
     * @param stream
     * @param consumerName
     * @param handler
     * @param onError
     */
    hotRawStream: (stream: string | string[], consumerName: string, handler: (event: EncodedEvent) => Promise<void>, onError: (error: any) => void) => Promise<EventSubscriptionControl>;
    /**
     * Play from persisted storage the continue from in memory
     * @param stream
     * @param from
     * @param handler
     * @param onError
     * @param onDone
     */
    coldHotStream: (config: {
        rawEvents: true;
        stream: string | string[];
        groupId: string;
        handler: (event: EncodedEvent) => Promise<void>;
        onError: (error: any) => void;
    } | {
        rawEvents: false;
        stream: string | string[];
        groupId: string;
        handler: (event: EventicleEvent) => Promise<void>;
        onError: (error: any) => void;
    } | {
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
 * Convert {@link EventicleEvent} to/ from {@link EncodedEvent}.
 *
 * EncodedEvent is suitable for the {@link EventClient} implementations to send on the wire, as it
 * is a Buffer and a set of message headers.
 */
export declare interface EventClientCodec {
    /**
     * Convert a raw event binary (as a {@link EncodedEvent}) into a {@link EventicleEvent}
     */
    encode: (event: EventicleEvent) => Promise<EncodedEvent>;
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

export declare function eventClientOnKafka(config: KafkaConfig, consumerConfig?: ConsumerConfigFactory): Promise<EventClient>;

export declare interface EventicleEvent {
    id?: string;
    type: string;
    source?: string;
    causedById?: string;
    causedByType?: string;
    stream?: string;
    domainId?: string;
    createdAt?: number;
    data: any;
}

export declare function eventSourceName(): string;

declare interface EventSubscriptionControl {
    close: () => Promise<void>;
}

export declare interface EventView {
    consumerGroup: string;
    handleEvent: (event: EventicleEvent) => Promise<void>;
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
    events: EventEmitter;
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
    events: EventEmitter;
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

export declare interface RawEventView {
    consumerGroup: string;
    handleEvent: (event: EncodedEvent) => Promise<void>;
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
 * A saga!
 */
export declare class Saga<TimeoutNames, InstanceData> {
    readonly name: string;
    streams: string[];
    streamSubs: EventSubscriptionControl[];
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
    startOn<T extends EventicleEvent>(eventName: string, config: StartHandlerConfig<T, InstanceData, TimeoutNames>, handler: (saga: SagaInstance<TimeoutNames, InstanceData>, event: T) => Promise<void>): Saga<TimeoutNames, InstanceData>;
    on<T extends EventicleEvent>(eventName: string, config: HandlerConfig<T, InstanceData, TimeoutNames>, handler: (saga: SagaInstance<TimeoutNames, InstanceData>, event: T) => Promise<void>): Saga<TimeoutNames, InstanceData>;
    onError(handler: (saga: any, event: EventicleEvent, error: Error) => Promise<void>): Saga<TimeoutNames, InstanceData>;
}

export declare function saga<TimeoutNames, SagaInstanceData>(name: string): Saga<TimeoutNames, SagaInstanceData>;

/**
 * The data for a single execution of a {@link Saga}
 *
 * Sagas are stateful concepts, and this type contains the state.
 */
export declare class SagaInstance<TimeoutNames, T> {
    readonly internalData: any;
    readonly record?: Record_2;
    /**
     * Private instance data
     */
    readonly timersToRemove: TimeoutNames[];
    /**
     * Private instance data
     */
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
     * Get a piece of arbitrary data from the saga instance
     * @param name THe key
     */
    get<K extends keyof T>(name: K): T[K];
    /**
     * Set a piece of arbitrary data into the saga instance
     * @param name The key
     * @param value the value. Must be able to encode to JSON.
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

export { TransactionData }

export { TransactionListener }

export { TransactionOptions }

export { }
