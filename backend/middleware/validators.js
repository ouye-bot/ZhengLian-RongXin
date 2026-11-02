const Joi = require('joi');

// 借款接口校验规则
// 前端字段（Borrow.js borrowData）：userId/amount/creditProof/verificationCode/term/signature/risk_mode/margin_amount/guarantee_request_id；
// 大额借款触发挑战后二次提交追加 challengeId/challengeSignature（Borrow.js 二次 post），validate 已收严 allowUnknown:false，须在此登记。
const borrowSchema = Joi.object({
  userId: Joi.number().integer().positive().required(),
  amount: Joi.number().min(100).max(50000).required(),
  creditProof: Joi.object({
    id: Joi.string().required(),
    verificationCode: Joi.string().optional(),
    creditScore: Joi.number().min(300).max(850).optional()
  }).unknown(true).required(),
  verificationCode: Joi.string().required(),
  signature: Joi.string().min(64).max(512).required(),
  term: Joi.number().integer().valid(7, 14, 30, 60, 90).optional().default(30),
  risk_mode: Joi.number().integer().valid(0, 1, 2).optional().default(0),
  margin_amount: Joi.number().min(0).optional().default(0),
  guarantee_request_id: Joi.number().integer().positive().optional().allow(null),
  // 大额挑战二次提交（loan.js challengeService 校验）
  challengeId: Joi.string().optional(),
  challengeSignature: Joi.string().optional()
});

// 还款接口校验规则
const repaySchema = Joi.object({
  userId: Joi.number().integer().positive().required(),
  transactionId: Joi.number().integer().positive().required(),
  creditProof: Joi.object({
    id: Joi.string().required()
  }).unknown(true).required(),
  verificationCode: Joi.string().required(),
  signature: Joi.string().min(64).max(256).required(),
  partialAmount: Joi.number().positive().optional()
});

// 出资接口校验规则
const investSchema = Joi.object({
  userId: Joi.number().integer().positive().required(),
  amount: Joi.number().integer().min(100).max(100000).required(),
  term: Joi.number().integer().min(7).max(365).required(),
  creditProof: Joi.object({
    id: Joi.string().required()
  }).unknown(true).required(),
  verificationCode: Joi.string().required(),
  signature: Joi.string().min(64).max(256).required()
});

// 赎回接口校验规则
// 前端字段（RedeemPage.js redeemRequestData）：userId/amount/creditProof/verificationCode/signature；
// 大额赎回触发挑战后二次提交追加 challengeId/challengeSignature（RedeemPage.js 二次 post）。
const redeemSchema = Joi.object({
  userId: Joi.number().integer().positive().required(),
  amount: Joi.number().integer().min(100).max(50000).required(),
  creditProof: Joi.object({
    id: Joi.string().required()
  }).unknown(true).required(),
  verificationCode: Joi.string().required(),
  signature: Joi.string().min(64).max(256).required(),
  // 大额挑战二次提交（redeem.js challengeService 校验）
  challengeId: Joi.string().optional(),
  challengeSignature: Joi.string().optional()
});

module.exports = {
  borrowSchema,
  repaySchema,
  investSchema,
  redeemSchema
};