import {EventicleEvent} from "./events/core/event-client";
import {logger, loggerUtil} from "@eventicle/eventicle-utilities";

function logEventInternal(level: string, text: string, event: EventicleEvent, extraData?: any, addToContext?: string[], addToMessage?: string[]) {

  let logData = loggerUtil.maybeRenderError(extraData)

  loggerUtil.maybeInsertContext(logData, event, ...addToContext)

  text = loggerUtil.maybeInsertInlineContext(text, event, ...addToMessage)

  logger.info(text, {
    contextDataAdded: true,
    stackDepth: 4,
    ...logData })
}

export function logEventError(text: string, event: EventicleEvent, extraData?: any) {
  logEventInternal("error", text, event, extraData)
}

export function logEventWarn(text: string, event: EventicleEvent, extraData?: any) {
  logEventInternal("warn", text, event, extraData)
}

export function logEvent(text: string, event: EventicleEvent, extraData?: any) {
  logEventInternal("info", text, event, extraData)
}
