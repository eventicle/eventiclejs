import * as uuid from "uuid";
import {
  DataQuery,
  DataSorting,
  DataStore,
  PagedRecords,
  Record,
  TransactionData,
} from "../";
import { logger } from "@eventicle/eventicle-utilities";
import { als } from "asynchronous-local-storage";
import { EventEmitter } from "events";
import { Query } from "@eventicle/eventicle-utilities/dist/datastore";
import {filterTableUsingObjectComparison, isPrimitive, likeCompare, partialCompareObject} from "./object-query-util";

let tenants: any = {};

function getStoreForWorkspace(id: string) {
  if (!tenants[id]) {
    tenants[id] = {};
  }
  return tenants[id];
}

/**
 * In memory Datastore implementation.
 *
 * This is suitable for testing and single instance demonstration purposes.
 *
 * @see DataStore
 */
export default class implements DataStore {
  events = new EventEmitter();

  hasTransactionData(): boolean {
    return !!als.get("transaction.data");
  }

  on(
    event: "transaction.start" | "transaction.commit",
    listener: (name: string, data: TransactionData) => void
  ): this {
    this.events.addListener(event, (args) => {
      listener(event, args);
    });
    return this;
  }

  getTransactionData(): TransactionData {
    return als.get("transaction.data");
  }

  async transaction<T>(exec: () => Promise<T>): Promise<T> {
    const txId = uuid.v4();

    return await new Promise(async (res) => {
      als.runWith(async () => {
        const txData = {
          data: {},
          id: txId,
        } as TransactionData;
        als.set("transaction.data", txData);
        als.set("transaction.id", txId);

        this.events.emit("transaction.start", txData);

        res(
          exec().finally(async () => {
            this.events.emit("transaction.commit", txData);
            als.set("transaction", null);
            als.set("transaction.id", null);
            als.set("transaction.data", null);
          })
        );
      });
    });
  }

  /**
   *
   * @param {*} type Entity type or "table" name
   * @param {*} id
   */
  public getEntity(
    workspaceId: string,
    type: any,
    id: string
  ): Promise<Record> {
    const table = getStoreForWorkspace(workspaceId)[type];
    if (!table) return Promise.resolve(null);
    let dat = table[id];
    return Promise.resolve(JSON.parse(JSON.stringify(dat)));
  }

  /**
   *
   * @param workspaceId
   * @param {*} type Entity type or "table" name
   * @param {*} query  Json object to match fields
   * @param sorting
   */
  public async findEntity(
    workspaceId: string,
    type: any,
    query: Query,
    sorting: DataSorting = {}
  ): Promise<Record[]> {
    const table = getStoreForWorkspace(workspaceId)[type];
    if (!table) return [];
    const results: Record[] = filterTableUsingObjectComparison(table, query, val => val.content);

    let sorts = Object.keys(sorting);
    if (sorts.length > 0) {
      if (sorts.length > 1) {
        logger.warn(
          "Trying to sort with more than one key, InMemDatastore doesn't support this and will pick the first key ",
          {
            type,
            query,
            sorting,
            chosenKey: sorts[0],
          }
        );
      }
      results.sort((a, b) => {
        const p1 = a.content[sorts[0]];
        const p2 = b.content[sorts[0]];

        if (sorting[sorts[0]] === "DESC") {
          if (p1 > p2) return -1;
          if (p1 < p2) return 1;
          return 0;
        } else {
          if (p1 < p2) return -1;
          if (p1 > p2) return 1;
          return 0;
        }
      });
    }

    return results.map(value => JSON.parse(JSON.stringify(value)));
  }

  /**
   *
   * @param workspaceId
   * @param {*} type Entity type or "table" name
   * @param {*} query  Json object to match fields
   * @param sorting
   * @param {*} page page count
   * @param {*} pageSize page size
   */
  async findEntityPaginated(
    workspaceId: string,
    type: string,
    query: Query,
    sorting: DataSorting,
    page: number,
    pageSize: number
  ): Promise<PagedRecords> {
    const results = await this.findEntity(workspaceId, type, query, sorting);
    let startIndex = pageSize * page - pageSize;

    if (startIndex < 0) {
      startIndex = 0;
    }

    const endIndex = startIndex + pageSize;

    return {
      entries: results.slice(startIndex, endIndex).map(value => JSON.parse(JSON.stringify(value))),
      totalCount: results.length,
      pageInfo: {
        currentPage: page,
        pageSize,
      },
    };
  }

  /**
   *
   * @param {*} type Entity type or "table" name
   * @param {*} item
   */
  async createEntity(workspaceId: string, type: string, item: any) {
    if (item.id) {
      // log.info(item)
      throw new Error("ID is set, tihs is not allowed");
    }

    if (!getStoreForWorkspace(workspaceId)[type])
      getStoreForWorkspace(workspaceId)[type] = {};
    let id = uuid.v4();
    getStoreForWorkspace(workspaceId)[type][id] = {
      id,
      type,
      createdAt: new Date(),
      content: JSON.parse(JSON.stringify(item)),
    } as Record;
    return Promise.resolve(getStoreForWorkspace(workspaceId)[type][id]);
  }

  async saveEntity(workspaceId: string, type: string, item: Record) {
    if (!item.id) throw new Error("Failed to save, has no ID, use create");
    getStoreForWorkspace(workspaceId)[type][item.id] = JSON.parse(
      JSON.stringify(item)
    );
    return Promise.resolve(item);
  }

  async deleteEntity(
    workspaceId: string,
    type: string,
    id: string
  ): Promise<void> {
    if (!getStoreForWorkspace(workspaceId)[type]) return Promise.resolve();
    delete getStoreForWorkspace(workspaceId)[type][id];
    return Promise.resolve();
  }

  async deleteMany(
    workspaceId: string,
    type: string,
    query: Query
  ): Promise<void> {
    const results = await this.findEntity(workspaceId, type, query);
    results.map((result) => {
      delete getStoreForWorkspace(workspaceId)[type][result.id];
    });
  }

  async purge() {
    tenants = {};
  }
}
