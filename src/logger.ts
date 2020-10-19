'use strict';

// const httpContext = require('express-http-context');
const loggerApi = require('sexylog');

// as we're using a proxy logger (this file) we need to increment stack depth to log file/lien correctly
loggerApi.incrementStackDepth(1);

// Wrap logger to print reqId in each log
var formatMessage = function(message) {
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
  log: function(message, obj?) {
    // eslint-disable-next-line no-console
    // eslint-disable-next-line no-console
    loggerApi.info(formatMessage(message), obj)
  },
  error: function(message, err?) {
    if (!err) err = '';
    const messageAndObj = err ? message + ': ' + stringify(err) : message;
    loggerApi.error(formatMessage(messageAndObj), err);
  },
  warn: function(message, obj?) {
    const messageAndObj = obj ? message + ': ' + stringify(obj) : message;
    loggerApi.warn(formatMessage(messageAndObj));
  },
  verbose: function(message, obj?) {
    loggerApi.info(formatMessage(message), obj);
  },
  info: function(message, obj?) {
    if (!obj) obj = '';
    const messageAndObj = obj ? message + ': ' + stringify(obj) : message;
    loggerApi.info(formatMessage(messageAndObj));
  },
  debug: function(message, obj?) {
    if (!obj) obj = '';
    const messageAndObj = obj ? message + ': ' + stringify(obj) : message;
    loggerApi.debug(formatMessage(messageAndObj));
  },
  trace: function(message, obj?) {
    if (!obj) obj = '';
    const messageAndObj = obj ? message + ': ' + stringify(obj) : message;
    loggerApi.trace(formatMessage(messageAndObj));
  },
  rainbow: function(message, obj?) {
    if (!obj) obj = '';
    const messageAndObj = obj ? message + ': ' + stringify(obj) : message;
    loggerApi.rainbow(formatMessage(messageAndObj));
  },
  close: function(callback) {

  },
};
