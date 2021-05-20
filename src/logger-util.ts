const stackTrace = require('stack-trace');
import * as winston from "winston";
import {LeveledLogMethod, Logger} from "winston";
import { EventicleEvent } from ".";
import { getApmCurrentTraceIds } from "./apm";
import logger from "./logger";
import { get, has } from 'lodash';



export function getFileNameAndLineNumber(numberOfLinesToFetch = 3) {
  const err = new Error('something went wrong');
  const trace = stackTrace.parse(err);

  let call = trace[numberOfLinesToFetch];

  if (!call) {
    console.log("THIS BROKE BAD")
    console.log({
      numberOfLinesToFetch, stackSize: trace.length
    })
    console.log(trace)
  }

  return {
    file: call.getFileName(),
    lineno: call.getLineNumber(),
    timestamp: new Date().toISOString()
  }
};

export function proxyLogger(logger: Logger, baseDirName: string) {
  return new Proxy(logger, {
    get(target: winston.Logger, prop: PropertyKey, receiver: any): any {
      if (["error", "warn", "info", "debug", "verbose"].includes(prop as any)) {

        let method = (target as any)[prop as any] as LeveledLogMethod
        return (message: string, ...meta: any[]) => {
          let stackDepth = 2
          if (meta.length > 0 && meta[0] && meta[0].hasOwnProperty("stackDepth")) {
            stackDepth = meta[0].stackDepth
            delete meta[0].stackDepth
          }
          const filename = getFileNameAndLineNumber(stackDepth)
          filename.file = filename.file.includes(baseDirName) ? filename.file.substring(baseDirName.length + 1) : filename.file;
          method(message, {...(getApmCurrentTraceIds()), ...meta, ...filename})
        }
      }
      return (target as any)[prop as any] as any;
    }
  })
}


export function handleTopLevelContextualError(info: any) {
  info = {
    ...info,
    ...maybeRenderError(info)
  }

  delete info["stack"]
  delete info["name"]
  info.message = info.error.message
  return info;
}

export function handleNestedContextualError(info: any) {
  info = {
    ...info,
    ...maybeRenderError(info.error)
  }
  return info;
}

export function maybeInsertInlineContext(message: string, source: any, ...fields: string[]): string {
  return fields.reduce((acc, currVal) => {
    if (has(source, currVal)) {
      return acc + ` [${currVal}=${get(source, currVal)}]`
    }

    return acc;
  }, message)
}

function maybeInsertContext(context: any, source: any, ...fields: string[]) {
  fields.forEach (field => { 
    if (has(source, field)) {
      context[field] = get(source, field);
    }
  });

  return context;
}

export function isError(data: any): data is Error {
  return data && data.stack && data.message
}

export function maybeRenderError(data: any) {
  if (isError(data)) {
    // it's an error, probably
    return {
      error: {
        ...data,
        message: data.message,
        name: data.name,
        stack: stackTrace.parse(data).map((val: any) => `${val.getFileName()}:${val.getLineNumber()}`).join("\n")
      }
    }
  }

  return { ...data }
}

function logEventInternal(level: string, text: string, event: EventicleEvent, extraData?: any, addToContext?: string[], addToMessage?: string[]) {

  let logData = maybeRenderError(extraData)

  maybeInsertContext(logData, event, ...addToContext)

  text = maybeInsertInlineContext(text, event, ...addToMessage)

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
