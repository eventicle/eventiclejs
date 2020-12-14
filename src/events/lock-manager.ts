

// noddy in mem lock manager
let LOCK_MANAGER = {
  async withLock<T>(id: number, onLock: () => Promise<T>, teardown: () => void) {
    return onLock();
  },
  async tryLock<T>(id: number, onLock: () => Promise<T>, teardown: () => void) {
    return onLock();
  }
} as LockManager

export function setLockManager(lockManager: LockManager) {
  LOCK_MANAGER = lockManager;
}

export function lockManager(): LockManager {
  return LOCK_MANAGER;
}

export interface LockManager {
  withLock: <T>(id: number, onLock: () => Promise<T>, teardown: () => void) => Promise<T>;
  tryLock: <T>(id: number, onLock: () => Promise<T>, teardown: () => void) => Promise<T>;
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
