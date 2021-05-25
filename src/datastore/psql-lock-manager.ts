import { Knex } from 'knex';
import {v4 as uuidv4} from 'uuid';
import {als} from "asynchronous-local-storage"
import { hashCode, LockManager } from '../events/lock-manager';
import logger from '../logger';
import { getFileNameAndLineNumber } from '../logger-util';
import { pause } from '../util';
import { KnexPSQLDataStore } from './psql-data-store';

const LOCAL_LOCK_DEBUG = {} as any

let PSQL_LOCK_DEBUG=process.env["PSQL_LOCK_DEBUG"]


export class KnexPSQLLockManager<E extends Error> implements LockManager {

  constructor(readonly db: KnexPSQLDataStore<E>) {
  }

  async tryLock<T>(id: string, onLock: () => Promise<T>, teardown: () => void): Promise<T> {
    return await this.internalLock(hashCode(id), onLock, teardown, 1);
  }

  async withLock<T>(id: string, onLock: () => Promise<T>, teardown: () => void): Promise<T> {
    return await this.internalLock(hashCode(id), onLock, teardown, 3);
  }

  private async internalLock<T>(id: number, onLock: () => Promise<T>, teardown: () => void, maxAttempts: number): Promise<T> {

    let file = getFileNameAndLineNumber(3)
    let lockId = uuidv4()

    const PG_ADVISE_MAGIC = 15

    let doUnlock = false

    let exec = async () => {
      const trx: Knex.Transaction = als.get("transaction")
      const trxId = als.get("transaction.id")

      const tryGetLock = async () => {
        try {
          let ret = await trx.raw(`select pg_try_advisory_lock(${PG_ADVISE_MAGIC}, ${id});`)
          return ret.rows[0].pg_try_advisory_lock
        } catch (e) {
          logger.warn("Failed to get PG advisory lock " + id, e)
          return false
        }
      }

      const then = Date.now()
      let retData
      try {
        for (let attempts = 0; attempts <= maxAttempts; attempts++) {
          logger.verbose(`tryGetLock ${id} [${lockId}] in transaction ${als.get("transaction.id")}, attempt ${attempts}`)
          if (await tryGetLock()) {
            if (PSQL_LOCK_DEBUG) {
              LOCAL_LOCK_DEBUG[id]=file
            }
            logger.debug(`Acquired lock after cycles: ${lockId} ` + attempts, {id, attempts, time: Date.now() - then})
            doUnlock = true
            retData = await onLock()
              .catch(reason => {
                if (this.db.isCustomError(reason)) {
                  return reason as any
                }
                throw reason
              })
            this.maybeOutputLockDebug(id, file);
            logger.debug("Completed lockable resource, moving to unlock")
            return retData
          } else {
            this.maybeOutputLockDebug(id, file);
          }

          await pause(50)
        }

        logger.warn(`Failed to get PG advisory lock within acquire timeout, highly contended resource? [${lockId}]` + id, {
          id,
          attempts: maxAttempts,
          time: Date.now() - then
        })
        if (PSQL_LOCK_DEBUG) {
          console.log(`LOCAL LOCK TABLE, trying for [${lockId}]` + id, {
            table: LOCAL_LOCK_DEBUG, requiredId: id, callingFile: getFileNameAndLineNumber(2), lockHeldBy: LOCAL_LOCK_DEBUG[id]
          })
        }
        await teardown()

      } finally {

        try {
          if (doUnlock) {
            logger.verbose(`Cleaning up shared lock ${id} in transaction ${trxId}`)
            if (PSQL_LOCK_DEBUG) {
              delete LOCAL_LOCK_DEBUG[id]
            }
            let then2 = Date.now()
            let success = false
            for (let attempt = 0; attempt < 10; attempt++) {
              const unlocked = await trx.raw(`select pg_advisory_unlock(${PG_ADVISE_MAGIC}, ${id});`)
              if (unlocked.rows[0].pg_advisory_unlock) {
                logger.debug("Finished advisory lock: " + id, {attempt, time: Date.now() - then2})
                success = true
                break
              }
              await pause(50)
            }
            if (!success) {
              logger.warn(`Failed advisory lock: [${lockId}]` + id, {attempt: 10, time: Date.now() - then2})
            }
          }
        } catch (e) {
          logger.warn(`Failed cleaning advisory lock: [${lockId}]` + id, e)
        }
      }
    }

    let existingId = als.get("transaction.id")

    if (!existingId) {
      logger.verbose("Starting new transaction to wrap lock " + id)
      return this.db.transaction(async () => await exec())
    }

    logger.verbose(`LOCK ${id} is joining existing DB transaction ` + existingId)
    return await exec()
  }

  private maybeOutputLockDebug(id: number, file: { file: string; lineno: number; timestamp: string }) {
    if (PSQL_LOCK_DEBUG) {
      console.log("LOCAL LOCK TABLE, trying for " + id, {
        table: LOCAL_LOCK_DEBUG, requiredId: id, callingFile: file, lockHeldBy: LOCAL_LOCK_DEBUG[id]
      })
    }
  }
}
