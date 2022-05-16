import {eventClient, EventicleEvent} from "../core/event-client";
import * as tenant  from "./tenant-command"
import {logger, span} from "@eventicle/eventicle-utilities";
import {serializeError} from "serialize-error";
import {dataStore} from "../../index";

export interface CommandIntent<T> {
  type: string,
  data: T
}

export interface Command<I, O> {
  type: string,
  streamToEmit: string,
  execute: (data: I) => Promise<CommandReturn<O>>
}

export interface CommandReturn<T> {
  response?: T,
  events: EventicleEvent[]
  webError?: Error
}

export function registerCommand<I, O>(command: Command<I, O>): void {
  tenant.registerCommand(command)
}

export async function dispatchCommand<T>(commandIntent: CommandIntent<T>): Promise<CommandReturn<T>> {
  return tenant.dispatchCommand({
    workspaceId: "single", data: commandIntent.data, type: commandIntent.type
  }, true)
}

/**
 * Dispatch a command directly, without a CommandIntent message in between.
 *
 * Cannot be distributed or load balanced, but requires less boilerplate.
 */
export async function dispatchDirectCommand<T>(command: () => Promise<CommandReturn<T>>, streamToEmit: string): Promise<T> {

  const ret = await dataStore().transaction(async () => {
      return span(`Command DYNAMIC - execute`, {}, async (span) => {
        if (span) span.setType("Command")

        try {

          const ret = await command()

          if (ret.events) {
            await eventClient().emit(ret.events, streamToEmit)
          }

          return ret
        } catch (e) {
          logger.error("An untrapped error occurred in a command " + e.message, {
            error: serializeError(e)
          })
          throw e
        }
      })
  })

  if (ret.webError) throw ret.webError

  return ret.response
}
