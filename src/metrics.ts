import {getViewMetrics} from "./events/view";
import {getAdapterMetrics} from "./events/adapter";
import {getSagaMetrics} from "./events/saga";

export function metrics() {
  return {
    "view-latency": getViewMetrics(),
    "adapter-latency": getAdapterMetrics(),
    "saga-latency": getSagaMetrics()
  }
}
