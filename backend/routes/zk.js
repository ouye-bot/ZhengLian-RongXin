const express = require('express');
const router = express.Router();
const { runTask, getStats } = require('../services/zkProcessPool');
const zkQueue = require('../services/zkQueue');
const path = require('path');
const cryptoNode = require('crypto');
const fs = require('fs');
const userDao = require('../dao/userDao');
const transactionDao = require('../dao/transactionDao');
const proofDao = require('../dao/proofDao');
const { execute } = require('../config/database');
const logger = require('../utils/logger');
const { verifyProof } = require('../services/zkService');
const { CREDIT_RULES } = require('./credit');

// 查询用户是否有逾期借款
async function checkUserHasOverdue(userId) {
  const rows = await execute(
    "SELECT COUNT(*) AS cnt FROM transactions WHERE user_id = ? AND type = 'loan' AND status = 'overdue'",
    [userId]
  );
  return rows[0].cnt > 0;
}

// 获取电路文件路径
const wasmPath = path.join(__dirname, '../../circuits/build/credit.wasm');
const zkeyPath = path.join(__dirname, '../../circuits/build/credit_final.zkey');

// POST /zk/generate-proof
router.post('/generate-proof', async (req, res) => {
  // 分数一律以数据库为准：users.credit_score 为信封加密存储，必须经 userDao.findById 解密读取。
  // 请求体里的 creditScore 仅保留字段兼容、不参与计算（防客户端伪报分数）；threshold 仍取请求体
  // （该降级通道按调用方声明的阈值生成证明，阈值准入强核在 verifyProof 消费侧执行）。
  const { threshold, userId } = req.body;
  const compatCreditScore = req.body.creditScore; // 兼容字段：仅签名保留，不使用
  logger.info('ZKP生成请求', { userId, threshold, bodyCreditScoreIgnored: compatCreditScore });

  if (userId === undefined || userId === null || userId === '') {
    return res.status(400).json({ success: false, message: 'userId is required' });
  }
  if (typeof threshold !== 'number') {
    return res.status(400).json({ success: false, message: 'Invalid input' });
  }
  try {
    if (!fs.existsSync(wasmPath)) {
      return res.status(500).json({ success: false, message: '电路文件未找到: credit.wasm' });
    }

    if (!fs.existsSync(zkeyPath)) {
      return res.status(500).json({ success: false, message: '证明密钥文件未找到: credit_final.zkey' });
    }

    // 从库读解密后的信用分（无效用户/分数直接拒绝，不接受请求体传分）
    const user = await userDao.findById(parseInt(userId));
    if (!user) {
      return res.status(400).json({ success: false, message: '用户不存在' });
    }
    const dbCreditScore = Number(user.credit_score);
    if (!Number.isFinite(dbCreditScore) || dbCreditScore < CREDIT_RULES.MIN_SCORE || dbCreditScore > CREDIT_RULES.MAX_SCORE) {
      return res.status(400).json({ success: false, message: '用户信用分无效' });
    }

    // 查询用户逾期状态（服务端自查，不信任前端传值）
    const hasOverdue = await checkUserHasOverdue(parseInt(userId));
    const hasNoOverdue = hasOverdue ? 0 : 1;
    logger.info('ZKP生成-用户逾期状态', { userId, hasNoOverdue });

    // addTask 与 runTask 均使用库读分数
    const taskId = await zkQueue.addTask({ creditScore: dbCreditScore, threshold, hasNoOverdue });

    const workerTaskId = Date.now().toString(36) + Math.random().toString(36).substr(2, 5);

    runTask({
      id: workerTaskId,
      type: 'generate',
      args: [dbCreditScore, threshold, hasNoOverdue]
    }).then(async result => {
      await zkQueue.updateTaskStatus(taskId, 'completed', result, null);
    }).catch(async err => {
      await zkQueue.updateTaskStatus(taskId, 'failed', null, err.message);
    });

    res.status(202).json({
      success: true,
      taskId,
      status: 'queued',
      message: '证明生成任务已提交，请轮询任务状态'
    });
  } catch (e) {
    if (e.message.includes('queue is full')) {
      return res.status(503).json({ success: false, message: e.message });
    }
    res.status(500).json({ success: false, message: e.message });
  }
});

// GET /zk/task/:taskId - 查询任务状态
router.get('/task/:taskId', async (req, res) => {
  const status = await zkQueue.getTaskStatus(req.params.taskId);
  if (!status) {
    return res.status(404).json({ success: false, message: '任务不存在或已过期' });
  }
  res.json({ success: true, ...status });
});

// Verify credit proof (真正验证 ZKP，不再硬编码)
router.post('/verify-proof', async (req, res) => {
  try {
    const { userId, verificationCode } = req.body;

    if (!userId || !verificationCode) {
      return res.status(400).json({ success: false, message: '缺少必要参数' });
    }

    // 从数据库查找对应的信用证明（时序安全比较验证口令）
    const proofs = await proofDao.findByUserId(parseInt(userId));
    const matchingProof = proofs.find(p => {
      if (!p.verification_code || !verificationCode) return false;
      const a = Buffer.from(p.verification_code, 'utf8');
      const b = Buffer.from(verificationCode, 'utf8');
      return a.length === b.length && cryptoNode.timingSafeEqual(a, b);
    });

    if (!matchingProof) {
      return res.json({ success: false, message: '验证口令无效' });
    }

    // 口令有效期优先 code_expires_at（24h）；存量行该列为 NULL 时退回 expires_at（30 天）口径
    if (new Date(matchingProof.code_expires_at || matchingProof.expires_at) <= new Date()) {
      return res.json({ success: false, message: '信用证明已过期' });
    }

    // 如果存储了 ZKP proof，进行真正的零知识证明验证
    let isValid = false;
    if (matchingProof.zk_proof && matchingProof.public_signals) {
      try {
        const proof = JSON.parse(matchingProof.zk_proof);
        const publicSignals = JSON.parse(matchingProof.public_signals);
        // 保持旧口径（两参）：验证码门禁 + 存量证明（public_signals=["1","650"] 等）兼容。
        // 残留风险：此路径不校验公开阈值，低阈值证明凭有效口令仍可通过本端点；
        // 阈值准入强核由 /credit/generate-proof 与借款链路（verifyProof 第三参）承担。
        isValid = await verifyProof(proof, publicSignals);
      } catch (verifyErr) {
        logger.error('ZKP 链上验证异常', { error: verifyErr.message, userId });
        isValid = false;
      }
    } else {
      // ZKP数据缺失，验证失败
      logger.error('信用证明无 ZKP 数据，验证失败', { userId, proofId: matchingProof.proof_id });
      isValid = false;
    }

    if (!isValid) {
      return res.json({ success: false, message: '零知识证明验证失败' });
    }

    // 记录验证费用交易（使用数据库而非进程内存）
    await transactionDao.create({
      user_id: parseInt(userId),
      type: 'proof_fee',
      amount: 10,
      status: 'completed'
    });

    res.json({ success: true, message: '证明验证成功' });
  } catch (error) {
    logger.error('证明验证失败', { error: error.message });
    res.status(500).json({ success: false, message: '证明验证失败' });
  }
});

// 所有废弃端点已移除（/lend, /repay, /collect-loan, /all-loans, /all-lends）
// 请使用 /api/v1/loan 和 /api/v1/credit 下的正式端点

module.exports = router;
