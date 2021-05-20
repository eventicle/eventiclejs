'use strict';

import { handleNestedContextualError, handleTopLevelContextualError, isError, maybeInsertInlineContext } from "./logger-util";
import * as winston from "winston";

export interface LogApi {
  error(message: string, arg?: any)
  info(message: string, arg?: any)
  warn(message: string, arg?: any)
  trace(message: string, arg?: any)
  debug(message: string, arg?: any)
  rainbow(message: string, arg?: any)
}

export function setLogApi(log: LogApi) {
  loggerApi = log
}

let loggerApi: LogApi = {
  debug(message: string, arg?: any) {
    console.log(`DEBUG: ${message}: ${JSON.stringify(arg)}`)
  },
  error(message: string, arg?: any) {
    console.log(`ERROR: ${message}: ${JSON.stringify(arg)}`)
    console.log(new Error().stack)
  },
  info(message: string, arg?: any) {
    console.log(`INFO: ${message}: ${JSON.stringify(arg)}`)
  },
  rainbow(message: string, arg?: any) {
    console.log(`RAINBOW: ${message}: ${JSON.stringify(arg)}`)
  },
  trace(message: string, arg?: any) {
    console.log(`TRACE: ${message}: ${JSON.stringify(arg)}`)
  },
  warn(message: string, arg?: any) {
    console.log(`WARN: ${message}: ${JSON.stringify(arg)}`)
  }
}

// Wrap logger to print reqId in each log
var formatMessage = function (message) {
  // var reqId = httpContext.get('reqId');
  // const sessionId = httpContext.get('sessionId');
  // const logReqId = reqId ? 'rid:' + reqId : '';
  // const logSessionId = sessionId ? 'sid:' + sessionId : '';
  // message = logReqId || logSessionId ? `[${logReqId}|${logSessionId}] ${message}` : `${message}`;
  return message;
};

function stringify(obj) {
  try {
    return JSON.stringify(obj);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.log('error stringifying object for logger, by-passing..');
    return `error converting obj to string ${err.message}`;
  }
}


export default {
  log: function (message, obj?) {
    // eslint-disable-next-line no-console
    // eslint-disable-next-line no-console
    loggerApi.info(formatMessage(message), obj)
  },
  error: function (message, err?) {
    if (!err) err = '';
    const messageAndObj = err ? message + ': ' + stringify(err) : message;
    loggerApi.error(formatMessage(messageAndObj), err);
  },
  warn: function (message, obj?) {
    const messageAndObj = obj ? message + ': ' + stringify(obj) : message;
    loggerApi.warn(formatMessage(messageAndObj));
  },
  verbose: function (message, obj?) {
    loggerApi.info(formatMessage(message), obj);
  },
  info: function (message, obj?) {
    if (!obj) obj = '';
    const messageAndObj = obj ? message + ': ' + stringify(obj) : message;
    loggerApi.info(formatMessage(messageAndObj));
  },
  debug: function (message, obj?) {
    if (!obj) obj = '';
    const messageAndObj = obj ? message + ': ' + stringify(obj) : message;
    loggerApi.debug(formatMessage(messageAndObj));
  },
  trace: function (message, obj?) {
    if (!obj) obj = '';
    const messageAndObj = obj ? message + ': ' + stringify(obj) : message;
    loggerApi.trace(formatMessage(messageAndObj));
  },
  rainbow: function (message, obj?) {
    if (!obj) obj = '';
    const messageAndObj = obj ? message + ': ' + stringify(obj) : message;
    loggerApi.rainbow(formatMessage(messageAndObj));
  },
  close: function (callback) {

  },
};


export function createLogger(loglevel: string, addFromInfo: string[]) {
  return winston.createLogger({
    level: loglevel,
    format: winston.format.combine(
      {
        transform: (info: any) => {
          if (info[0]) {
            if (isError(info[0])) {
              info[0] = handleTopLevelContextualError(info[0]);
            } else if (info[0].hasOwnProperty("error") && isError(info[0].error)) {
              info[0] = handleNestedContextualError(info[0]);
            }
          }
          info.filename = info.file
          let msg = `[${info.filename.substring((info.filename as string).lastIndexOf("/") + 1)}:${info.lineno}] ` + info.message
          if (!info.contextDataAdded) {
            msg = maybeInsertInlineContext(msg, info, ...addFromInfo)
          }
          delete info["contextDataAdded"]
          if (info[0]) {
            delete info[0]["contextDataAdded"]
          }
          delete info["file"]
          return {
            ...info,
            message: msg,
            level: info.level
          }
        }
      },
      winston.format.colorize({
        all: true
      }), winston.format.simple()
    ),
    transports: [
      new winston.transports.Console()
    ]
  })
}