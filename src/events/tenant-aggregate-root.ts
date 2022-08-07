import { EventicleEvent } from "./core/event-client";
import { dataStore } from "../";
import { logger } from "@eventicle/eventicle-utilities";
import { lockManager } from "./../";
import { AggregateRepository, AggregateRoot } from "./aggregate-root";
import {
  DataQuery,
  Query,
} from "@eventicle/eventicle-utilities/dist/datastore";

function eventstreamname<T extends AggregateRoot>(type: string) {
  return "aggregate-events-" + type;
}

async function hydrateAggregate(datastoreContent: any, aggregate: any) {
  datastoreContent.content.history.forEach((value) =>
    aggregate.handleEvent(value)
  );
  aggregate.history = datastoreContent.content.history;
  return aggregate;
}

function maybeAddCheckpointState(aggregate: AggregateRoot, content: any): any {
  if (!aggregate.config.storeCheckpoint) {
    return content;
  }
  content = { ...content, ...aggregate.currentCheckpoint() };

  return content;
}

export default {
  /**
   * Replay and build an aggregate root into its current state.
   * @param type
   * @param id
   */
  load: async <T extends AggregateRoot>(
    emptyInstance: T,
    tenant: string,
    id: string
  ): Promise<T> => {
    let ret = await dataStore().findEntity(
      tenant,
      eventstreamname(emptyInstance.type),
      { domainId: id }
    );
    if (ret && ret.length > 0) {
      emptyInstance.replaying = true;
      const agg = await hydrateAggregate(ret[0], emptyInstance);
      agg.replaying = false;
      return agg;
    }
    return null;
  },

  loadBulk: async <T extends AggregateRoot>(
    type: { new (): T },
    tenant: string,
    filter: Query,
    page: number,
    pageSize: number
  ): Promise<{
    totalCount: number;
    pageInfo: {
      currentPage: number;
      pageSize: number;
    };
    entries: T[];
  }> => {
    let t = new type();

    let instances = await dataStore().findEntityPaginated(
      tenant,
      eventstreamname(t.type),
      filter,
      {},
      page,
      pageSize
    );

    const aggregates = [];

    for (const instance of instances.entries) {
      const aggregate = new type();
      aggregate.replaying = true;
      await hydrateAggregate(instance, aggregate);
      aggregate.replaying = false;
      aggregates.push(aggregate);
    }

    return {
      entries: aggregates,
      totalCount: instances.totalCount,
      pageInfo: instances.pageInfo,
    };
  },

  /**
   * Obtain the full stream of events that make up the history of an aggregate root.
   * @param type
   * @param id
   */
  history: async <T extends AggregateRoot>(
    type: string,
    tenant: string,
    id: string
  ): Promise<EventicleEvent[]> => {
    let ret = await dataStore().findEntity(tenant, eventstreamname(type), {
      domainId: id,
    });

    if (ret && ret.length > 0) {
      return ret[0].content.history;
    }

    return null;
  },

  persist: async <T extends AggregateRoot>(
    aggregate: T,
    tenant: string
  ): Promise<EventicleEvent[]> => {
    return await dataStore().transaction(async () => {
      return await lockManager().withLock(
        tenant + aggregate.id,
        async () => {
          let ret = JSON.parse(JSON.stringify(aggregate.newEvents));
          aggregate.newEvents.length = 0;

          let entity = await dataStore().findEntity(
            tenant,
            eventstreamname(aggregate.type),
            { domainId: aggregate.id }
          );

          if (!entity || entity.length == 0) {
            let instance = {
              domainId: aggregate.id,
              history: ret,
            };

            await dataStore().createEntity(
              tenant,
              eventstreamname(aggregate.type),
              maybeAddCheckpointState(aggregate, instance)
            );
          } else {
            let instance = entity[0];
            instance.content.history.push(...ret);
            await dataStore().saveEntity(
              tenant,
              eventstreamname(aggregate.type),
              maybeAddCheckpointState(aggregate, instance)
            );
          }

          return ret;
        },
        () => {
          logger.warn("Failed to do the thing");
        }
      );
    });
  },
};
