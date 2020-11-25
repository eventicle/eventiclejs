import * as uuid from 'uuid';
import {DataSorting, DataStore, PagedRecords, Record} from "./index";
import logger from "../logger";

let tenants:any = {};

function getStoreForWorkspace(id: string) {
  if (!tenants[id]) {
    tenants[id] = {}
  }
  return tenants[id]
}

export default class implements DataStore {
  /**
   *
   * @param {*} type Entity type or "table" name
   * @param {*} id
   */
  public getEntity(workspaceId: string, type: any, id: string): Promise<Record> {
    const table = getStoreForWorkspace(workspaceId)[type];
    if (!table) return Promise.resolve(null);
    let dat = table[id]
    return Promise.resolve(dat);
  }

  /**
   *
   * @param workspaceId
   * @param {*} type Entity type or "table" name
   * @param {*} query  Json object to match fields
   * @param sorting
   */
  public async findEntity(workspaceId: string, type: any, query: any, sorting: DataSorting = {}): Promise<Record[]> {
    const table = getStoreForWorkspace(workspaceId)[type];
    if (!table) return [];
    const results: any = [];
    Object.keys(table).forEach(id => {
      const entry = table[id];
      var fieldsAllMatch = true;
      Object.keys(query).forEach(key => {
        if (query[key] !== entry.content[key]) {
          fieldsAllMatch = false;
        }
      });
      if (fieldsAllMatch) {
        results.push(entry);
      }
    });

    let sorts = Object.keys(sorting)
    if (sorts.length > 0) {
      if (sorts.length > 1) {
        logger.warn("Trying to sort with more than one key, InMemDatastore doesn't support this and will pick the first key ", {
          type, query, sorting,
          chosenKey: sorts[0] })
      }
      results.sort((a, b) => {
        const p1 = a[sorts[0]];
        const p2 = b[sorts[0]];

        if (p1 < p2) return -1;
        if (p1 > p2) return 1;
        return 0;
      })
    }

    return results;
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
  async findEntityPaginated(workspaceId: string, type: any, query: any, sorting: DataSorting, page: number, pageSize: number): Promise<PagedRecords> {
    const results = await this.findEntity(workspaceId, type, query, sorting);
    const startIndex = pageSize * page;
    const endIndex = startIndex + pageSize;

    return {
      entries: results.slice(startIndex, endIndex),
      totalCount: results.length,
      pageInfo: {
        currentPage: page,
        pageSize
      }
    }
  }

  /**
   *
   * @param {*} type Entity type or "table" name
   * @param {*} item
   */
  async createEntity(workspaceId: string, type: any, item: any) {
    if (item.id) {
      // log.info(item)
      throw new Error("ID is set, tihs is not allowed")
    }

    if (!getStoreForWorkspace(workspaceId)[type]) getStoreForWorkspace(workspaceId)[type] = {};
    let id = uuid.v4();
    getStoreForWorkspace(workspaceId)[type][id] = {
      id,
      type,
      createdAt: new Date(),
      content: JSON.parse(JSON.stringify(item))
    } as Record
    return Promise.resolve(getStoreForWorkspace(workspaceId)[type][id]);
  }

  async saveEntity(workspaceId: string, type: any, item: Record) {
    if (!item.id) throw new Error("Failed to save, has no ID, use create")
    getStoreForWorkspace(workspaceId)[type][item.id] = JSON.parse(JSON.stringify(item));
    return Promise.resolve(item);
  }

  async deleteEntity(workspaceId: string, type: any, id: string): Promise<void> {
    if (!getStoreForWorkspace(workspaceId)[type]) return Promise.resolve();
    delete getStoreForWorkspace(workspaceId)[type][id];
    return Promise.resolve();
  }

  async purge() {
    tenants = {}
  }
}

