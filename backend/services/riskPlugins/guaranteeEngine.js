/**
 * GuaranteeEngine - 担保模式核心引擎
 *
 * 职责：
 *   1. 担保人资格校验
 *   2. 担保费计算与分配
 *   3. 担保配额锁定 / 释放
 *   4. 担保收入结算
 *   5. 担保代偿执行
 */

const { transaction } = require('../../config/database');
const { invalidatePoolReadCaches } = require('../../utils/ttlCache');
const guaranteeContractDao = require('../../dao/guaranteeContractDao');
const userDao = require('../../dao/userDao');
const transactionDao = require('../../dao/transactionDao');
const { encryptFields, decryptFields } = require('../../utils/sm4Crypto');
const logger = require('../../utils/logger');

// ─── 配置参数 ──────────────────────────────────────────────────────────────────
const GUARANTEE_FEE_RATE_MULTIPLIER = Number(process.env.GUARANTEE_FEE_RATE_MULTIPLIER ?? 0.15);
const GUARANTEE_INSURANCE_FUND_RATIO = Number(process.env.GUARANTEE_INSURANCE_FUND_RATIO ?? 0.20);
const GUARANTEE_BORROWER_REWARD_RATIO = Number(process.env.GUARANTEE_BORROWER_REWARD_RATIO ?? 0.10);
const GUARANTEE_COMPENSATION_THRESHOLD_DAYS = Number(process.env.GUARANTEE_COMPENSATION_THRESHOLD_DAYS ?? 15);
const GUARANTEE_MAX_RATIO_TO_NET_ASSET = Number(process.env.GUARANTEE_MAX_RATIO_TO_NET_ASSET ?? 2.0);
const GUARANTEE_MAX_ACTIVE_CONTRACTS = Number(process.env.GUARANTEE_MAX_ACTIVE_CONTRACTS ?? 5);
const GUARANTEE_MIN_CREDIT_SCORE = Number(process.env.GUARANTEE_MIN_CREDIT_SCORE ?? 650);
const GUARANTEE_MIN_REGISTRATION_DAYS = Number(process.env.GUARANTEE_MIN_REGISTRATION_DAYS ?? 180);

// ─── 担保人激励参数 ──────────────────────────────────────────────────────────
const GUARANTEE_LOYALTY_THRESHOLDS = [
  { count: 3, bonusRatio: 0.05 },   // 完成3次担保：额外5%奖励
  { count: 5, bonusRatio: 0.10 },   // 完成5次担保：额外10%奖励
  { count: 10, bonusRatio: 0.15 },  // 完成10次担保：额外15%奖励
  { count: 20, bonusRatio: 0.20 },  // 完成20次担保：额外20%奖励
];
const GUARANTEE_FEE_DISCOUNT_THRESHOLDS = [
  { count: 3, discount: 0.05 },     // 完成3次担保：费率减免5%
  { count: 5, discount: 0.10 },     // 完成5次担保：费率减免10%
  { count: 10, discount: 0.15 },    // 完成10次担保：费率减免15%
];

/**
 * GuaranteeEngine
 */
