
export { EventicleEvent, setEventClient, eventClient, setEventSourceName, eventSourceName, EventClientCodec, setEventClientCodec, EncodedEvent } from "./events/core/event-client";
export { eventClientOnDatastore } from "./events/core/eventclient-datastore";
export { eventClientOnKafka, connectBroker } from "./events/core/eventclient-kafka";
export {default as aggregates, AggregateRoot} from "./events/aggregate-root";

export { dispatchCommand, registerCommand, Command, CommandIntent, CommandReturn } from "./events/command";
export { registerView, EventView } from "./events/view";
export { registerSaga, saga, SagaInstance, allSagaInstances, allSagas, removeAllNotifyIntents, removeAllSagas } from "./events/saga";
export { default as InMemoryDatastore } from "./datastore/inmem-data-store"
export { DataStore, Record, setDataStore, dataStore } from "./datastore/index"
export { setLogApi } from "./logger"
export { aggregateObservationAdapter, createAggregateObservationAdapter, aggregateObserver} from "./events/adapter/AggregateObservationAdapter"
export { EventAdapter, registerAdapter } from "./events/adapter"
export { LogApi } from "./logger"
export { consumeFullEventLog } from "./testing"
export { metrics } from "./metrics"
export { lockManager, setLockManager } from "./events/lock-manager"

import * as apm from "./apm";

export {
  apm
}
