import {saga} from "../../../../../../api/eventiclejs";

export interface SagaState {
  bt_id: string
}

export function myBtSaga() {
  return saga<"BTDLockTimeout", SagaState>("BTD Saga")
    .subscribeStreams(["bt", "btd"])
    .startOn("bt.created", {}, async (sagaInstance, event) => {
      sagaInstance.set("bt_id", event.data.bt_id)
    })
    .on("btda.locking", {
      matchInstance: ev => ({
          instanceProperty: "bt_id", value: ev.data.bt_id
        })
    }, async (sagaInstance, event) => {
      sagaInstance.upsertTimer("BTDLockTimeout", {
        isCron: false, timeout: 10000
      })
    })
    .onTimer("BTDLockTimeout", async saga1 => {
      // handle timeout
    })
    .on("btda.lock_failed", {
      matchInstance: ev => ev.data.bt_id
    }, async (sagaInstance, event) => {
      // handle lock failed
    })
}
