import { DataQuery } from ".";

export type whereQueryBuilder = (key: string, query: DataQuery, params: (string | number)[]) => string

const whereBuilders = new Map<string, whereQueryBuilder>()

export function addColumnWhere(column: string, where: whereQueryBuilder) {
  whereBuilders.set(column, where)
}

export function jsonColumnQueryBuilder(key: string, query: DataQuery, params: (string | number)[]) {
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

export function buildWhere(query: { [p: string]: string | number | DataQuery }, params: (string | number)[]) {
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

export function baseQuery(type: string): string {
  return `select * from ${tableName(type)} where type = ?`;
}

export function tableName(type: string): string {
  if (type === "event-backup" || "event-restoration") {
    return "backupdatastore"
  }
  return "datastore"
}