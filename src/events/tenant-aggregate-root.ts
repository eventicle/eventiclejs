import { EventicleEvent } from "./core/event-client";
import { dataStore } from "../";
import { logger } from "@eventicle/eventicle-utilities";
import { lockManager } from "./../";
import { AggregateConfig, AggregateRoot } from "./aggregate-root";
import { DataSorting, Query } from "@eventicle/eventicle-utilities/dist/datastore";

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

export type BulkQuery<T> = {
  type: { new (type?: string | AggregateConfig): T },
  init?: string | AggregateConfig,
  tenant?: string
  filter?: Query
  sort?: DataSorting,
  page?: number
  pageSize?: number
}

export type BulkResponse<T> = {
  totalCount: number;
  pageInfo: {
    currentPage: number;
    pageSize: number;
  };
  entries: T[];
}

type LoadBulk = {
  <T extends AggregateRoot>(config: BulkQuery<T>): Promise<BulkResponse<T>>
  <T extends AggregateRoot>(type: { new (type?: string | AggregateConfig): T },
   tenant: string,
   filter?: Query,
   page?: number,
   pageSize?: number): Promise<BulkResponse<T>>
}

export interface TenantAggregateRepository {
  /**
   * Replay and build an aggregate root into its current state.
   * @param emptyInstance
   * @param tenant the tenantId
   * @param id
   */
  load: <T extends AggregateRoot>(emptyInstance: T, tenant: string, id: string) => Promise<T>
  /**
   * Load bulk aggregate instances, according to the given query. Overloaded for backwards-compatibility.
   */
  loadBulk: LoadBulk
  /**
   * Obtain the full stream of events that make up the history of an aggregate root.
   * @param type
   * @param id
   */
  history: <T extends AggregateRoot>(type: string, tenant: string, id: string) => Promise<EventicleEvent[]>
  /**
   * Persist an aggregate to the datastore.
   * @param aggregate
   * @param tenant
   */
  persist: <T extends AggregateRoot>(aggregate: T, tenant: string) => Promise<EventicleEvent[]>
}

export default {
  load:  async <T extends AggregateRoot>(
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

  loadBulk: async <T extends AggregateRoot>(...args) => {
    let type
    let init = null
    let filter: Query = {}
    let sort: DataSorting
    let page, pageSize
    let tenant

    if(args.length > 1) {
      type = args[0]
      tenant = args[1]
      filter = args[2]
      page = args[3]
      pageSize = args[4]
      sort = {}
    } else {
      const conf = args[0]
      type = conf.type
      tenant = conf.tenant
      filter = conf.filter ?? {}
      page = conf.page ?? undefined
      pageSize = conf.pageSize ?? undefined
      init = conf.init ?? undefined
    }

    let t = new type(init);

    let instances = await dataStore().findEntityPaginated(
      tenant,
      eventstreamname(t.type),
      filter,
      sort,
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
            instance.content = maybeAddCheckpointState(aggregate, instance.content)
            await dataStore().saveEntity(
              tenant,
              eventstreamname(aggregate.type),
              instance
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
} as TenantAggregateRepository;
