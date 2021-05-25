

// noddy in mem lock manager
let LOCK_MANAGER = {
  async withLock<T>(id: string, onLock: () => Promise<T>, teardown: () => void) {
    return onLock();
  },
  async tryLock<T>(id: string, onLock: () => Promise<T>, teardown: () => void) {
    return onLock();
  }
} as LockManager

export function setLockManager(lockManager: LockManager) {
  LOCK_MANAGER = lockManager;
}

export function lockManager(): LockManager {
  return LOCK_MANAGER;
}

/**
 * A lock manager
 */
export interface LockManager {
  /**
   * Obtain a lock over a shared resource.
   *
   * Will block until the lock becomes available.
   *
   * Will call onLockFailure if the lock is not available within the built in timeout
   *
   * @param id
   * @param onLock
   * @param onLockFailure
   */
  withLock: <T>(id: string, onLock: () => Promise<T>, onLockFailure: () => void) => Promise<T>;

  /**
   * Obtain a lock over a shared resource.
   *
   * If the lock is not immediately available, will call onLockFailure and terminate
   *
   * @param id
   * @param onLock
   * @param onLockFailure
   */
  tryLock: <T>(id: string, onLock: () => Promise<T>, onLockFailure: () => void) => Promise<T>;
}

export function hashCode(str: string) {
  var hash = 0, i, chr;
  for (i = 0; i < str.length; i++) {
    chr   = str.charCodeAt(i);
    hash  = ((hash << 5) - hash) + chr;
    hash |= 0; // Convert to 32bit integer
  }
  return hash;
}
