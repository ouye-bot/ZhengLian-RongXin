/**
 * 共享 ZK Worker 单例管理器
 *
 * 分工：登录成功后（App.js → prewarmZkWorker）即创建 Worker 并发 INIT，
 * Worker 端在 INIT_COMPLETE 前用假数据预热（workers/zkProofWorker.js INIT 分支），
 * 页面（CreditProof 等）需要生成证明时经 getZkWorker() 取同一实例，直接复用预热结果。
 * 消息协议（INIT/INIT_COMPLETE/GENERATE_PROOF/PROOF_COMPLETE/ERROR）不变；
 * 生成请求仍由页面自行 addEventListener + requestId 过滤（同一 worker 上多监听器互不干扰）。
 *
 * prewarmZkWorker 为 fire-and-forget：失败仅 console.warn，绝不阻塞登录。
 */

let workerInstance = null;
let readyPromise = null;
let isReady = false;

function createWorker() {
  const worker = new Worker(
    new URL('../workers/zkProofWorker.js', import.meta.url),
    { type: 'module' }
  );

  const initRequestId = 'init-manager-' + Date.now();
  readyPromise = new Promise((resolve, reject) => {
    const handler = (e) => {
      if (e.data.requestId !== initRequestId) return; // 只认本管理器的 INIT 回执
      worker.removeEventListener('message', handler);
      if (e.data.type === 'INIT_COMPLETE') {
        isReady = true;
        resolve(worker);
      } else if (e.data.type === 'ERROR') {
        // 初始化失败：终止失败实例（避免重试累积空闲 Worker），清空单例状态，允许下次 getZkWorker() 重新创建重试
        try { worker.terminate(); } catch (_) { /* 已终止或不可用，忽略 */ }
        workerInstance = null;
        readyPromise = null;
        isReady = false;
        reject(new Error(e.data.error));
      }
    };
    worker.addEventListener('message', handler);
    worker.postMessage({
      type: 'INIT',
      wasmUrl: '/circuits/credit.wasm',
      zkeyUrl: '/circuits/credit_final.zkey',
      requestId: initRequestId
    });
  });

  return worker;
}

/**
 * 取共享 Worker（无则创建并发起 INIT+预热）。
 * 同步返回 worker 实例；就绪状态用 whenZkWorkerReady() 或 isZkWorkerReady() 查询。
 */
export function getZkWorker() {
  if (!workerInstance) {
    workerInstance = createWorker();
  }
  return workerInstance;
}

/** Worker 是否已完成 INIT+预热（可用 GENERATE_PROOF） */
export function isZkWorkerReady() {
  return isReady;
}

/** 等待共享 Worker 就绪；失败时 Promise reject（携带错误消息） */
export function whenZkWorkerReady() {
  if (!workerInstance) {
    getZkWorker();
  }
  return readyPromise;
}

/**
 * 登录后 fire-and-forget 预创建+预热：不 await、不抛错、不影响登录流程。
 */
export function prewarmZkWorker() {
  try {
    getZkWorker();
    whenZkWorkerReady().catch((err) => {
      console.warn('[zkWorkerManager] 预热失败（首次生成时会重试）:', err.message);
    });
  } catch (err) {
    console.warn('[zkWorkerManager] Worker 预创建失败:', err.message);
  }
}
