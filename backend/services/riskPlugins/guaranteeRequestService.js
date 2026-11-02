const guaranteeRequestDao = require('../../dao/guaranteeRequestDao');
const guaranteeEngine = require('./guaranteeEngine');
const notificationService = require('./notificationService');
const userDao = require('../../dao/userDao');
const proofDao = require('../../dao/proofDao');
const cryptoNode = require('crypto');
const { verifySM2Signature, buildSignatureData } = require('../../utils/cryptoUtils');
const logger = require('../../utils/logger');

class GuaranteeRequestService {
  /**
   * 创建担保请求
   * @param {number} borrowerId - 借款人ID
   * @param {number} guarantorId - 担保人ID
   * @param {number} loanAmount - 贷款金额
   * @param {string} borrowerSignature - 借款人SM2签名
   * @param {Object} creditProof - 信用证明 { id, proof?, publicSignals? }
   * @param {string} verificationCode - 验证口令
   * @returns {Promise<{request: Object, feeInfo: Object}>} - 创建的请求和费用信息
   */
  async createRequest(borrowerId, guarantorId, loanAmount, borrowerSignature, creditProof, verificationCode) {
    try {
      logger.info('创建担保请求', { borrowerId, guarantorId, loanAmount });

      // 1. 验证借款人信用证明（确保信用分真实性）
      if (!creditProof || !creditProof.id) {
        throw new Error('缺少信用证明');
      }
      const matchingProof = await proofDao.findByProofId(creditProof.id);
      if (!matchingProof || new Date(matchingProof.expires_at) <= new Date()) {
        throw new Error('信用证明无效或已过期');
      }
      let codeValid = false;
      if (matchingProof.verification_code && verificationCode) {
        const a = Buffer.from(matchingProof.verification_code, 'utf8');
        const b = Buffer.from(verificationCode, 'utf8');
        codeValid = a.length === b.length && cryptoNode.timingSafeEqual(a, b);
      }
      if (!codeValid) {
        throw new Error('信用证明验证口令无效');
      }
      // 从信用证明中提取已验证的信用分
      let verifiedCreditScore = null;
      try {
        const proofData = JSON.parse(matchingProof.proof_data);
        verifiedCreditScore = proofData.creditScore || proofData.credit_score;
      } catch (e) {
        logger.warning('信用证明数据解析失败，降级使用用户信用分', { proofId: creditProof.id });
      }

      // 2. 检查担保人资格
      const eligibility = await guaranteeEngine.checkGuarantorEligibility(guarantorId, loanAmount);
      if (!eligibility.eligible) {
        throw new Error(`担保人不符合资格: ${eligibility.reason}`);
      }

      // 3. 获取借款人信息用于SM2签名验证
      const borrower = await userDao.findById(borrowerId);
      if (!borrower) {
        throw new Error('借款人不存在');
      }

      if (!borrower.sm2_public_key) {
        throw new Error('借款人未注册SM2公钥');
      }

      // 4. 使用验证后的信用分计算担保费
      const { getInterestRate } = require('../../utils/interestRate');
      const effectiveCreditScore = verifiedCreditScore || borrower.credit_score || 600;
      const baseRate = getInterestRate(effectiveCreditScore) / 100;
      const feeInfo = guaranteeEngine.calculateGuaranteeFee(loanAmount, baseRate);

      // 5. 验证借款人SM2签名
      const signatureData = buildSignatureData(
        { borrowerId: String(borrowerId), guarantorId: String(guarantorId), loanAmount: String(loanAmount) },
        ['borrowerId', 'guarantorId', 'loanAmount']
      );
      const isSignatureValid = verifySM2Signature(signatureData, borrowerSignature, borrower.sm2_public_key);

      if (!isSignatureValid) {
        throw new Error('借款人SM2签名验证失败');
      }

      // 6. 创建担保请求（expire_time默认24小时后，由DAO处理）
      const request = await guaranteeRequestDao.create({
        borrower_id: borrowerId,
        guarantor_id: guarantorId,
        loan_amount: loanAmount,
        proposed_fee_rate: feeInfo.feeRate,
        borrower_signature: borrowerSignature,
      });

      // 6. 发送通知给担保人
      await notificationService.sendGuaranteeRequestNotification(
        guarantorId,
        borrower.username,
        loanAmount,
        request.id
      );

      logger.info('担保请求创建成功', { requestId: request.id, borrowerId, guarantorId });

      return { request, feeInfo };
    } catch (error) {
      logger.error('创建担保请求失败', {
        borrowerId,
        guarantorId,
        loanAmount,
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * 接受担保请求
   * @param {number} requestId - 担保请求ID
   * @param {string} guarantorSignature - 担保人SM2签名
   * @returns {Promise<{requestId: number, status: string}>} - 请求ID和状态
   */
  async acceptRequest(requestId, guarantorSignature) {
    try {
      logger.info('接受担保请求', { requestId });

      // 1. 查找请求并验证状态
      const request = await guaranteeRequestDao.findById(requestId);
      if (!request) {
        throw new Error('担保请求不存在');
      }

      if (request.status !== 'PENDING') {
        throw new Error(`担保请求状态无效: ${request.status}`);
      }

      // 2. 检查是否过期
      if (new Date(request.expire_time) < new Date()) {
        throw new Error('担保请求已过期');
      }

      // 3. 获取担保人信息用于SM2签名验证
      const guarantor = await userDao.findById(request.guarantor_id);
      if (!guarantor) {
        throw new Error('担保人不存在');
      }

      if (!guarantor.sm2_public_key) {
        throw new Error('担保人未注册SM2公钥');
      }

      // 4. 验证担保人SM2签名
      const signatureData = buildSignatureData(
        {
          requestId: String(requestId),
          guarantorId: String(request.guarantor_id),
          loanAmount: String(request.loan_amount),
        },
        ['guarantorId', 'loanAmount', 'requestId']
      );
      const isSignatureValid = verifySM2Signature(signatureData, guarantorSignature, guarantor.sm2_public_key);

      if (!isSignatureValid) {
        throw new Error('担保人SM2签名验证失败');
      }

      // 5. 更新请求状态为ACCEPTED，记录担保人签名
      await guaranteeRequestDao.updateStatus(requestId, 'ACCEPTED', {
        guarantor_signature: guarantorSignature,
      });

      // 6. 通知借款人
      const borrower = await userDao.findById(request.borrower_id);
      if (borrower) {
        await notificationService.sendGuaranteeAcceptedNotification(
          request.borrower_id,
          guarantor.username,
          requestId
        );
      }

      logger.info('担保请求已接受', { requestId, guarantorId: request.guarantor_id });

      return { requestId, status: 'ACCEPTED' };
    } catch (error) {
      logger.error('接受担保请求失败', { requestId, error: error.message });
      throw error;
    }
  }

  /**
   * 拒绝担保请求
   * @param {number} requestId - 担保请求ID
   * @returns {Promise<{requestId: number, status: string}>} - 请求ID和状态
   */
  async rejectRequest(requestId) {
    try {
      logger.info('拒绝担保请求', { requestId });

      // 1. 查找请求并验证状态
      const request = await guaranteeRequestDao.findById(requestId);
      if (!request) {
        throw new Error('担保请求不存在');
      }

      if (request.status !== 'PENDING') {
        throw new Error(`担保请求状态无效: ${request.status}`);
      }

      // 2. 更新状态为REJECTED
      await guaranteeRequestDao.updateStatus(requestId, 'REJECTED');

      // 3. 通知借款人
      const guarantor = await userDao.findById(request.guarantor_id);
      const borrower = await userDao.findById(request.borrower_id);
      if (borrower && guarantor) {
        await notificationService.sendGuaranteeRejectedNotification(
          request.borrower_id,
          guarantor.username,
          requestId
        );
      }

      logger.info('担保请求已拒绝', { requestId, guarantorId: request.guarantor_id });

      return { requestId, status: 'REJECTED' };
    } catch (error) {
      logger.error('拒绝担保请求失败', { requestId, error: error.message });
      throw error;
    }
  }

  /**
   * 获取担保人的待处理请求
   * @param {number} guarantorId - 担保人ID
   * @returns {Promise<Array>} - 待处理请求列表（含借款人信息）
   */
  async getPendingRequests(guarantorId) {
    try {
      const requests = await guaranteeRequestDao.findPendingByGuarantorId(guarantorId);

      // 丰富每个请求的借款人信息
      const enrichedRequests = await Promise.all(
        requests.map(async (req) => {
          const borrower = await userDao.findById(req.borrower_id);
          return {
            ...req,
            borrower: borrower
              ? {
                  username: borrower.username,
                  creditScore: borrower.credit_score,
                }
              : null,
          };
        })
      );

      return enrichedRequests;
    } catch (error) {
      logger.error('获取待处理担保请求失败', { guarantorId, error: error.message });
      throw error;
    }
  }

  /**
   * 清理过期的担保请求
   * @returns {Promise<number>} - 影响的行数
   */
  async cleanExpiredRequests() {
    return await notificationService.cleanExpiredGuaranteeRequests();
  }
}

module.exports = new GuaranteeRequestService();
