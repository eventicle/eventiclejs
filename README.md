# EventicleJS

> A powerful TypeScript framework for building event-driven, domain-driven applications with Event Sourcing and CQRS patterns

EventicleJS is an opinionated library for building distributed, event-based Node.js applications using Domain-Driven Design principles. Start with an in-memory implementation and seamlessly scale to production with Kafka, Redis, and PostgreSQL.

## Why EventicleJS?

- **Event Sourcing Made Simple**: Store your domain state as a sequence of events, enabling complete audit trails and time-travel debugging
- **CQRS Built-in**: Separate read and write models for optimal performance and scalability
- **Domain-Driven Design**: Aggregate Roots, Commands, Sagas, and Views as first-class concepts
- **Production-Ready Adapters**: Start in-memory, deploy with Kafka, Redis, or PostgreSQL
- **Type-Safe**: Full TypeScript support with comprehensive type definitions
- **XState Integration**: Model complex aggregate behavior with state machines
- **Saga Orchestration**: Build resilient, long-running workflows with built-in compensation patterns

## Quick Start

### Installation

```bash
npm install @eventicle/eventiclejs
```

or

```bash
yarn add @eventicle/eventiclejs
```

### Basic Setup

```typescript
import {
  setEventSourceName,
  eventClientOnDatastore,
  InMemoryDatastore,
  setDataStore,
  setEventClient,
  eventClient
} from '@eventicle/eventiclejs';

// Set your application name
setEventSourceName('my-cool-service');

// Configure storage (start with in-memory)
setDataStore(new InMemoryDatastore());

// Connect to event transport
setEventClient(eventClientOnDatastore());
```

### Emit Events

```typescript
await eventClient().emit([
  {
    type: "user.created",
    data: {
      userName: "John Doe",
      email: "john@example.com"
    }
  }
], "users");
```

### Observe Events

```typescript
// Subscribe to live events
eventClient().hotStream("users", "my-consumer",
  async (event) => {
    console.log("Received event:", event.type);
    console.log(event.data);
  },
  error => console.error("Error:", error)
);
```

### Replay Event History

```typescript
// Replay all historical events, then continue observing
await eventClient().coldStream("users",
  async (event) => {
    console.log("Processing event:", event.type);
  },
  error => console.error("Error:", error),
  () => console.log("Historical replay complete")
);
```

## Core Concepts

### Aggregate Roots
Event-sourced domain entities that enforce business rules and generate events:

```typescript
import { AggregateRoot } from "@eventicle/eventiclejs";

class BankAccount extends AggregateRoot {
  balance: number = 0;

  constructor() {
    super("bank-accounts", []);
    this.reducers = {
      AccountOpened: (event) => {
        this.id = event.payload.accountId;
        this.balance = event.payload.initialDeposit;
      },
      MoneyDeposited: (event) => {
        this.balance += event.payload.amount;
      }
    };
  }

  deposit(amount: number) {
    this.raiseEvent({
      type: "MoneyDeposited",
      payload: { amount }
    });
  }
}
```

### Commands
Handle requests and emit events:

```typescript
import { command } from "@eventicle/eventiclejs";

export const depositCommand = command("DepositMoney")
  .hasIntent<{ accountId: string; amount: number }>()
  .handle(async (deps, intent) => {
    const account = await deps.aggregates.load(BankAccount, intent.accountId);
    account.deposit(intent.amount);
    return await deps.aggregates.persist(account);
  });
```

### Sagas
Orchestrate complex workflows across aggregates:

```typescript
import { saga } from "@eventicle/eventiclejs";

export function paymentSaga() {
  return saga("PaymentProcessing")
    .subscribeStreams(["orders", "payments"])
    .startOn("OrderCreated", async (instance, event) => {
      await processPayment(event.payload);
    })
    .on("PaymentSucceeded", async (instance, event) => {
      await completeOrder(event.payload.orderId);
      instance.complete();
    });
}
```

### Views
Build optimized read models from event streams:

```typescript
import { view } from "@eventicle/eventiclejs";

export const accountView = view("AccountView")
  .on("AccountOpened", async (event, deps) => {
    await deps.dataStore.put("accounts", event.payload.accountId, {
      balance: event.payload.initialDeposit,
      status: "active"
    });
  })
  .on("MoneyDeposited", async (event, deps) => {
    const account = await deps.dataStore.get("accounts", event.payload.accountId);
    account.balance += event.payload.amount;
    await deps.dataStore.put("accounts", event.payload.accountId, account);
  });
```

## Production Deployment

Switch to production-ready backends with minimal code changes:

### Kafka + PostgreSQL

```typescript
import { kafkaEventClient } from "@eventicle/eventicle-kafka-adapter";
import { postgresDataStore } from "@eventicle/eventicle-postgres-adapter";

setDataStore(postgresDataStore({
  host: "localhost",
  database: "myapp",
  user: "postgres",
  password: "password"
}));

setEventClient(kafkaEventClient({
  brokers: ["localhost:9092"],
  clientId: "my-cool-service"
}));
```

## Documentation

📚 **[Book of Eventicle](https://eventicle.org)** - Complete guides, tutorials, and API documentation

### Key Topics

- [Installation & Setup](https://eventicle.org/eventiclejs/book/installation.html)
- [Aggregate Roots](https://eventicle.org/eventiclejs/book/aggregate-roots.html)
- [Commands](https://eventicle.org/eventiclejs/book/commands.html)
- [Sagas](https://eventicle.org/eventiclejs/book/sagas.html)
- [Views](https://eventicle.org/eventiclejs/book/query.html)
- [Event Adapters](https://eventicle.org/eventiclejs/book/event-clients.html)
- [Testing](https://eventicle.org/eventiclejs/book/testing.html)

## Features

✅ Event Sourcing with aggregate roots
✅ CQRS with commands and views
✅ Saga orchestration for workflows
✅ XState integration for state machines
✅ Multiple storage backends (Memory, PostgreSQL)
✅ Multiple event transports (Memory, Kafka, Redis)
✅ Built-in testing utilities
✅ TypeScript-first with full type safety
✅ Distributed locking
✅ Event schema evolution
✅ Time-based scheduling

## Requirements

- Node.js 16.x or higher
- TypeScript 4.x or higher (for development)

## License

Apache-2.0

## Contributing

Contributions are welcome! Please visit our [GitHub repository](https://github.com/eventicle/eventiclejs) for issues and pull requests.

## Support

- 📖 [Documentation](https://eventicle.org)
- 💬 [GitHub Discussions](https://github.com/eventicle/eventiclejs/discussions)
- 🐛 [Issue Tracker](https://github.com/eventicle/eventiclejs/issues)
