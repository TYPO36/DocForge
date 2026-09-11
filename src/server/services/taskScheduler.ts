/**
 * @author JTP
 * @date 2026-09-11
 * @description 后台任务调度抽象：让上传、重索引等长任务不再绑定单一 HTTP 连接的生命周期。
 *
 * 设计意图：
 * - Node / Docker 部署：任务进入进程内队列，受并发上限约束，客户端断开后照常执行。
 * - Cloudflare Worker：交由 `ctx.waitUntil()` 托管，响应返回或客户端断开后仍会继续执行，
 *   但平台限制为「响应结束后最多 30 秒」，超出部分会被取消；需要更长执行时间时应改用 Queues。
 */

/** 后台任务：返回 Promise 的异步函数，异常由调度器统一兜底记录。 */
export type BackgroundTask = () => Promise<void>;

/** 后台任务调度器。 */
export interface TaskScheduler {
  /** 实现标识，用于日志与诊断。 */
  readonly kind: string;
  /**
   * 注册一个后台任务。
   *
   * 调用方不等待任务完成；任务自身的异常必须在返回前被调度器捕获，避免 unhandled rejection。
   *
   * @param task 待执行的后台任务。
   */
  run(task: BackgroundTask): void;
}

/** 进程内队列的默认并发上限：限制同时进行的解析与外部模型调用，避免内存与速率压力。 */
const DEFAULT_CONCURRENCY = 2;
/** 优雅退出时等待任务收敛的轮询间隔（毫秒）。 */
const DRAIN_POLL_MS = 50;

/**
 * Node / Docker 环境使用的进程内任务队列。
 *
 * 任务按先进先出执行，超出并发上限时排队；进程关闭前可调用 {@link drain} 等待收敛。
 */
export class NodeTaskQueue implements TaskScheduler {
  readonly kind = "node-queue";
  private readonly queue: BackgroundTask[] = [];
  private running = 0;

  /**
   * @param concurrency 同时执行的任务数上限，小于 1 时回退为默认值。
   */
  constructor(private readonly concurrency: number = DEFAULT_CONCURRENCY) {
    if (!Number.isInteger(concurrency) || concurrency < 1) this.concurrency = DEFAULT_CONCURRENCY;
  }

  /** {@inheritDoc TaskScheduler.run} */
  run(task: BackgroundTask): void {
    this.queue.push(task);
    this.pump();
  }

  /**
   * 等待队列中所有任务结束（含正在执行的），用于进程退出前的收敛。
   *
   * @param timeoutMs 最长等待时间，超时后返回 false；默认 30 秒。
   * @returns 是否在超时前完成全部任务。
   */
  async drain(timeoutMs = 30_000): Promise<boolean> {
    const deadline = Date.now() + Math.max(0, timeoutMs);
    while (this.running > 0 || this.queue.length > 0) {
      if (Date.now() > deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, DRAIN_POLL_MS));
    }
    return true;
  }

  /** 取出可执行任务并启动，直到达到并发上限。 */
  private pump(): void {
    while (this.running < this.concurrency && this.queue.length > 0) {
      const task = this.queue.shift()!;
      this.running++;
      void task()
        .catch((error) => console.error("[task] 后台任务失败:", error instanceof Error ? error.message : error))
        .finally(() => {
          this.running--;
          this.pump();
        });
    }
  }
}

/**
 * Cloudflare Worker 环境使用的调度器：把任务交给 `ctx.waitUntil()` 托管。
 *
 * @param waitUntil 来自请求 `ExecutionContext` 的 waitUntil，必须保持其 this 绑定
 *   （直接传入 `ctx.waitUntil.bind(ctx)`，不要解构后单独调用）。
 * @returns 基于 waitUntil 的调度器。
 */
export function createWorkerScheduler(waitUntil: (promise: Promise<unknown>) => void): TaskScheduler {
  return {
    kind: "worker-waituntil",
    run(task: BackgroundTask): void {
      waitUntil(task().catch((error) => console.error("[task] 后台任务失败:", error instanceof Error ? error.message : error)));
    },
  };
}

/** 不托管生命周期的最小实现：任务立即执行，仅供缺少宿主上下文时兜底。 */
export const detachedScheduler: TaskScheduler = {
  kind: "detached",
  run(task: BackgroundTask): void {
    void task().catch((error) => console.error("[task] 后台任务失败:", error instanceof Error ? error.message : error));
  },
};
