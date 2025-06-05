import { eventClient, EventicleEvent } from "../core/event-client";
import * as tenant from "./tenant-command";
import { logger, span } from "@eventicle/eventicle-utilities";
import { serializeError } from "serialize-error";
import { dataStore } from "../../index";
import {TransactionOptions} from "@eventicle/eventicle-utilities/dist/datastore";

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
export interface CommandIntent<T> {
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
export interface Command<I, O> {
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
export interface CommandReturn<T> {
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

export function registerCommand<I, O>(command: Command<I, O>): void {
  tenant.registerCommand(command);
}

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
export async function dispatchCommand<T>(
  commandIntent: CommandIntent<T>
): Promise<CommandReturn<T>> {
  return tenant.dispatchCommand(
    {
      workspaceId: "single",
      data: commandIntent.data,
      type: commandIntent.type,
    },
    true
  );
}

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
export async function dispatchDirectCommand<T>(
  command: () => Promise<CommandReturn<T>>,
  streamToEmit: string,
  transactionControl?: TransactionOptions
): Promise<T> {
  const ret = await dataStore().transaction(async () => {
    return span(`Command DYNAMIC - execute`, {}, async (span) => {
      if (span) span.setType("Command");

      try {
        const ret = await command();

        if (ret.events) {
          await eventClient().emit(ret.events, streamToEmit);
        }

        return ret;
      } catch (e) {
        logger.error("An untrapped error occurred in a command " + e.message, {
          error: serializeError(e),
        });
        throw e;
      }
    });
  }, transactionControl);

  if (ret.webError) throw ret.webError;

  return ret.response;
}
