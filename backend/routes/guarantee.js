const express = require('express');
const router = express.Router();
const Joi = require('joi');
const validate = require('../middleware/validate');
const guaranteeEngine = require('../services/riskPlugins/guaranteeEngine');
const guaranteeRequestService = require('../services/riskPlugins/guaranteeRequestService');
const logger = require('../utils/logger');

// 获取可选担保人列表
router.get('/eligible-guarantors', async (req, res) => {
  try {
    const { loanAmount } = req.query;
    if (!loanAmount) {
      return res.status(400).json({ success: false, message: '缺少loanAmount参数' });
    }

    // 查询所有用户（非管理员）
    const { execute } = require('../config/database');
    const allUsers = await execute("SELECT id, username, credit_score, created_at, balance FROM users WHERE role = 'user'");

    const eligibleGuarantors = [];
    for (const u of allUsers) {
      if (u.id === req.user.id) continue; // 排除自己
      const result = await guaranteeEngine.checkGuarantorEligibility(u.id, Number(loanAmount));
      logger.info('担保人资格检查', {
        userId: u.id,
        username: u.username,
        loanAmount: Number(loanAmount),
        eligible: result.eligible,
        reason: result.reason || null
      });
      if (result.eligible) {
        eligibleGuarantors.push(result.guarantor);
      }
    }
    logger.info('担保人列表结果', { count: eligibleGuarantors.length, totalUsers: allUsers.length });

    res.json({ success: true, guarantors: eligibleGuarantors });
  } catch (error) {
    logger.error('获取可选担保人失败', { error: error.message });
    res.status(500).json({ success: false, message: '获取可选担保人失败' });
  }
});

// 创建担保邀约
const requestSchema = Joi.object({
  guarantorId: Joi.number().integer().positive().required(),
  loanAmount: Joi.number().min(1).max(50000).required(),
  borrowerSignature: Joi.string().min(64).max(512).required(),
  // 前端（Borrow.js → useRiskEnhancement.createGuaranteeRequest）直传 /credit/:userId 返回的完整证明对象
  // （含 verificationCode/creditScore/expiresAt/proofData/sm3Hash 等）；validate 已收严 allowUnknown:false，
  // 嵌套对象须显式 .unknown(true)（与 validators.js 四条 schema 的 creditProof 同口径）
  creditProof: Joi.object({
    id: Joi.string().required(),
    proof: Joi.any().optional(),
    publicSignals: Joi.any().optional(),
  }).unknown(true).required(),
  verificationCode: Joi.string().min(6).max(128).required()
});

router.post('/request', validate(requestSchema), async (req, res) => {
  try {
    const { guarantorId, loanAmount, borrowerSignature, creditProof, verificationCode } = req.body;
    const borrowerId = req.user.id;

    const result = await guaranteeRequestService.createRequest(
      borrowerId, guarantorId, loanAmount, borrowerSignature, creditProof, verificationCode
    );

    res.json({
      success: true,
      // 阶段2 L：createRequest 返回 { request, feeInfo }，邀约 id 在 result.request.id
      requestId: result.request.id,
      feeInfo: result.feeInfo
    });
  } catch (error) {
    logger.error('创建担保邀约失败', { error: error.message, borrowerId: req.user.id });
    res.status(400).json({ success: false, message: error.message });
  }
});

// 接受担保邀约
const acceptSchema = Joi.object({
  guarantorSignature: Joi.string().min(64).max(512).required()
});

router.post('/accept/:requestId', validate(acceptSchema), async (req, res) => {
  try {
    const { requestId } = req.params;
    const { guarantorSignature } = req.body;

    // 身份校验：只有担保人可以接受邀约
    const guaranteeRequestDao = require('../dao/guaranteeRequestDao');
    const requestCheck = await guaranteeRequestDao.findById(parseInt(requestId));
    if (!requestCheck) {
      return res.status(404).json({ success: false, message: '担保邀约不存在' });
    }
    if (requestCheck.guarantor_id !== req.user.id) {
      return res.status(403).json({ success: false, message: '无权操作此担保邀约' });
    }

    const result = await guaranteeRequestService.acceptRequest(
      parseInt(requestId), guarantorSignature
    );

    res.json({ success: true, requestId: result.requestId, status: result.status });
  } catch (error) {
    logger.error('接受担保邀约失败', { error: error.message, requestId: req.params.requestId });
    res.status(400).json({ success: false, message: error.message });
  }
});

