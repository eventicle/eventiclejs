# Eventicle PR #32 Review Analysis

## Item 1: "Release API-doc generation silently skips extraction"

**Reviewer claim:** The `api` script uses `yarn` but workflows use `npm`. In a worktree `npm run api` prints `sh: yarn: command not found` but exits 0 because later commands after `;` still ran.

**Actual code:**
```json
"api": "yarn tsc && api-extractor run;api-documenter yaml -i tmp/api -o tmp/api-yaml;api-documenter-yaml-to-antora-asciidoc asciidoc -i tmp/api-yaml"
```

**Verdict: VALID but partially wrong on mechanism.**

The script starts with `yarn tsc &&` — if yarn isn't installed, that fails and `&&` prevents `api-extractor` from running. But the semicolons after `api-extractor run` mean those later commands run regardless of earlier exit codes. So if `api-extractor` fails (not yarn), the downstream doc generation still runs against stale `tmp/api`.

The real issue is simpler: **the script says `yarn tsc` but CI uses `npm`**. Since CI already runs `npm run build-ts` (which is `tsc`) before `npm run api`, the `yarn tsc` inside `api` is redundant but will fail if yarn isn't available. The fix is:

1. Replace `yarn tsc` with `tsc` (or remove it since build already ran)
2. Replace `;` with `&&` throughout so failures propagate

The `test` script also says `yarn unit-test && yarn integration-test` — same problem.

**Fix needed: Yes.** Replace yarn refs with npm/npx, chain with `&&`.

---

## Item 2: "`coldHotStream.close()` leaves health stuck as connected"

**Reviewer claim:** `coldHotStream` marks `healthStatus` connected but its `close()` only disconnects and removes the group — never flips health back. `hotStreamInternal.close()` does this correctly.

**Actual code (new):**

`coldHotStream` close handler (line ~307):
```ts
close: async () => {
  await cons.disconnect()
  consumerGroups = consumerGroups.filter(value => value !== config.groupId)
}
```

`hotStreamInternal` close handler (line ~664):
```ts
close: async () => {
  // ... optional group deletion ...
  await cons.disconnect()
  healthStatus.healthy = false
  healthStatus.status = "disconnected"
  consumerGroups = consumerGroups.filter(value => value !== config.consumerName)
}
```

**Verdict: VALID.** The hot stream close correctly resets health; the coldHot stream close does not. After closing a coldHotStream, `consumerGroupHealth[name]` retains `{healthy: true, status: "connected"}`, which means `getKafkaClientHealth()` reports the system as healthy when a consumer is actually gone.

**Fix needed: Yes.** Add `healthStatus.healthy = false; healthStatus.status = "disconnected"` to the coldHotStream close handler.

---

## Item 3: "Consumer health no longer reflects runtime disconnect/crash"

**Reviewer claim:** The old `setupMonitor` tracked `consumer.crash`, `consumer.disconnect`, `consumer.stop` events. The new code only sets health during startup and explicit close.

**Actual situation:**

The old code used kafkajs's `cons.on("consumer.crash", ...)` etc. The confluent KafkaJS compat layer's `Consumer` type is:
```ts
type Consumer = Client & {
  subscribe(...): Promise<void>
  stop(): Promise<void>
  run(config?: ConsumerRunConfig): Promise<void>
  // ... no .on() method exposed
}
```

The confluent consumer does NOT expose a public `.on()` method in the KafkaJS compat layer types. Internally it uses `this.#internalClient.on('ready', ...)` etc., but these are private. The only events surfaced to userland are via the `logger` option.

**Verdict: PARTIALLY VALID, but the fix the reviewer suggests may not be feasible.**

The observation is correct: health is only set at startup and explicit close. Runtime disconnects/crashes won't flip health. But the suggested fix ("wire Confluent-compatible lifecycle/error callbacks") isn't straightforward — the compat layer doesn't expose consumer lifecycle events the way kafkajs did.

The realistic options are:
- Accept this as a known regression and document it
- Implement periodic health polling (try a metadata request or check consumer assignment)
- Use the `logger` to detect error patterns (fragile)

Given that the health check was already imperfect (kafkajs events could race), and the confluent client has its own internal reconnect logic, this is a **known limitation to document** rather than a blocking fix. If the consumer truly crashes, `eachMessage` stops being called, and the service's liveness probe (which checks other things) should eventually catch it.

