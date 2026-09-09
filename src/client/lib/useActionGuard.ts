import { useCallback, useRef } from "react";

interface Lock {
  busy: boolean; // 上一次动作仍在进行中（异步未结束）
  last: number;  // 上一次动作发起时间
}

const MAX_KEYS = 128;

/**
 * 按钮点击防抖 / 防重入（点击一次只触发一次效果）：
 * - 首次点击立即执行，不等待（leading）；
 * - 执行中的动作未结束前（busy）忽略重复点击 —— 防止双击/连点把同一请求发多次；
 * - 动作结束后 cooldownMs 内的点击同样忽略 —— 防止极快连点穿透 disabled 状态；
 * - 以 key 区分不同动作实例（如不同文档、chat/embed 测试），互不阻塞：
 *      guard("reindex:" + doc.id, reindex, doc)
 * - 动作是异步时返回的 Promise 结束（含 reject）后自动解锁。
 */
export function useActionGuard(cooldownMs = 300) {
  const locksRef = useRef<Map<string, Lock>>(new Map());

  const run = useCallback(<A extends (...args: never[]) => unknown>(key: string, action: A, ...args: Parameters<A>): void => {
    const locks = locksRef.current;
    let lock = locks.get(key);
    if (!lock) {
      lock = { busy: false, last: 0 };
      locks.set(key, lock);
      if (locks.size > MAX_KEYS) {
        const oldest = locks.keys().next().value;
        if (oldest !== undefined) locks.delete(oldest as string);
      }
    }
    const now = Date.now();
    if (lock.busy || now - lock.last < cooldownMs) return; // 防抖：忽略重复触发
    lock.busy = true;
    lock.last = now;
    const release = () => { lock!.busy = false; };
    try {
      const ret = action(...args);
      if (ret && typeof (ret as Promise<unknown>).then === "function") {
        (ret as Promise<unknown>).then(release, release);
      } else {
        release();
      }
    } catch (e) {
      release();
      throw e;
    }
  }, [cooldownMs]);

  return run;
}
