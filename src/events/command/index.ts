import {EventicleEvent} from "../core/event-client";
import * as tenant  from "./tenant-command"

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
  response?: any
  events: EventicleEvent[]
  webError?: Error
}

export function registerCommand(command: Command<any>): void {
  tenant.registerCommand(command)
}

export async function dispatchCommand(commandIntent: CommandIntent): Promise<CommandReturn> {
  return tenant.dispatchCommand({
    workspaceId: "single", data: commandIntent.data, type: commandIntent.type
  })
}