**Fix needed: Partial.** Document the limitation. Optionally add a periodic heartbeat check. Not blocking for merge.

---

## Item 4: "Health is marked connected before subscribe/run succeed"

**Reviewer claim:** Both hot paths set `healthStatus.healthy = true` before `subscribe()` and `run()`. If subscribe fails, health retains a connected entry.

**Actual code (coldHotStream, inside `connectConsumerWithOptionalCreation` callback):**
```ts
await connectConsumerWithOptionalCreation(config.stream, cons, async (retry) => {
  healthStatus.healthy = true          // <-- set BEFORE subscribe/run
  healthStatus.status = "connected"

  const topics = ...
  await cons.subscribe({topics, replace: retry})
  // ... run ...
})
```

Same pattern in `hotStreamInternal`.

**Verdict: VALID.** If `cons.subscribe()` or `cons.run()` throws, the health entry stays as connected. However, `connectConsumerWithOptionalCreation` catches the first failure and retries with topic creation. If the retry also fails, it throws — but the health entry is already set.

In the old code, `setupMonitor` handled this via the `consumer.connect` event, which only fired after successful connection. The new code sets it optimistically.

**Fix needed: Yes.** Move health assignment after `cons.run()` succeeds. Wrap in try/catch to reset on failure.

---

## Item 5: "Custom consumer config is silently dropped"

**Reviewer claim:** The old code spread `...newConf`; the new code cherry-picks only a few fields. Custom `ConsumerConfigFactory` settings are now ignored.

**Old code:**
```ts
let cons = kafka.consumer({
  groupId: newConf.groupId || config.consumerName,
  ...newConf   // <-- spreads ALL factory-returned fields
})
```

**New code:**
```ts
let cons = kafka.consumer({
  kafkaJS: filterUndefined({
    groupId: newConf.groupId || config.consumerName,
    fromBeginning: false,
    autoCommit: true,
    autoCommitInterval: 500,
    sessionTimeout: newConf.sessionTimeout,
    rebalanceTimeout: newConf.rebalanceTimeout,
    heartbeatInterval: newConf.heartbeatInterval,
    maxWaitTimeInMs: newConf.maxWaitTimeInMs,
  })
} as any)
```

**Verdict: VALID.** The old code passed through everything the factory returned (retry config, maxBytes, rackId, etc.). The new code only picks 4 fields from the factory output. Anyone who customised their `ConsumerConfigFactory` to return additional fields (e.g. `maxBytesPerPartition`, `retry`, `maxInFlightRequests`) silently loses those settings.

The confluent `ConsumerConfig` interface supports: `metadataMaxAge`, `sessionTimeout`, `rebalanceTimeout`, `heartbeatInterval`, `maxBytesPerPartition`, `minBytes`, `maxBytes`, `maxWaitTimeInMs`, `retry`, `logLevel`, `logger`, `allowAutoTopicCreation`, `maxInFlightRequests`, `readUncommitted`, `rackId`, `fromBeginning`, `autoCommit`, `autoCommitInterval`, `partitionAssigners`, `partitionAssignors`.

The reviewer also notes `allowAutoTopicCreation: true` in the default factory is dead — it's set in the default factory but never passed through. This is correct.

**Fix needed: Yes.** Spread the factory output (filtering only truly incompatible fields) rather than cherry-picking. The simplest fix:
```ts
let cons = kafka.consumer({
  kafkaJS: filterUndefined({
    ...newConf,
    groupId: newConf.groupId || config.consumerName,
    fromBeginning: false,  // or true for coldHot
    autoCommit: true,
    autoCommitInterval: 500,
  })
} as any)
```

---

## Summary

| # | Issue | Valid? | Fix priority |
|---|-------|--------|-------------|
| 1 | yarn/npm + semicolons in scripts | Yes | P1 - trivial |
| 2 | coldHotStream close doesn't reset health | Yes | P1 - one line |
| 3 | No runtime health events (setupMonitor gone) | Partially - can't replicate kafkajs events in confluent | P3 - document |
| 4 | Health set before subscribe/run succeed | Yes | P2 - move + try/catch |
| 5 | Custom consumer config dropped | Yes | P1 - spread instead of cherry-pick |
