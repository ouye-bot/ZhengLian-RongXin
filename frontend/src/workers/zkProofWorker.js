/* eslint-disable no-restricted-globals */
import { groth16 } from 'snarkjs';

let wasmUrl = null;
let zkeyUrl = null;
let isInitialized = false;

self.onmessage = async (e) => {
  const { type, wasmUrl: initWasmUrl, zkeyUrl: initZkeyUrl, input, requestId } = e.data;

  switch (type) {
    case 'INIT':
      try {
        wasmUrl = initWasmUrl;
        zkeyUrl = initZkeyUrl;
        console.log('[Worker] Initialized with URLs:', { wasmUrl, zkeyUrl });

        // 预热：INIT_COMPLETE 前用假数据完整跑一次 fullProve，把 wasm/zkey 下载、
        // wasm 实例化与 snarkjs 曲线初始化一次性做完，后续真实请求显著提速。结果丢弃。
        // 预热失败走现行 ERROR 通道（不发 INIT_COMPLETE，页面显示电路加载失败），
        // isInitialized 保持 false，真实 GENERATE_PROOF 不会被误放行。
        console.log('[Worker] Prewarming with dummy input...');
        await groth16.fullProve(
          { creditScore: 700, threshold: 600, hasNoOverdue: 1 },
          wasmUrl,
          zkeyUrl
        );
        console.log('[Worker] Prewarm complete');

        isInitialized = true;
        self.postMessage({ type: 'INIT_COMPLETE', requestId });
      } catch (error) {
        console.error('[Worker] INIT error:', error.message);
        self.postMessage({ type: 'ERROR', error: error.message, requestId });
      }
      break;

    case 'GENERATE_PROOF':
      if (!isInitialized) {
        self.postMessage({
          type: 'ERROR',
          error: 'Worker not initialized. Call INIT first.',
          requestId
        });
        return;
      }

      try {
        const creditScore = Number(input.creditScore);
        const threshold = Number(input.threshold);
        const hasNoOverdue = input.hasNoOverdue ? 1 : 0;

        if (isNaN(creditScore) || isNaN(threshold)) {
          throw new Error('Invalid input: creditScore and threshold must be numbers');
        }

        const proofInput = {
          creditScore,
          threshold,
          hasNoOverdue
        };

        console.log('[Worker] Generating proof, input:', proofInput);
        console.log('[Worker] WASM URL:', wasmUrl);
        console.log('[Worker] ZKEY URL:', zkeyUrl);

        const { proof, publicSignals } = await groth16.fullProve(
          proofInput,
          wasmUrl,
          zkeyUrl
        );

        console.log('[Worker] Proof generated successfully');
        console.log('[Worker] publicSignals:', publicSignals);

        self.postMessage({
          type: 'PROOF_COMPLETE',
          proof,
          publicSignals,
          requestId
        });
      } catch (error) {
        console.error('[Worker] Proof generation failed:', error.message);
        console.error('[Worker] Stack:', error.stack);
        self.postMessage({
          type: 'ERROR',
          error: error.message || 'Proof generation failed',
          requestId
        });
      }
      break;

    default:
      self.postMessage({
        type: 'ERROR',
        error: `Unknown message type: ${type}`,
        requestId
      });
  }
};