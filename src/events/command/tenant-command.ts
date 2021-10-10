import {eventClient, EventicleEvent} from "../core/event-client";
import {logger, span} from "@eventicle/eventicle-utilities";
import {serializeError} from "serialize-error";
import {Command, CommandReturn} from "./index";
import {lockManager} from "../../";
import {dataStore} from "../../";

const COMMAND = new Map<string, Command<any, any>>()

export interface TenantCommandIntent<T> {
  workspaceId: string
  type: string
  lock?: string
  data: T
}

export interface TenantCommand<I, O> {
  type: string,
  streamToEmit: string,
  execute: (intent: TenantCommandIntent<I>) => Promise<CommandReturn<O>>
}


export function registerCommand<I, O>(command: Command<I, O>): void {
  COMMAND.set(command.type, command)
}

export async function dispatchCommand<I, O>(commandIntent: TenantCommandIntent<I>, dataOnly = false): Promise<CommandReturn<O>> {

  let exec = async () => {
    return await span(`Command ${commandIntent.type} - execute`, {}, async (span) => {
      if (span) span.setType("Command")

      let command = COMMAND.get(commandIntent.type)

      if (!command) throw new Error(`Command not found ${commandIntent.type}`)

      let str = commandIntent.workspaceId + "." + command.streamToEmit

      if (commandIntent.workspaceId === "single") {
        str = command.streamToEmit
      }

      try {
        let event
        if (dataOnly) {
          event = await command.execute(commandIntent.data)
        } else {
          event = await command.execute(commandIntent)
        }
        if (event.events) {
          await eventClient().emit(event.events, str)
        }

        return event
      } catch (e) {
        logger.error("An untrapped error occured in a command " + e.message, {
          commandIntent, error: serializeError(e)
        })
        throw e
      }
    })
  }

  return await dataStore().transaction(async () => {
    if (commandIntent.lock) {
      return await lockManager().withLock(commandIntent.lock, async () => {
        return await exec()
      }, () => {
        logger.warn("Failed locking command during execution")
      })
    } else {
      return await exec()
    }
  })
}
