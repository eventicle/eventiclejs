import {Knex} from 'knex';
import {v4 as uuidv4} from 'uuid';
import {als} from "asynchronous-local-storage"
import { DataQuery, DataSorting, DataStore, PagedRecords, Record, TransactionData, TransactionOptions } from '.';
import {EventEmitter} from "events";
import { getFileNameAndLineNumber } from '../logger-util';
import logger from '../logger';

const stackTrace = require('stack-trace');


type whereQueryBuilder = (key: string, query: DataQuery, params: (string | number)[]) => string

const whereBuilders = new Map<string, whereQueryBuilder>()

export function addColumnWhere(column: string, where: whereQueryBuilder) {
  whereBuilders.set(column, where)
}

function jsonColumnQueryBuilder<whereQueryBuilder>(key: string, query: DataQuery, params: (string | number)[]) {
  let queryString = ""

  switch (query.op) {
    case "EQ":
      queryString += ` AND content->>'${key}'= ?`;
      params.push(query.value as any)
      break;
    case "GT":
      queryString += ` AND content->>'${key}' > ?`;
      params.push(query.value as any)
      break;
    case "GTE":
      queryString += ` AND content->>'${key}' >= ?`;
      params.push(query.value as any)
      break;
    case "LT":
      queryString += ` AND content->>'${key}' < ?`;
      params.push(query.value as any)
      break;
    case "LTE":
      queryString += ` AND content->>'${key}' <= ?`;
      params.push(query.value as any)
      break;
    case "BETWEEN":
      queryString += ` AND content->>'${key}' between ? and ?`;
      params.push((query.value as any)[0])
      params.push((query.value as any)[1])
      break;
  }
  return queryString;
}

function buildWhere(query: { [p: string]: string | number | DataQuery }, params: (string | number)[]) {
  let queryString = ""
  Object.keys(query).forEach((value) => {

    let dataQuery: DataQuery = null

    if(["string", "number"].includes(typeof query[value])) {
      dataQuery = {
        value: query[value] as string,
        op: "EQ"
      }
    } else {
      dataQuery = query[value] as DataQuery
    }

    if (dataQuery == null) {
      dataQuery = {
        value: null,
        op: "EQ"
      }
    }

    let builder = jsonColumnQueryBuilder
    if (whereBuilders.has(value)) {
      builder = whereBuilders.get(value)
    }

    queryString += builder(value, dataQuery, params);

  });

  return queryString;
}

function baseQuery(type: string): string {
  return `select * from ${tableName(type)} where type = ?`;
}

function tableName(type: string): string {
  if (type === "event-backup" || "event-restoration") {
    return "backupdatastore"
  }
  return "datastore"
}

export abstract class KnexPSQLDataStore implements DataStore {

  events = new EventEmitter()

  abstract entityMapper: (row: any) => Record;
  abstract isCustomError<T extends Error>(error: Error): error is T;

  constructor(readonly db: Knex) { }

  async transaction<T, E extends Error>(exec: () => Promise<T>, options?: TransactionOptions): Promise<T> {


    let file = getFileNameAndLineNumber(3)

    let existingId = als.get("transaction.id")

    if (existingId && options && options.propagation === "requires_new") {
      logger.verbose("Ignoring existing transaction: " + existingId, { location: file })
    } else if (existingId) {
      logger.verbose("Joining existing transaction: " + existingId, { location: file })
      return exec()
    }

    return new Promise((resolve, rej) => {

      als.runWith(async () => {

        let txId = uuidv4()
        const txData = {
          data: {}, id: txId
        } as TransactionData

        try {
          let ret = await this.db.transaction(async trx => { // transaction is used to ensure we stay on the same connection, not for rollback
            try {
              als.set("transaction", trx)
              als.set("transaction.id", txId)
              als.set("transaction.data", txData)
              logger.debug("Started transaction " + als.get("transaction.id"), { location: file })
              this.events.emit("transaction.start", txData)

              try {
                let ret = await exec().catch(reason => {
                  
                  if (this.isCustomError<E>(reason)) {
                    return reason as any;
                  }
                  throw reason
                })
                logger.verbose("Transaction is completed and commits cleanly: " + txId, ret)
                return ret
              } catch (e) {
                logger.verbose("Transaction failed via error and rolls back: " + txId, e)
                throw e
              }
            } finally {
              als.set("transaction", null)
              als.set("transaction.id", null)
              als.set("transaction.data", null)
            }
          }).finally(() => this.events.emit("transaction.commit", txData))

          // this is treated as success to permit the transaction to commit cleanly.
          // Then, propagate as error to the GQL api layer (assuming present)
          if (this.isCustomError(ret)) {
            rej(ret)
          } else {
            resolve(ret)
          }

        } catch (e) {
          rej(e)
        }
      })
    })
  }

  async isConnected(): Promise<boolean> {
    return this.db.raw('select 1+1 as result')
      .then(() => {
        return true
      })
      .catch(err => {
        logger.warn("Failed DB liveness check", err)
        return false
      });
  }

  async getEntity(workspaceId: string, type: string, id: any): Promise<Record> {
    try {
      const query = baseQuery(type) + ' AND id = ?';
      const {rows} = await this.raw(query, [type, id]);

      if (rows === null || rows.length === 0) {
        return null;
      }

      if (rows.length > 1) {
        throw new Error(`Found more than 1 matching record ${type}/${id}`);
      }

      const row = rows[0];
      return this.entityMapper(row);
    } catch (error) {
      logger.error(JSON.stringify(error));
    }
  }