class GuaranteeEngine {
  /**
   * 检查担保人资格
   * @param {number|string} guarantorId - 担保人用户ID
   * @param {number} loanAmount - 贷款金额
   * @returns {Promise<{eligible: boolean, reason?: string, guarantor?: object}>}
   */
  async checkGuarantorEligibility(guarantorId, loanAmount) {
    try {
      const user = await userDao.findById(guarantorId);
      if (!user) {
        return { eligible: false, reason: '用户不存在' };
      }

      // 信用分检查（userDao.findById 已解密 credit_score）
      const creditScore = Number(user.credit_score) || 0;
      if (creditScore < GUARANTEE_MIN_CREDIT_SCORE) {
        return {
          eligible: false,
          reason: `信用分不足：当前${creditScore}，最低要求${GUARANTEE_MIN_CREDIT_SCORE}`,
        };
      }

      // 注册时长检查
      const registrationDays = Math.floor(
        (Date.now() - new Date(user.created_at).getTime()) / (1000 * 60 * 60 * 24)
      );
      if (registrationDays < GUARANTEE_MIN_REGISTRATION_DAYS) {
        return {
          eligible: false,
          reason: `注册时长不足：当前${registrationDays}天，最低要求${GUARANTEE_MIN_REGISTRATION_DAYS}天`,
        };
      }

      // 无逾期贷款：贷款 due_date < now 且 status = 'pending'
      const overdueRecords = await transactionDao.findByUserId(user.id, {
        type: 'loan',
        status: 'pending',
      });
      const now = Date.now();
      const hasOverdue = overdueRecords.some(
        (r) => r.due_date && new Date(r.due_date).getTime() < now
      );
      if (hasOverdue) {
        return { eligible: false, reason: '存在逾期贷款，暂不具备担保资格' };
      }

      // 余额检查：担保需冻结贷款全额，余额必须 >= loanAmount
      const balance = Number(user.balance) || 0;
      if (balance < loanAmount) {
        return {
          eligible: false,
          reason: `可用余额不足：当前${balance}，需冻结${loanAmount}（担保金额 = 借款金额）`,
        };
      }

      // 在保总额 + 本次贷款 <= 余额 * GUARANTEE_MAX_RATIO_TO_NET_ASSET
      const activeContracts = await guaranteeContractDao.findActiveByGuarantorId(user.id);
      const totalGuaranteed = activeContracts.reduce(
        (sum, c) => sum + (Number(c.guarantee_amount) || 0),
        0
      );
      const maxCapacity = balance * GUARANTEE_MAX_RATIO_TO_NET_ASSET;
      if (totalGuaranteed + loanAmount > maxCapacity) {
        return {
          eligible: false,
          reason: `担保总额超限：已担保${totalGuaranteed}，本次${loanAmount}，上限${maxCapacity}`,
        };
      }

      // 活跃合约数 < GUARANTEE_MAX_ACTIVE_CONTRACTS
      if (activeContracts.length >= GUARANTEE_MAX_ACTIVE_CONTRACTS) {
        return {
          eligible: false,
          reason: `活跃担保合约已达上限：${activeContracts.length}/${GUARANTEE_MAX_ACTIVE_CONTRACTS}`,
        };
      }

      // 统计担保次数（活跃 + 已完成）
      const activeCount = await guaranteeContractDao.countByGuarantorId(user.id, 'ACTIVE');
      const completedCount = await guaranteeContractDao.countByGuarantorId(user.id, 'COMPLETED');
      const guaranteeCount = activeCount + completedCount;

      // 返回脱敏后的担保人信息
      const safeGuarantor = {
        id: user.id,
        username: user.username,
        credit_score: user.credit_score,
        balance: user.balance,
        role: user.role,
        created_at: user.created_at,
        guaranteeCount,
      };
      return { eligible: true, guarantor: safeGuarantor };
    } catch (error) {
      logger.error('担保人资格检查失败', {
        guarantorId,
        loanAmount,
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * 计算担保费及分配
   * @param {number} loanAmount - 贷款金额
   * @param {number} baseRate - 基础利率（如 0.12 表示12%）
   * @param {number} [completedCount=0] - 担保人已完成的担保次数（用于忠诚度奖励）
   * @returns {{feeRate: number, feeAmount: number, distribution: {guarantor: number, insuranceFund: number, borrowerReward: number}, loyaltyBonus: number}}
   */
  calculateGuaranteeFee(loanAmount, baseRate, completedCount = 0) {
    // 计算费率折扣（忠诚度优惠）
    let feeDiscount = 0;
    for (const threshold of GUARANTEE_FEE_DISCOUNT_THRESHOLDS) {
      if (completedCount >= threshold.count) {
        feeDiscount = threshold.discount;
      }
    }

    const feeRate = baseRate * GUARANTEE_FEE_RATE_MULTIPLIER * (1 - feeDiscount);
    const feeAmount = loanAmount * feeRate;

    // 担保人份额 = 1 - 保险基金 - 借款人奖励
    const guarantorRatio = 1 - GUARANTEE_INSURANCE_FUND_RATIO - GUARANTEE_BORROWER_REWARD_RATIO;

    // 计算忠诚度奖励
    let loyaltyBonusRatio = 0;
    for (const threshold of GUARANTEE_LOYALTY_THRESHOLDS) {
      if (completedCount >= threshold.count) {
        loyaltyBonusRatio = threshold.bonusRatio;
      }
    }
    const loyaltyBonus = feeAmount * guarantorRatio * loyaltyBonusRatio;

    return {
      feeRate,
      feeAmount,
      feeDiscount,
      distribution: {
        guarantor: feeAmount * guarantorRatio,
        insuranceFund: feeAmount * GUARANTEE_INSURANCE_FUND_RATIO,
        borrowerReward: feeAmount * GUARANTEE_BORROWER_REWARD_RATIO,
      },
      loyaltyBonus,
      loyaltyBonusRatio,
    };
  }

  /**
   * 锁定担保人配额（事务）
   * 将担保金额冻结到 frozen_balance，不动用 balance（与保证金模式一致）
   * @param {number} contractId - 担保合约ID
   * @returns {Promise<object>} 更新后的合约
   */
  async lockGuarantorQuota(contractId) {
    return await transaction(async (connection) => {
      const contract = await guaranteeContractDao.findById(contractId, connection);
      if (!contract) {
        throw new Error(`担保合约不存在: ${contractId}`);
      }

      const guarantorId = contract.guarantor_id;
      const guaranteeAmount = Number(contract.guarantee_amount) || 0;

      // 锁定担保人余额 FOR UPDATE
      const [userRows] = await connection.execute(
        'SELECT id, balance, frozen_balance FROM users WHERE id = ? FOR UPDATE',
        [guarantorId]
      );
      if (!userRows || userRows.length === 0) {
        throw new Error(`担保人不存在: ${guarantorId}`);
      }

      const balanceRow = { balance: userRows[0].balance, frozen_balance: userRows[0].frozen_balance };
      await decryptFields('users', balanceRow, guarantorId, connection);
      const currentBalance = Number(balanceRow.balance) || 0;
      const currentFrozen = Number(balanceRow.frozen_balance) || 0;

      if (currentBalance < guaranteeAmount) {
        throw new Error(
          `担保人余额不足以冻结担保金：余额${currentBalance}，需冻结${guaranteeAmount}`
        );
      }

      // 将担保金额从 balance 转入 frozen_balance（类似保证金冻结）
      const newBalance = currentBalance - guaranteeAmount;
      const newFrozen = currentFrozen + guaranteeAmount;
      const encData = { balance: newBalance, frozen_balance: newFrozen };
      await encryptFields('users', encData, guarantorId, connection);
      await connection.execute('UPDATE users SET balance = ?, frozen_balance = ? WHERE id = ?', [
        encData.balance,
        encData.frozen_balance,
        guarantorId,
      ]);

      // 更新合约状态为 ACTIVE
      await guaranteeContractDao.updateStatus(contractId, 'ACTIVE', {}, connection);

      logger.info('担保额度已冻结', {
        contractId,
        guarantorId,
        guaranteeAmount,
        frozenBalance: newFrozen,
      });

      return await guaranteeContractDao.findById(contractId, connection);
    });
  }

  /**
   * 释放担保人冻结额度（合约完成）
   * 阶段2 G：只解冻尚未按累计还款比例释放的残余额度（G − released_amount），
   * 并回写 released_amount 至全额，避免对已释放部分重复解冻
   * @param {number} contractId - 担保合约ID
   * @returns {Promise<object>} 更新后的合约
   */
  async releaseGuarantorQuota(contractId) {
    const round2 = (x) => Math.round(x * 100) / 100;
    return await transaction(async (connection) => {
      const contract = await guaranteeContractDao.findById(contractId, connection);
      if (!contract) {
        throw new Error(`担保合约不存在: ${contractId}`);
      }

      const guarantorId = contract.guarantor_id;
      const guaranteeAmount = Number(contract.guarantee_amount) || 0;
      const releasedSoFar = Number(contract.released_amount || 0);
      const remainingQuota = round2(Math.max(0, guaranteeAmount - releasedSoFar));

      // 解冻残余额度：从 frozen_balance 转回 balance
      if (remainingQuota > 0) {
        const [userRows] = await connection.execute(
          'SELECT id, balance, frozen_balance FROM users WHERE id = ? FOR UPDATE',
          [guarantorId]
        );
        if (userRows && userRows.length > 0) {
          const row = { balance: userRows[0].balance, frozen_balance: userRows[0].frozen_balance };
          await decryptFields('users', row, guarantorId, connection);
          const currentBalance = Number(row.balance) || 0;
          const currentFrozen = Number(row.frozen_balance) || 0;
          const releaseAmountClamped = round2(Math.min(currentFrozen, remainingQuota));
          const newBalance = round2(currentBalance + releaseAmountClamped);
          const newFrozen = round2(currentFrozen - releaseAmountClamped);
          const encData = { balance: newBalance, frozen_balance: newFrozen };
          await encryptFields('users', encData, guarantorId, connection);
          await connection.execute('UPDATE users SET balance = ?, frozen_balance = ? WHERE id = ?', [
            encData.balance,
            encData.frozen_balance,
            guarantorId,
          ]);
        }
      }

      // 回写累计释放额至全额（口径收口，幂等）
      await guaranteeContractDao.updateStatus(contractId, 'COMPLETED', { released_amount: guaranteeAmount }, connection);

      logger.info('担保额度已释放', { contractId, guarantorId, guaranteeAmount, releasedSoFar, releasedNow: remainingQuota });

      return await guaranteeContractDao.findById(contractId, connection);
    });
  }

  /**
   * 按累计已还比例增量释放担保额度（部分还款时调用）
   * 阶段2 G 累计口径：目标 released_target = G × 累计已还本金 / 原始本金。
   * 原始本金 = contract.guarantee_amount（G），故目标 = 已释放额 + 本次已还本金（钳位 ≤ G），
   * 本次增量 = 目标 − released_amount（钳位 ≥ 0），解冻后回写 released_amount。
   * @param {number} contractId - 担保合约ID
   * @param {number} repaidPrincipal - 本次已还本金
   * @param {number} totalPrincipal - 还款时的剩余本金（兼容保留，累计口径不再依赖）
   * @returns {Promise<object>} 更新后的合约
   */
  async releasePartialGuarantee(contractId, repaidPrincipal, totalPrincipal) {
    if (repaidPrincipal <= 0) return null;

    const round2 = (x) => Math.round(x * 100) / 100;
    return await transaction(async (connection) => {
      const contract = await guaranteeContractDao.findById(contractId, connection);
      if (!contract || contract.status !== 'ACTIVE') {
        return contract || null;
      }

      const guarantorId = contract.guarantor_id;
      const totalGuarantee = Number(contract.guarantee_amount) || 0;
      const releasedPrev = Number(contract.released_amount || 0);

      // 累计目标与本次增量（钳位）
      const releasedTarget = round2(Math.min(totalGuarantee, releasedPrev + repaidPrincipal));
      const releaseAmount = round2(Math.max(0, releasedTarget - releasedPrev));

      if (releaseAmount <= 0) return contract;

      // 从 frozen_balance 释放增量额度回 balance
      const [userRows] = await connection.execute(
        'SELECT id, balance, frozen_balance FROM users WHERE id = ? FOR UPDATE',
        [guarantorId]
      );
      if (userRows && userRows.length > 0) {
        const row = { balance: userRows[0].balance, frozen_balance: userRows[0].frozen_balance };
        await decryptFields('users', row, guarantorId, connection);
        const currentBalance = Number(row.balance) || 0;
        const currentFrozen = Number(row.frozen_balance) || 0;
        const releaseAmountClamped = round2(Math.min(currentFrozen, releaseAmount));
        const newBalance = round2(currentBalance + releaseAmountClamped);
        const newFrozen = round2(currentFrozen - releaseAmountClamped);
        const encData = { balance: newBalance, frozen_balance: newFrozen };
        await encryptFields('users', encData, guarantorId, connection);
        await connection.execute('UPDATE users SET balance = ?, frozen_balance = ? WHERE id = ?', [
          encData.balance,
          encData.frozen_balance,
          guarantorId,
        ]);
      }

      // 回写累计释放额（与解冻同事务）
      await guaranteeContractDao.updateStatus(contractId, 'ACTIVE', { released_amount: releasedTarget }, connection);

      logger.info('担保额度按累计还款比例增量释放', {
        contractId,
        guarantorId,
        repaidPrincipal,
        totalPrincipal,
        releasedPrev,
        releasedTarget,
        releaseAmount,
      });

      return await guaranteeContractDao.findById(contractId, connection);
    });
  }

  /**
   * 结算担保收入（合约还款后调用）
   * 费用分配：70% 担保人，10% 借款人，20% 平台
   * 担保人额外获得忠诚度奖励
   * @param {number} contractId - 担保合约ID
   * @returns {Promise<object>} 更新后的合约
   */
  async settleGuaranteeRevenue(contractId) {
    const settled = await transaction(async (connection) => {
      const contract = await guaranteeContractDao.findById(contractId, connection);
      if (!contract) {
        throw new Error(`担保合约不存在: ${contractId}`);
      }

      const feeAmount = Number(contract.fee_amount) || 0;
      if (feeAmount <= 0) {
        throw new Error('担保费金额无效，无法结算');
      }

      // 阶段2 C：担保费已随借款人全额还款代收入池（fee_collected=1），此处只做纯分配；
      // 缺该前置说明代收未发生，拒绝结算以免无源发放
      if (Number(contract.fee_collected) !== 1) {
        throw new Error(`担保费尚未代收入池（fee_collected=${contract.fee_collected}），拒绝结算`);
      }

      const guarantorId = contract.guarantor_id;
      const borrowerId = contract.borrower_id;

      // 按ID升序锁定行，避免ABBA死锁
      const [firstId, secondId] = [guarantorId, borrowerId].sort((a, b) => a - b);

      // 分配比例
      const GUARANTOR_SHARE = 0.70;
      const BORROWER_SHARE = 0.10;
      const PLATFORM_SHARE = 0.20;

      // 计算担保人已完成的担保次数（用于忠诚度奖励）
      const completedCount = await guaranteeContractDao.countByGuarantorId(guarantorId, 'COMPLETED', connection);

      const guarantorIncome = feeAmount * GUARANTOR_SHARE;
      const borrowerIncome = feeAmount * BORROWER_SHARE;
      // 平台份额通过差值计算，避免浮点误差
      const platformIncome = feeAmount - guarantorIncome - borrowerIncome;

      // 计算忠诚度奖励
      let loyaltyBonusRatio = 0;
      for (const threshold of GUARANTEE_LOYALTY_THRESHOLDS) {
        if (completedCount >= threshold.count) {
          loyaltyBonusRatio = threshold.bonusRatio;
        }
      }
      const loyaltyBonus = guarantorIncome * loyaltyBonusRatio;

      // 按ID升序锁定用户行，避免并发死锁
      const [firstRows] = await connection.execute(
        'SELECT id, balance FROM users WHERE id = ? FOR UPDATE',
        [firstId]
      );
      if (!firstRows || firstRows.length === 0) {
        throw new Error(`用户不存在: ${firstId}`);
      }

      const [secondRows] = await connection.execute(
        'SELECT id, balance FROM users WHERE id = ? FOR UPDATE',
        [secondId]
      );
      if (!secondRows || secondRows.length === 0) {
        throw new Error(`用户不存在: ${secondId}`);
      }

      // 将锁定的行按角色分配
      const firstIsGuarantor = firstId === guarantorId;
      const guarantorRows = firstIsGuarantor ? firstRows : secondRows;
      const borrowerRows = firstIsGuarantor ? secondRows : firstRows;

      // 更新担保人余额（包含忠诚度奖励）
      const gBalanceRow = { balance: guarantorRows[0].balance };
      await decryptFields('users', gBalanceRow, guarantorId, connection);
      const gCurrentBalance = Number(gBalanceRow.balance) || 0;
      const gNewBalance = gCurrentBalance + guarantorIncome + loyaltyBonus;

      const gEncData = { balance: gNewBalance };
      await encryptFields('users', gEncData, guarantorId, connection);
      await connection.execute('UPDATE users SET balance = ? WHERE id = ?', [
        gEncData.balance,
        guarantorId,
      ]);

      // 更新借款人余额
      const bBalanceRow = { balance: borrowerRows[0].balance };
      await decryptFields('users', bBalanceRow, borrowerId, connection);
      const bCurrentBalance = Number(bBalanceRow.balance) || 0;
      const bNewBalance = bCurrentBalance + borrowerIncome;

      const bEncData = { balance: bNewBalance };
      await encryptFields('users', bEncData, borrowerId, connection);
      await connection.execute('UPDATE users SET balance = ? WHERE id = ?', [
        bEncData.balance,
        borrowerId,
      ]);

      // 阶段2 C 纯分配：担保人 0.7F+loyalty、借款人 0.1F 均从平台池划出（代收时 F 已全额入 PC），
      // PC 净留存 0.2F−loyalty；不再凭空发放
      const [poolRows] = await connection.execute(
        'SELECT * FROM fund_pool WHERE id = 1 FOR UPDATE'
      );
      if (poolRows && poolRows.length > 0) {
        const pool = poolRows[0];
        const poolUC = Number(pool.user_capital || 0);
        const payoutTotal = guarantorIncome + borrowerIncome + loyaltyBonus;
        const poolPC = Math.round((Number(pool.platform_capital || 0) - payoutTotal) * 100) / 100;
        if (poolPC < -0.005) {
          throw new Error(`平台资金不足以支付担保分配：PC=${pool.platform_capital}，应付=${Math.round(payoutTotal * 100) / 100}`);
        }
        const poolLA = Number(pool.loaned_amount || 0);
        const poolTotal = poolPC + poolUC;
        const poolAvail = poolTotal - poolLA;

        await connection.execute(
          `UPDATE fund_pool SET platform_capital=?, total_amount=?, available_amount=? WHERE id=1`,
          [poolPC, poolTotal, poolAvail]
        );
      }

      logger.info('担保收入已结算', {
        contractId,
        guarantorIncome,
        loyaltyBonus,
        borrowerIncome,
        platformIncome,
        completedCount,
        loyaltyBonusRatio,
      });

      return await guaranteeContractDao.findById(contractId, connection);
    });
    invalidatePoolReadCaches(); // 事务已提交（写了 fund_pool）：失效池读缓存
    return settled;
  }

  /**
   * 执行担保代偿（借款人逾期时触发）
   * 从担保人的 frozen_balance 划扣，不足部分从 balance 补
   * 阶段2 B 改造：实收金额入平台池（PC+=实收）、核销贷款剩余本金（LA−=剩余本金）、
   * 利息部分记入平台利息（TIE）、代偿后残余冻结额度退回可用余额（担保义务终止）；
   * 支持传入外部事务 connection（由调用方保证原子性，如违约清算）
   * @param {number} contractId - 担保合约ID
   * @param {number} outstandingAmount - 未还金额（剩余本金+应收利息+罚息）
   * @param {Object} [connection] - 可选外部事务连接
   * @returns {Promise<object>} 更新后的合约
   */
  async executeGuaranteeCompensation(contractId, outstandingAmount, connection = null) {
    const round2 = (x) => Math.round(x * 100) / 100;
    const run = async (connection) => {
      const contract = await guaranteeContractDao.findById(contractId, connection);
      if (!contract) {
        throw new Error(`担保合约不存在: ${contractId}`);
      }

      const guarantorId = contract.guarantor_id;

      // 锁定担保人余额 FOR UPDATE（锁序：先 user 后 pool）
      const [userRows] = await connection.execute(
        'SELECT id, balance, frozen_balance FROM users WHERE id = ? FOR UPDATE',
        [guarantorId]
      );
      if (!userRows || userRows.length === 0) {
        throw new Error(`担保人不存在: ${guarantorId}`);
      }

      const balanceRow = { balance: userRows[0].balance, frozen_balance: userRows[0].frozen_balance };
      await decryptFields('users', balanceRow, guarantorId, connection);
      const currentBalance = Number(balanceRow.balance) || 0;
      const currentFrozen = Number(balanceRow.frozen_balance) || 0;

      // 优先从 frozen_balance 扣，不足部分从 balance 补。
      // 阶段2 修正：从冻结额只扣"本合约担保额度 G 与欠额的较小者"——
      // 利息等超出 G 的部分从可用余额补足，且不得侵蚀其它合约的冻结额度
      const guaranteeAmount = Number(contract.guarantee_amount) || 0;
      const fromFrozen = round2(Math.min(currentFrozen, outstandingAmount, guaranteeAmount));
      const remaining = round2(outstandingAmount - fromFrozen);
      const fromBalance = Math.min(currentBalance, remaining);

      const actualCompensation = round2(fromFrozen + fromBalance);
      // 退残余冻结：代偿完成即本合约担保义务终止，G 内未被代偿占用的冻结部分退回可用余额
      //（钳位在 min(G, currentFrozen) 内，不影响其它合约的冻结）
      const residualRelease = round2(Math.max(0, Math.min(guaranteeAmount, currentFrozen) - fromFrozen));
      const newFrozen = round2(currentFrozen - fromFrozen - residualRelease);
      const newBalance = round2(currentBalance - fromBalance + residualRelease);

      const encData = { balance: newBalance, frozen_balance: newFrozen };
      await encryptFields('users', encData, guarantorId, connection);
      await connection.execute('UPDATE users SET balance = ?, frozen_balance = ? WHERE id = ?', [
        encData.balance,
        encData.frozen_balance,
        guarantorId,
      ]);

      // 更新合约状态为 LIQUIDATED
      await guaranteeContractDao.updateStatus(contractId, 'LIQUIDATED', {}, connection);

      // 资金池：实收→PC、剩余本金核销 LA、利息部分记 TIE（保持恒等式 total=PC+UC / avail=total−LA）
      let principalOutstanding = 0;
      if (contract.loan_id) {
        const transactionDao = require('../../dao/transactionDao');
        const loanTx = await transactionDao.findById(contract.loan_id, connection);
        principalOutstanding = loanTx ? Math.max(0, Number(loanTx.amount) || 0) : 0;
      }
      const interestPart = round2(Math.max(0, Number(outstandingAmount) - principalOutstanding));

      const [poolRows] = await connection.execute('SELECT * FROM fund_pool WHERE id = 1 FOR UPDATE');
      if (!poolRows || poolRows.length === 0) {
        throw new Error('资金池不存在');
      }
      const pool = poolRows[0];
      // 资本口径：核销的剩余本金本已计入资本（债权），代偿现金替代债权入池 → PC 净变 = 代偿额 − 核销本金（罚息部分为平台收益，不足部分由平台承担）
      const newPC = round2(Number(pool.platform_capital || 0) + actualCompensation - principalOutstanding);
      const newLA = round2(Number(pool.loaned_amount || 0) - principalOutstanding);
      const newTIE = round2(Number(pool.total_interest_earned || 0) + interestPart);
      const newTotal = round2(newPC + Number(pool.user_capital || 0));
      const newAvail = round2(newTotal - newLA);

      await connection.execute(
        `UPDATE fund_pool SET platform_capital=?, loaned_amount=?, total_interest_earned=?,
         total_amount=?, available_amount=? WHERE id=1`,
        [newPC, newLA, newTIE, newTotal, newAvail]
      );

      logger.info('担保代偿已执行', {
        contractId,
        guarantorId,
        outstandingAmount,
        actualCompensation,
        fromFrozen,
        fromBalance,
        residualRelease,
        principalOutstanding,
        interestPart,
        remainingBalance: newBalance,
        remainingFrozen: newFrozen,
      });

      return await guaranteeContractDao.findById(contractId, connection);
    };
    // 嵌套（overdueService.liquidateOverdueLoans 传入 connection）由外层提交后失效；自有事务分支在此失效
    if (connection) return await run(connection);
    const compensated = await transaction(run);
    invalidatePoolReadCaches();
    return compensated;
  }
}

const guaranteeEngine = new GuaranteeEngine();

module.exports = guaranteeEngine;
