import {eventClient, EventicleEvent} from "../core/event-client";
import {span} from "../../apm";

const COMMAND = new Map<string, Command<any>>()

export interface CommandIntent {
  type: string,
  data: any
}

export interface Command<T> {
  type: string,
  streamToEmit: string,
  execute: (data: T) => Promise<CommandReturn>
}

export interface CommandReturn {
  events: EventicleEvent[]
  webError?: Error
}

export function registerCommand(command: Command<any>): void {
  COMMAND.set(command.type, command)
}

export async function dispatchCommand(commandIntent: CommandIntent): Promise<CommandReturn> {

  return await span(`Command ${commandIntent.type} - execute`, {}, async (span) => {
    if (span) span.setType("Command")

    let command = COMMAND.get(commandIntent.type)

    if (!command) throw new Error(`Command not found ${commandIntent.type}`)

    let event = await command.execute(commandIntent.data)

    if (event.events) {
      await eventClient().emit(event.events, command.streamToEmit)
    }

    return event
  })
}