  async findEntity(workspaceId: string, type: string, query: {
    [key: string]: string | number | DataQuery
  }, sorting: DataSorting = {}): Promise<Record[]> {

    try {
      const params = [type] as (string | number)[];
      const queryString =
        baseQuery(type) + ' ' +
        buildWhere(query, params) + ' ' +
        this.getOrderByClause(sorting);

      const {rows} = await this.raw(queryString, params);
      return rows.map(this.entityMapper);

    } catch (error) {
      logger.error("Failed to findEntity", {
        message: error.message,
        stack: stackTrace.parse(error).map( (val:any) => `${val.getFileName()}:${val.getLineNumber()}`).join("\n")
      });
    }

    return [];
  }

  builder(name: string): Knex.QueryBuilder {
    let trx: Knex.Transaction = als.get("transaction")

    logger.verbose("Access transaction for builder " + als.get("transaction.id"))

    if (trx) {
      return trx(name)
    } else {
      return this.db(name)
    }
  }

  raw(sql: string, bindings: readonly Knex.RawBinding[] | Knex.ValueDict): Knex.Raw {
    let trx: Knex.Transaction = als.get("transaction")
    logger.verbose("Access transaction for raw " + als.get("transaction.id"))

    if (trx) {
      return trx.raw(sql, bindings)
    } else {
      return this.db.raw(sql, bindings)
    }
  }

  async findEntityPaginated(workspaceId: string, type: string, query: {
    [key: string]: string | null | DataQuery
  }, sorting: DataSorting, page: number, pageSize: number): Promise<PagedRecords> {


    try {
      const params = [type] as (string | number)[];

      const queryString =
        baseQuery(type) + " " +
        buildWhere(query, params);

      const queryStringCount = `${queryString}`.replace('select *', 'select count(*)');
      // console.info('queryStringCount', queryStringCount);
      const countQuery = this.raw(queryStringCount, params);

      const queryStringEntries = `${queryString} ${this.getOrderByClause(sorting)} LIMIT ${pageSize} OFFSET ${page * pageSize}`;
      const entriesQuery = this.raw(queryStringEntries, params);

      const [countResult, entriesResult] = await Promise.all([countQuery, entriesQuery]);
      const count = parseInt(countResult.rows[0].count);
      const entries = entriesResult.rows.map(this.entityMapper);

      return {
        totalCount: count,
        entries,
        pageInfo: {
          currentPage: page,
          pageSize
        }
      }

    } catch (error) {
      console.log(error)
      logger.error(JSON.stringify(error));
    }
  }

  async createEntity(workspaceId: string, type: string, content: any): Promise<Record> {

    try {

      if (content.id) {
        throw new Error('ID is set, this is not allowed');
      }

      const createdAt = new Date();
      const id = uuidv4();

      content = {...content, id};

      const data = {
        id,
        type,
        createdat: createdAt,
        content: JSON.parse(JSON.stringify(content))
      };

      const res = await this.builder(tableName(type)).insert(data).returning('*');

      if (res !== null && res.length === 1) {
        return this.entityMapper(res[0]);
      }

      return null;
    } catch (error) {
      logger.error(JSON.stringify(error));
    }
  }

  async saveEntity(workspaceId: string, type: string, item: Record): Promise<Record> {
    try {
      const content = {...item.content};
      const res = await this.builder(tableName(type))
        .where({id: item.id, type: type})
        .update({content: content});

      return res as unknown as Record;

    } catch (error) {
      logger.error(JSON.stringify(error));
    }
  }

  async deleteEntity(workspaceId: string, type: string, id: string): Promise<void> {
    try {
      const query = `delete from ${tableName(type)} where type= ? and id= ?`;
      const {rows} = await this.raw(query, [type, id]);
      return rows;

    } catch (error) {
      logger.error(JSON.stringify(error));
    }
  }

  async purge() {
    try {
      const {rows} = await this.db.raw(`truncate datastore`);
      logger.warn("Truncating the datastore", rows)
      const {rows2} = await this.db.raw(`truncate backupdatastore`);
      logger.warn("Truncating the backupdatastore", rows2)
      return rows;
    } catch (error) {
      logger.error(JSON.stringify(error));
    }
  }

  getTransactionData(): TransactionData {
    return als.get("transaction.data");
  }

  hasTransactionData(): boolean {
    return !!als.get("transaction.data");
  }

  on(event: "transaction.start" | "transaction.commit", listener: (name: string, data: TransactionData) => void): this {
    this.events.addListener(event, args => {
      listener(event, args)
    })
    return this
  }

  private getOrderByClause(sorting: DataSorting) {
    let orderBy = 'ORDER BY ';

    if (sorting && Object.keys(sorting).length > 0) {
      Object.keys(sorting).forEach((value) => {
        if (value == "createdAt") {
          orderBy += `createdat ${sorting[value]},`;
        } else {
          orderBy += `content->>'${value}' ${sorting[value]},`;
        }
      });

      orderBy = orderBy.substring(0, orderBy.length - 1);
    } else {
      orderBy = orderBy + ' id';
    }

    return orderBy;
  }
}
