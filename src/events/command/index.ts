import { eventClient, EventicleEvent } from "../core/event-client";
import * as tenant from "./tenant-command";
import { logger, span } from "@eventicle/eventicle-utilities";
import { serializeError } from "serialize-error";
import { dataStore } from "../../index";
import {TransactionOptions} from "@eventicle/eventicle-utilities/dist/datastore";

/**
 * A CommandIntent is a message instructing Eventicle to perform an action that
 * may emit events that should be sent externally using the {@link EventClient}
 */
export interface CommandIntent<T> {
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
 * A Command.
 *
 * It is generally preferred {@link dispatchDirectCommand} where the command
 * definition is implicit, and more fully type checked.
 *
 * This, along with {@link dispatchCommand} is available if you wish to separate
 * your code more fully, or introduce a remote capable message based command bus.
 */
export interface Command<I, O> {
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
 * The global return type for {@link Command}, whether the command is explicit, as in
 * {@link dispatchCommand}, or implicit, as in {@link dispatchDirectCommand}.
 *
 * This return type is passed to the caller, but before that happens, it will
 * be processed by the dispatcher to capture any events that need to be emitted.
 */
export interface CommandReturn<T> {
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
