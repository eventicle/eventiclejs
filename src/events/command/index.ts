import {EventicleEvent} from "../core/event-client";
import * as tenant  from "./tenant-command"

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
