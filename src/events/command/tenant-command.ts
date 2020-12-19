import {eventClient, EventicleEvent} from "../core/event-client";
import {span} from "../../apm";
import logger from "../../logger";
import {serializeError} from "serialize-error";
import {Command, CommandReturn} from "./index";

const COMMAND = new Map<string, Command<any>>()

export interface TenantCommandIntent<T> {
  workspaceId: string
  type: string
  data: T
}

export interface TenantCommand<T> {
  type: string,
  streamToEmit: string,
  execute: (intent: TenantCommandIntent<T>) => Promise<CommandReturn>
}


export function registerCommand(command: Command<any>): void {
  COMMAND.set(command.type, command)
}

export async function dispatchCommand(commandIntent: TenantCommandIntent<any>): Promise<CommandReturn> {

  return await span(`Command ${commandIntent.type} - execute`, {}, async (span) => {
    if (span) span.setType("Command")

    let command = COMMAND.get(commandIntent.type)

    if (!command) throw new Error(`Command not found ${commandIntent.type}`)

    let str = commandIntent.workspaceId + "." + command.streamToEmit

    if (commandIntent.workspaceId === "single") {
      str = command.streamToEmit
    }

    try {
      let event = await command.execute(commandIntent)
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