// 拒绝担保邀约
router.post('/reject/:requestId', async (req, res) => {
  try {
    const { requestId } = req.params;

    // 身份校验：只有担保人可以拒绝邀约
    const guaranteeRequestDao = require('../dao/guaranteeRequestDao');
    const requestCheck = await guaranteeRequestDao.findById(parseInt(requestId));
    if (!requestCheck) {
      return res.status(404).json({ success: false, message: '担保邀约不存在' });
    }
    if (requestCheck.guarantor_id !== req.user.id) {
      return res.status(403).json({ success: false, message: '无权操作此担保邀约' });
    }

    const result = await guaranteeRequestService.rejectRequest(parseInt(requestId));
    res.json({ success: true, requestId: result.requestId, status: result.status });
  } catch (error) {
    logger.error('拒绝担保邀约失败', { error: error.message, requestId: req.params.requestId });
    res.status(400).json({ success: false, message: error.message });
  }
});

// 获取借款人已接受的担保请求（供借款人发起阶段2借款）
router.get('/accepted-requests', async (req, res) => {
  try {
    const borrowerId = req.user.id;
    const guaranteeRequestDao = require('../dao/guaranteeRequestDao');
    const requests = await guaranteeRequestDao.findByBorrowerId(borrowerId, { status: 'ACCEPTED' });

    // 补充担保人信息（包含担保次数）
    const userDao = require('../dao/userDao');
    const guaranteeContractDao = require('../dao/guaranteeContractDao');
    const enriched = [];
    for (const req of requests) {
      const guarantor = await userDao.findById(req.guarantor_id);
      const guaranteeCount = await guaranteeContractDao.countByGuarantorId(req.guarantor_id, 'ACTIVE')
        + await guaranteeContractDao.countByGuarantorId(req.guarantor_id, 'COMPLETED');
      enriched.push({
        ...req,
        guarantor: guarantor ? {
          id: guarantor.id,
          username: guarantor.username,
          creditScore: guarantor.credit_score,
          guaranteeCount,
        } : null,
      });
    }

    res.json({ success: true, requests: enriched });
  } catch (error) {
    logger.error('获取已接受担保请求失败', { error: error.message });
    res.status(500).json({ success: false, message: '获取已接受担保请求失败' });
  }
});

// 获取待处理邀约列表
router.get('/pending-requests', async (req, res) => {
  try {
    const guarantorId = req.user.id;
    const requests = await guaranteeRequestService.getPendingRequests(guarantorId);
    res.json({ success: true, requests });
  } catch (error) {
    logger.error('获取待处理邀约失败', { error: error.message });
    res.status(500).json({ success: false, message: '获取待处理邀约失败' });
  }
});

// 获取担保合约详情
router.get('/contract/:contractId', async (req, res) => {
  try {
    const { contractId } = req.params;
    const guaranteeContractDao = require('../dao/guaranteeContractDao');
    const contract = await guaranteeContractDao.findById(parseInt(contractId));
    if (!contract) {
      return res.status(404).json({ success: false, message: '担保合约不存在' });
    }
    // 权限检查：只有借款人或担保人可以查看
    if (contract.borrower_id !== req.user.id && contract.guarantor_id !== req.user.id) {
      return res.status(403).json({ success: false, message: '无权查看此担保合约' });
    }
    res.json({ success: true, contract });
  } catch (error) {
    logger.error('获取担保合约失败', { error: error.message });
    res.status(500).json({ success: false, message: '获取担保合约失败' });
  }
});

module.exports = router;
