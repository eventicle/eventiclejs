import logger from "./logger";
import {EventicleEvent} from "./events/core/event-client";

let APM: ApmApi = {
  endTransaction: () => null,
  getCurrentTransaction: () => ({ startSpan: name => ({ addLabels: () => null, getCurrentTraceID: () => null, setType: type => null, end: () => {}}), traceparent: null}),
  getCurrentSpan: () => ({
    setType: type => null,
    getCurrentTraceID: () => null,
    addLabels: (val) => null,
    end: () => null
  }),
  startTransaction: (name, type, subtype, parent) => {

  }
}

interface Span {
  addLabels: (labels: any) => void
  setType: (type: string) => void
  getCurrentTraceID: () => string
  end: () => void
}

export interface ApmApi {
  getCurrentTransaction: () => { traceparent: string, startSpan: (name: string) => Span }
  getCurrentSpan: () => Span
  startTransaction: (name: string, type: string, subtype: string, parent: string) => void
  endTransaction: () => void
}

export function setEventicleApm(apm: ApmApi) {
  APM = apm
}

export function apmJoinEvent(event: EventicleEvent, name: string, type:string, subtype: string) {
  if (APM && event.hasOwnProperty("apmTrace")) {
    APM.startTransaction(name, type, subtype, (event as any).apmTrace)
  } else {
    logger.trace("Tried joining a distributed trace on an event that has no tracing", event)
  }
}

export function getApmTraceparent() {
  if (APM && APM.getCurrentSpan()) {
    return APM.getCurrentSpan().getCurrentTraceID()
  }
  if (APM && APM.getCurrentTransaction) {
    return APM.getCurrentTransaction().traceparent
  }
}

export async function withAPM(exec: (apm: ApmApi) => Promise<void>) {
  if (APM) {
    return await exec(APM)
  }
}


export async function span<T>(name: string, labels: { [key: string]: string }, exec: (span: Span) => Promise<T>): Promise<T> {
  let span
  if (APM && APM.getCurrentTransaction()) {
    span = APM.getCurrentTransaction().startSpan(name)
    span.addLabels(labels)
  }

  try {
    return await exec(span)
  } finally {
    if (span) {
      span.end()
    }
  }
}

export function elasticApmEventicle(apm): ApmApi {
  return {
    endTransaction: () => apm.endTransaction(),
    getCurrentTransaction: () => apm.currentTransaction,
    getCurrentSpan: () => ({
      setType: type => apm.currentSpan.setType(type),
      getCurrentTraceID: () => (apm.currentSpan.traceparent),
      addLabels: (val) => (apm.currentSpan.addLabels(val)),
      end: () => apm.currentSpan.end()
    }),
    startTransaction: (name, type, subtype, parent) => {
      apm.startTransaction(name, type, subtype, {
        childOf: parent
      })
    }
  }
}
