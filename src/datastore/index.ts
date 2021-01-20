
export interface PagedRecords {
  totalCount: number;
  pageInfo: {
    currentPage: number;
    pageSize: number;
  };
  entries: Record[]
}

export interface Record {
  type: string
  id: string
  content: any
  createdAt: Date
}

export interface DataQuery {
  value: string | number | [number, number]
  op: "EQ" | "LT" | "GT" | "LTE" | "GTE" | "BETWEEN"
}

export interface DataSorting {
  [key:string]: 'ASC' | 'DESC'
}

export interface DataStore {

  getEntity(workspaceId: string, type: string, id: string): Promise<Record>

  /**
   *
   * @param workspaceId
   * @param {*} type Entity type or "table" name
   * @param {*} query  Json object to match fields
   * @param sorting
   */
  findEntity(workspaceId: string, type: any, query: {
    [key: string]: string | number | DataQuery
  }, sorting?: DataSorting): Promise<Record[]>

  /**
   *
   * @param workspaceId
   * @param {*} type Entity type or "table" name
   * @param {*} query  Json object to match fields
   * @param sorting
   * @param {*} page page count
   * @param {*} pageSize page size
   */
  findEntityPaginated(workspaceId: string, type: string, query: {
    [key: string]: string | number | DataQuery
  }, sorting: DataSorting, page: number, pageSize: number): Promise<PagedRecords>

  /**
   *
   * @param {*} type Entity type or "table" name
   * @param {*} item
   */
  createEntity(workspaceId: string, type: string, content: any): Promise<Record>

  saveEntity(workspaceId: string, type: string, item: Record): Promise<Record>

  deleteEntity(workspaceId: string, type: string, id: string): Promise<void>
}

let dataStoreModule: DataStore;


export function setDataStore(dataStore: DataStore) {
  dataStoreModule = dataStore
}

export function dataStore() {
  return dataStoreModule
}
