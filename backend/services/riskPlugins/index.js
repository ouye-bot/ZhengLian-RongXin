const { transaction } = require('../../config/database');
const logger = require('../../utils/logger');

const FEATURE_ENABLED = process.env.FEATURE_RISK_ENHANCE === 'ON';

let marginEngine, guaranteeEngine, guaranteeRequestService, notificationService;

if (FEATURE_ENABLED) {
  marginEngine = require('./marginEngine');
  guaranteeEngine = require('./guaranteeEngine');
  guaranteeRequestService = require('./guaranteeRequestService');
  notificationService = require('./notificationService');
  logger.info('风控增强插件已加载');
} else {
  logger.info('风控增强插件未启用（FEATURE_RISK_ENHANCE != ON）');
}

/**
 * beforeBorrow hook — 在借款前执行风控增强逻辑
 * @param {Object} params - { userId, amount, term, creditScore, riskMode, marginAmount, guaranteeRequestId }
 * @returns {Object} { success, marginOrder?, guaranteeContract?, feeInfo? }
 */
exports.beforeBorrow = async (params) => {
  if (!FEATURE_ENABLED) return { success: true, skipped: true };

  const { userId, amount, term, creditScore, riskMode, marginAmount, guaranteeRequestId } = params;

  if (riskMode === 1) {
    // 押金模式：服务端按 calculateMargin 强核押金金额（阶段2 I），
    // 不足直接拒绝——杜绝"低押金高额度"绕过；并落真实 margin_rate
    logger.info('beforeBorrow: 押金模式处理', { userId, marginAmount });
    const marginInfo = marginEngine.calculateMargin(amount, creditScore || 600, term);
    const requested = Math.round(Number(marginAmount || 0) * 100) / 100;
    if (requested + 0.005 < marginInfo.marginAmount) {
      throw new Error(`押金金额不足：需至少 ¥${marginInfo.marginAmount}（费率 ${marginInfo.marginRate}），实际 ¥${requested}`);
    }
    const marginOrder = await marginEngine.freezeMargin(userId, marginAmount, null, marginInfo.marginRate);
    return { success: true, marginOrder };
  }

  if (riskMode === 2) {
    // 担保模式：验证邀约状态，创建合约，锁定担保人额度
    logger.info('beforeBorrow: 担保模式处理', { userId, guaranteeRequestId });

    const guaranteeRequestDao = require('../../dao/guaranteeRequestDao');
    const request = await guaranteeRequestDao.findById(guaranteeRequestId);

    if (!request || request.status !== 'ACCEPTED') {
      throw new Error('担保邀约状态异常，无法提交借款');
    }

    // 校验借款金额不超过担保邀约金额
    const guaranteedAmount = Number(request.loan_amount) || 0;
    if (amount > guaranteedAmount) {
      throw new Error(`借款金额${amount}超过担保邀约金额${guaranteedAmount}，请调整借款金额`);
    }

    // 创建担保合约
    const guaranteeContractDao = require('../../dao/guaranteeContractDao');

    // 计算担保费（包含忠诚度奖励）
    const { getInterestRate } = require('../../utils/interestRate');
    const baseRate = (getInterestRate(creditScore || 600) || 10) / 100;
    const completedCount = await guaranteeContractDao.countByGuarantorId(request.guarantor_id, 'COMPLETED');
    const feeInfo = guaranteeEngine.calculateGuaranteeFee(amount, baseRate, completedCount);
    const contract = await guaranteeContractDao.create({
      loan_id: null, // 还没有借款记录，稍后通过 updateGuaranteeContractLoanId 更新
      borrower_id: userId,
      guarantor_id: request.guarantor_id,
      guarantee_amount: amount,
      fee_rate: feeInfo.feeRate,
      fee_amount: feeInfo.feeAmount,
      guarantor_signature: request.guarantor_signature,
      signature_data: JSON.stringify({ requestId: guaranteeRequestId }),
      status: 'PENDING'
    });

    // 将担保邀约状态改为 USED，防止重复借款
    await guaranteeRequestDao.updateStatus(guaranteeRequestId, 'USED');
    logger.info('担保邀约已标记为USED', { guaranteeRequestId, contractId: contract.id });

    // 锁定担保人额度（两阶段提交第一阶段）
    await guaranteeEngine.lockGuarantorQuota(contract.id);

    return { success: true, guaranteeContract: contract, feeInfo };
  }

  return { success: true, skipped: true };
};

