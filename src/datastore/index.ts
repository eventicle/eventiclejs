
export interface Record {
  type: string
  id: string
  content: any
  createdAt: Date
}

export interface DataStore {

  getEntity(workspaceId: string, type: any, id: string): Promise<Record>

  /**
   *
   * @param {*} type Entity type or "table" name
   * @param {*} query  Json object to match fields
   */
  findEntity(workspaceId: string, type: any, query: any): Promise<Record[]>

  /**
   *
   * @param {*} type Entity type or "table" name
   * @param {*} query  Json object to match fields
   * @param {*} page page count
   * @param {*} pageSize page size
   */
  findEntityPaginated(workspaceId: string, type: any, query: any, page: number, pageSize: number): Promise<Record[]>

  /**
   *
   * @param {*} type Entity type or "table" name
   * @param {*} item
   */
  createEntity(workspaceId: string, type: any, content: any): Promise<Record>

  saveEntity(workspaceId: string, type: any, item: Record): Promise<Record>

  deleteEntity(workspaceId: string, type: any, id: string): Promise<void>
}

let dataStoreModule: DataStore;


export function setDataStore(dataStore: DataStore) {
  dataStoreModule = dataStore
}

export function dataStore() {
  return dataStoreModule
}
