import {Query} from "@eventicle/eventicle-utilities/dist/datastore";
import {DataQuery} from "../index";
import {logger} from "@eventicle/eventicle-utilities";


export const isPrimitive = (it: any): boolean =>
  ["string", "number", "boolean"].includes(typeof it);

export function partialCompareArray(partial: any[], data: any[]): boolean {
  if (partial.some((el) => Array.isArray(el) || typeof el === "object")) {
    return (
      partial
        .map((part): boolean => {
          if (isPrimitive(part)) {
            return data.includes(part);
          } else {
            const test = data.find((el) => partialCompareObject(part, el));
            return test !== undefined;
          }
        })
        .filter((part) => !part).length === 0
    );
  } else {
    return partial.every((el) => data.indexOf(el) !== -1);
  }
}

export function partialCompareObject(partial: any, data: any): boolean {
  return (
    Object.keys(partial)
      .map((key): boolean => {
        if (data.hasOwnProperty(key)) {
          // A mismatch means we don't like this comparison
          if (typeof data[key] !== typeof partial[key]) {
            return false;
          }

          // primitives
          if (
            typeof data[key] === typeof partial[key] &&
            isPrimitive(partial[key])
          ) {
            return data[key] === partial[key];
          }

          // Compare arrays
          if (Array.isArray(partial[key])) {
            if (!Array.isArray(data[key])) {
              return false;
            } else {
              return partialCompareArray(partial[key], data[key]);
            }
          }

          // Compare objects
          if (
            typeof data[key] === "object" &&
            typeof partial[key] === "object"
          ) {
            return partialCompareObject(partial[key], data[key]);
          } else {
            return false;
          }
        } else {
          return false;
        }
      })
      .filter((key) => !key).length === 0
  );
}

export function likeCompare(query, data): boolean {
  const path = [...query.path];
  const current = path.shift();
  if (data.hasOwnProperty(current)) {
    if (path.length === 0) {
      if (Array.isArray(data[current])) {
        let check = false;
        data[current].forEach((item) => {
          if (isPrimitive(item)) {
            if (item.includes(query.like)) {
              check = true;
            }
          }
        });
        return check;
      }

      if (isPrimitive(data[current])) {
        return `${data[current]}`.includes(query.like);
      }

      return false;
    }
    return likeCompare({ ...query, path }, data[current]);
  } else {
    return false;
  }
}

export function filterTableUsingObjectComparison<T>(table: T[], query: Query, accessor: (val: any) => any = (val) => val): T[] {
  const results: any = [];
  Object.keys(table).forEach((id) => {
    const entry = table[id];
    var fieldsAllMatch = true;
    Object.keys(query).forEach((key) => {
      if (typeof query[key] === "object") {
        let val = query[key] as DataQuery;
        const data = accessor(entry)[key];
        switch (val.op) {
          case "IN":
            if (Array.isArray(val.value)) {
              if (!(val.value as string[]).includes(data)) {
                fieldsAllMatch = false;
              }
            } else {
              fieldsAllMatch = false;
            }
            break;
          case "EQ":
            if (data !== val.value) {
              fieldsAllMatch = false;
            }
            break;
          case "GT":
            if (data <= val.value) {
              fieldsAllMatch = false;
            }
            break;
          case "GTE":
            if (data < val.value) {
              fieldsAllMatch = false;
            }
            break;
          case "LT":
            if (data >= val.value) {
              fieldsAllMatch = false;
            }
            break;
          case "LTE":
            if (data > val.value) {
              fieldsAllMatch = false;
            }
            break;
          case "BETWEEN":
            if (!(data >= val.value[0] && data <= val.value[1])) {
              fieldsAllMatch = false;
            }
            break;
          case "OBJECT":
            let parsed = val.value;
            if (typeof val.value === "string") {
              parsed = JSON.parse(val.value as string);
            }
            fieldsAllMatch = partialCompareObject(parsed, accessor(entry));
            break;
          case "LIKE": {
            if (
              isPrimitive(val.value) ||
              !val.value.hasOwnProperty("path") ||
              !val.value.hasOwnProperty("like")
            ) {
              logger.warn(
                "Like query must contain a path as an array of strings",
                query
              );
              fieldsAllMatch = false;
            } else {
              fieldsAllMatch = likeCompare(val.value, accessor(entry));
            }
            break;
          }
          case "ARRAY_CONTAINS":
            if (
              isPrimitive(val.value)
            ) {
              if (!data.includes(val.value)) {
                fieldsAllMatch = false;
              }
            } else {
              const matches = data?.filter( full => partialCompareObject(val.value, full)) || []
              if (matches.length == 0) {
                fieldsAllMatch = false;
              }
            }
            break;
        }
      } else if (query[key] !== accessor(entry)[key]) {
        fieldsAllMatch = false;
      }
    });
    if (fieldsAllMatch) {
      results.push(entry);
    }
  });
  return results;
}
