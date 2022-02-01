import * as uuid from 'uuid';
import {DataQuery, DataSorting, DataStore, PagedRecords, Record, TransactionData} from "../";
import {logger} from "@eventicle/eventicle-utilities";
import {als} from "asynchronous-local-storage"
import {EventEmitter} from "events";
import { Query } from '@eventicle/eventicle-utilities/dist/datastore';

let tenants: any = {};

function getStoreForWorkspace(id: string) {
  if (!tenants[id]) {
    tenants[id] = {}
  }
  return tenants[id]
}

const isPrimitive = (it: any): boolean => ["string", "number"].includes(typeof it)

function partialCompareArray(partial: any[], data: any[]): boolean {
  if(partial.some((el) => Array.isArray(el) || typeof el === "object")) {
    return partial.map((part): boolean => {
      if(isPrimitive(part)) {
        return data.includes(part)
      } else {
        const test = data.find((el) => partialCompareObject(part, el))
        return test !== undefined
      }
    })
      .filter((part) => !part)
      .length === 0
  } else {
    return partial.every((el) => data.indexOf(el) !== -1)
  }
}

function partialCompareObject(partial: any, data: any): boolean {
  return Object.keys(partial)
    .map((key): boolean => {
      if(data.hasOwnProperty(key)) {

        // A mismatch means we don't like this comparison
        if(typeof data[key] !== typeof partial[key]) {
          return false
        }

        // primitives
        if(typeof data[key] === typeof partial[key] && isPrimitive(partial[key])) {
          return data[key] === partial[key]
        }

        // Compare arrays
        if(Array.isArray(partial[key])) {
          if(!Array.isArray(data[key])) {
            return false
          } else {
            return partialCompareArray(partial[key], data[key])
          }
        }

        // Compare objects
        if(typeof data[key] === "object" && typeof partial[key] === "object") {
          return partialCompareObject(partial[key], data[key])
        } else {
          return false
        }
      } else {
        return false
      }
    })
    .filter((key) => !key)
    .length === 0
}

function likeCompare(query, data): boolean {

  const path = [...query.path]
  const current = path.shift()
  if(data.hasOwnProperty(current)) {
    if(path.length === 0) {

      if(Array.isArray(data[current])) {
        let check = false
        data[current].forEach((item) => {
          if(isPrimitive(item)) {
            if(item.includes(query.like)) {
              check = true
            }
          }
        })
        return check
      }

      if(isPrimitive(data[current])) {
        return `${data[current]}`.includes(query.like)
      }

      return false
    }
    return likeCompare({...query, path}, data[current])
  } else {
    return false
  }


}

export default class implements DataStore {

  events = new EventEmitter()

  hasTransactionData(): boolean {
    return !!als.get("transaction.data");
  }

  on(event: "transaction.start" | "transaction.commit", listener: (name: string, data: TransactionData) => void): this {
    this.events.addListener(event, args => {
      listener(event, args)
    })
    return this
  }

  getTransactionData(): TransactionData {
    return als.get("transaction.data")
  }

  async transaction<T>(exec: () => Promise<T>): Promise<T> {
    const txId = uuid.v4()

    return await new Promise(async res => {
      als.runWith(async () => {
        const txData = {
          data: {}, id: txId
        } as TransactionData
        als.set("transaction.data", txData)
        als.set("transaction.id", txId)

        this.events.emit("transaction.start", txData)

        res(exec().finally(async () => {
          this.events.emit("transaction.commit", txData)
          als.set("transaction", null)
          als.set("transaction.id", null)
          als.set("transaction.data", null)
        }))
      })
    })
  }


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
  public async findEntity(workspaceId: string, type: any, query: Query, sorting: DataSorting = {}): Promise<Record[]> {
    const table = getStoreForWorkspace(workspaceId)[type];
    if (!table) return [];
    const results: any = [];
    Object.keys(table).forEach(id => {
      const entry = table[id];
      var fieldsAllMatch = true;
      Object.keys(query).forEach(key => {
        if (typeof query[key] === "object") {
          let val = query[key] as DataQuery
          let data = entry.content[key]
          switch(val.op) {
            case "IN":
              if (Array.isArray(val.value)) {
                if (!(val.value as string[]).includes(data)) {
                  fieldsAllMatch = false
                }
              } else {
                fieldsAllMatch = false
              }
              break;
            case "EQ":
              if (data !== val.value) {
                fieldsAllMatch = false
              }
              break;
            case "GT":
              if (data <= val.value) {
                fieldsAllMatch = false
              }
              break;
            case "GTE":
              if (data < val.value) {
                fieldsAllMatch = false
              }
              break;
            case "LT":
              if (data >= val.value) {
                fieldsAllMatch = false
              }
              break;
            case "LTE":
              if (data > val.value) {
                fieldsAllMatch = false
              }
              break;
            case "BETWEEN":
              if (!(data >= val.value[0] && data <= val.value[1])) {
                fieldsAllMatch = false
              }
              break;
            case "OBJECT":
              let parsed = val.value
              if(typeof val.value === "string") {
                parsed = JSON.parse(val.value as string)
              }
              fieldsAllMatch = partialCompareObject(val.value, entry.content)
              break;
            case "LIKE": {
              if(isPrimitive(val.value) || !val.value.hasOwnProperty("path") || !val.value.hasOwnProperty("like")) {
                logger.warn("Like query must contain a path as an array of strings", query)
                fieldsAllMatch = false
              } else {
                fieldsAllMatch = likeCompare(val.value, entry.content)
              }
              break;
            }
          }

        } else if (query[key] !== entry.content[key]) {
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
  async findEntityPaginated(workspaceId: string, type: string, query: Query, sorting: DataSorting, page: number, pageSize: number): Promise<PagedRecords> {
    const results = await this.findEntity(workspaceId, type, query, sorting);
    let startIndex = (pageSize * page) - pageSize;

    if(startIndex < 0) {
      startIndex = 0
    }

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
  async createEntity(workspaceId: string, type: string, item: any) {
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

  async saveEntity(workspaceId: string, type: string, item: Record) {
    if (!item.id) throw new Error("Failed to save, has no ID, use create")
    getStoreForWorkspace(workspaceId)[type][item.id] = JSON.parse(JSON.stringify(item));
    return Promise.resolve(item);
  }

  async deleteEntity(workspaceId: string, type: string, id: string): Promise<void> {
    if (!getStoreForWorkspace(workspaceId)[type]) return Promise.resolve();
    delete getStoreForWorkspace(workspaceId)[type][id];
    return Promise.resolve();
  }

  async deleteMany(workspaceId: string, type: string, query: Query): Promise<void> {
    const results = await this.findEntity(workspaceId, type, query);
    results.map((result) => {
      delete getStoreForWorkspace(workspaceId)[type][result.id]
    })
  }

  async purge() {
    tenants = {}
  }
}