/**
 * afterRepay hook — 还款成功后执行风控增强结算
 * @param {Object} params - { userId, transactionId, loanId, isOverdue, overdueDays }
 * @returns {Object} { success }
 */
exports.afterRepay = async (params) => {
  if (!FEATURE_ENABLED) return { success: true, skipped: true };

  return await transaction(async (connection) => {
    const { userId, transactionId, loanId } = params;
    // 阶段2 B：逾期>15 天的清算/代偿已迁出还款钩子，统一由
    // overdueService.liquidateOverdueLoans（小时级定时任务+启动挂载）执行，
    // 避免"还不进又不清算"的死锁窗口与重复清算竞态。

    const marginOrderDao = require('../../dao/marginOrderDao');
    const guaranteeContractDao = require('../../dao/guaranteeContractDao');
    const { updateCreditScore } = require('../dynamicConfigService');

    {
      // 正常还款或短期逾期：释放保证金/结算担保收益
      logger.info('afterRepay: 正常还款处理', { userId, loanId });

      // 检查保证金订单
      const existingMarginOrder = await marginOrderDao.findByLoanId(loanId);
      if (existingMarginOrder && existingMarginOrder.status === 'FROZEN') {
        await marginEngine.releaseMargin(loanId);
        logger.info('保证金已释放', { loanId });
      }

      // 检查担保合约
      const existingContract = await guaranteeContractDao.findByLoanId(loanId);
      if (existingContract && existingContract.status === 'ACTIVE') {
        await guaranteeEngine.settleGuaranteeRevenue(existingContract.id);
        await guaranteeEngine.releaseGuarantorQuota(existingContract.id);

        // 信用分联动：担保成功，担保人 +2 分
        try {
          const guarantorId = existingContract.guarantor_id;
          await updateCreditScore(guarantorId, 2, '担保成功奖励', transactionId);
          logger.info('担保人信用分奖励', { guarantorId, delta: 2, contractId: existingContract.id });
        } catch (scoreErr) {
          logger.error('担保人信用分更新失败', { error: scoreErr.message });
        }

        logger.info('担保收益已结算，额度已释放', { loanId, contractId: existingContract.id });
      }
    }

    return { success: true };
  });
};

/**
 * 更新保证金订单的loan_id（借款记录创建后调用）
 */
exports.updateMarginOrderLoanId = async (marginOrderId, loanId) => {
  if (!FEATURE_ENABLED) return;
  const marginOrderDao = require('../../dao/marginOrderDao');
  await marginOrderDao.updateStatus(marginOrderId, 'FROZEN', {}, undefined);
  const { execute } = require('../../config/database');
  await execute('UPDATE risk_margin_orders SET loan_id = ? WHERE id = ?', [loanId, marginOrderId]);
};

/**
 * 更新担保合约的loan_id（借款记录创建后调用）
 */
exports.updateGuaranteeContractLoanId = async (contractId, loanId) => {
  if (!FEATURE_ENABLED) return;
  const guaranteeContractDao = require('../../dao/guaranteeContractDao');
  await guaranteeContractDao.updateStatus(contractId, 'ACTIVE', { loan_id: loanId });
};

/**
 * onPartialRepay hook — 部分还款时按比例释放担保额度
 * @param {Object} params - { loanId, repaidPrincipal, totalPrincipal }
 */
exports.onPartialRepay = async (params) => {
  if (!FEATURE_ENABLED) return;
  const { loanId, repaidPrincipal, totalPrincipal } = params;
  try {
    const guaranteeContractDao = require('../../dao/guaranteeContractDao');
    const contract = await guaranteeContractDao.findByLoanId(loanId);
    if (contract && contract.status === 'ACTIVE') {
      await guaranteeEngine.releasePartialGuarantee(
        contract.id, repaidPrincipal, totalPrincipal
      );
      logger.info('部分还款担保额度已释放', {
        loanId, contractId: contract.id, repaidPrincipal, totalPrincipal
      });
    }
  } catch (error) {
    // 不阻塞还款流程
    logger.error('部分还款担保释放失败', { loanId, error: error.message });
  }
};

module.exports = {
  beforeBorrow: exports.beforeBorrow,
  afterRepay: exports.afterRepay,
  onPartialRepay: exports.onPartialRepay,
  updateMarginOrderLoanId: exports.updateMarginOrderLoanId,
  updateGuaranteeContractLoanId: exports.updateGuaranteeContractLoanId,
  isFeatureEnabled: () => FEATURE_ENABLED
};
