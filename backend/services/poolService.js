const poolDao = require('../dao/poolDao');
const userDao = require('../dao/userDao');
const transactionDao = require('../dao/transactionDao');
const { transaction } = require('../config/database');
const logger = require('../utils/logger');
const crypto = require('crypto');
const { generateSM3Hash } = require('../utils/cryptoUtils');
const { getInterestRate } = require('../routes/credit');
const { getCurrentLendingRate } = require('./interestRateService');
const { encrypt, encryptFields, decryptFields } = require('../utils/sm4Crypto');
const { poolCache, invalidatePoolReadCaches } = require('../utils/ttlCache');
const dynamicConfig = require('./dynamicConfigService');

// 系统池最低保留比例（占初始 platform_capital）
const SYSTEM_POOL_RESERVE_RATIO = 0.20;

// 动态流动性赎回策略阈值
const LIQUIDITY_HIGH = 0.60;   // 可用率 ≥ 60%：允许全额提前赎回
const LIQUIDITY_MEDIUM = 0.40; // 可用率 40%~60%：允许部分提前赎回（50%）
// 可用率 < 40%：仅到期可赎

/**
 * 根据资金池流动性计算用户的可赎回金额
 * @param {Array} investments - 用户的投资记录
 * @param {Object} pool - 资金池数据
 * @returns {Object} - { maxRedeemAmount, liquidityRatio, liquidityTier, totalActive, totalMaturedActive, totalEligible, poolAvailable }
 */
exports.calculateRedeemable = (investments, pool) => {
  const poolAvailable = Number(pool.available_amount || 0);
  const totalPool = Number(pool.total_amount || 0);
  const liquidityRatio = totalPool > 0 ? poolAvailable / totalPool : 0;

  // 确定流动性档位
  let liquidityTier, earlyRedeemRatio;
  if (liquidityRatio >= LIQUIDITY_HIGH) {
    liquidityTier = 'high';
    earlyRedeemRatio = 1.0; // 全额可赎
  } else if (liquidityRatio >= LIQUIDITY_MEDIUM) {
    liquidityTier = 'medium';
    earlyRedeemRatio = 0.5; // 50% 可赎
  } else {
    liquidityTier = 'low';
    earlyRedeemRatio = 0; // 仅到期可赎
  }

  const now = Date.now();
  let totalActive = 0;
  let totalMaturedActive = 0;

  investments.forEach(inv => {
    if (inv.status !== 'active') return;
    const amount = Number(inv.amount || 0);
    totalActive += amount;

    let isMatured = true;
    if (inv.term && inv.term > 0) {
      const investTime = new Date(inv.created_at).getTime();
      const maturityTime = investTime + inv.term * 24 * 60 * 60 * 1000;
      isMatured = now >= maturityTime;
    }
    if (isMatured) {
      totalMaturedActive += amount;
    }
  });

  // 未到期的投资金额
  const totalImmaturedActive = totalActive - totalMaturedActive;

  // 可赎回金额 = 到期部分 + 未到期部分 × 早期赎回比例
  const totalEligible = totalMaturedActive + Math.floor(totalImmaturedActive * earlyRedeemRatio);
  const maxRedeemAmount = Math.min(totalEligible, poolAvailable);

  return {
    maxRedeemAmount,
    liquidityRatio: Math.round(liquidityRatio * 10000) / 100, // 百分比
    liquidityTier,
    earlyRedeemRatio,
    totalActive,
    totalMaturedActive,
    totalImmaturedActive,
    totalEligible,
    poolAvailable
  };
};

// 计算利息 - 基于信用评分的差异化利率
const calculateInterest = async (principal, days, creditScore, isOverdue = false, overdueDays = 0, riskMode = 0) => {
  const baseAnnualRate = getInterestRate(creditScore) / 100;
  // 担保模式：利率85折优惠（有担保人分担风险，降低风险溢价）
  const guaranteeDiscount = riskMode === 2 ? 0.85 : 1.0;
  const dailyRate = (baseAnnualRate * guaranteeDiscount) / 365;

  let rate;
  if (isOverdue && overdueDays > 0) {
    const penaltyMultiplier = dynamicConfig.getOverduePenaltyRate(overdueDays);
    rate = dailyRate * penaltyMultiplier;
  } else if (isOverdue) {
    rate = dailyRate * 1.5;
  } else {
    rate = dailyRate;
  }

  return Math.round(principal * rate * days * 100) / 100;
};

// 阶段2 B：供违约清算按还款同口径计罚息复用
exports.calculateInterest = calculateInterest;

// 初始化资金池
exports.initializePool = async () => {
  try {
    const pool = await poolDao.getPool();
    if (pool && (pool.available_amount > 0 || pool.total_amount > 0)) {
      logger.info('资金池已存在，跳过初始化', {
        total_amount: pool.total_amount,
        available_amount: pool.available_amount
      });
      return true;
    }
    const initialPlatformCapital = Number(process.env.INITIAL_PLATFORM_CAPITAL) || 30000;
    await poolDao.updatePoolV2({
      platform_capital: initialPlatformCapital,
      user_capital: 0,
      loaned_amount: 0,
      total_interest_earned: 0,
      user_interest_earned: 0
    });
    logger.info('资金池初始化成功');
    return true;
  } catch (error) {
    logger.error('资金池初始化失败', { error: error.message });
    return false;
  }
};

// 获取资金池整体信息
exports.getPoolInfo = async () => {
  // 5s TTL 读缓存（utils/ttlCache.poolCache）：/pool 高频查询免重复读库；
  // 每个 fund_pool 写路径（本文件 invest/redeem/borrowFromPool/repay、poolDao、riskPlugins、autoRedeem、
  // overdueService 清算）在事务提交后调用 invalidatePoolReadCaches 主动失效，TTL 仅作跨实例兜底。
  // 取数抛错时不缓存、原样上抛（错误路径不进缓存）。
  return poolCache.getOrLoad('poolInfo', async () => {
    try {
      const pool = await poolDao.getPool();

      const safeTotalAmount = Math.max(0, pool.total_amount || 0);
      const safeAvailableAmount = Math.max(0, pool.available_amount || 0);
      const safePlatformCapital = Math.max(0, pool.platform_capital || 0);
      const safeUserCapital = Math.max(0, pool.user_capital || 0);
      const safeLoanedAmount = Math.max(0, pool.loaned_amount || 0);

      const poolStatus = safeAvailableAmount < 0 ? 'abnormal' : 'normal';

      return {
        // V2 分层池字段
        platformCapital: safePlatformCapital,
        userCapital: safeUserCapital,
        loanedAmount: safeLoanedAmount,
        // 派生字段
        totalPool: safeTotalAmount,
        availableAmount: safeAvailableAmount,
        // 利息字段
        platformInterest: Number(pool.total_interest_earned || 0),  // 平台利润
        userInterest: Number(pool.user_interest_earned || 0),        // 用户待分配利息
        totalInterest: Number(pool.total_interest_earned || 0) + Number(pool.user_interest_earned || 0),
        // 状态
        status: poolStatus,
        totalInvestors: 0,
        // 兼容旧字段
        originalPoolBalance: safePlatformCapital,
        userPoolBalance: safeUserCapital,
        totalBalance: safeTotalAmount,
        totalAvailable: safeAvailableAmount,
        userPoolStatus: poolStatus,
        emergencyBorrow: 0
      };
    } catch (error) {
      logger.error('获取资金池信息失败:', error);
      throw error;
    }
  });
};

// 定期检查资金池一致性（巡检版：默认仅告警，不写库）
// 用法：poolService.checkPoolConsistency() —— 每小时巡检（app.js 启动块注册，延迟 30s 首跑）；
//       poolService.checkPoolConsistency({ autoFix: true }) —— 显式要求时才执行修复段写库。
// 违例只做 logger.warning 汇总（四恒等式 + 分量/利息非负明细）；pool 记录缺失仅告警，
// 不自动 initializePool（巡检任务不擅自写库建池；注意 poolDao.getPool 自身在缺失时会建行，此分支仅作防御）。
exports.checkPoolConsistency = async ({ autoFix = false } = {}) => {
  try {
    logger.info('开始执行资金池一致性检查');
    const pool = await poolDao.getPool();
    if (!pool) {
      logger.warning('资金池数据不存在（仅告警，不自动建池；需要时手动调用 initializePool）');
      return { violations: ['pool_missing'] };
    }

    const pc = Number(pool.platform_capital || 0);
    const uc = Number(pool.user_capital || 0);
    const la = Number(pool.loaned_amount || 0);
    const ta = Number(pool.total_amount || 0);
    const aa = Number(pool.available_amount || 0);
    const ra = Number(pool.reserved_amount || 0);
    const tie = Number(pool.total_interest_earned || 0);
    const uie = Number(pool.user_interest_earned || 0);
    const violations = [];

    // 恒等式 1: total = platform_capital + user_capital
    const expectedTotal = pc + uc;
    if (Math.abs(ta - expectedTotal) > 0.01) {
      violations.push(`恒等式1违反: total(${ta}) ≠ PC(${pc}) + UC(${uc})`);
    }

    // 恒等式 2: available = total - loaned
    const expectedAvail = expectedTotal - la;
    if (Math.abs(aa - expectedAvail) > 0.01) {
      violations.push(`恒等式2违反: available(${aa}) ≠ total(${ta}) - loaned(${la})`);
    }

    // 恒等式 3: total = available + loaned (等价于恒等式2，冗余校验)
    if (Math.abs(ta - (aa + la)) > 0.01) {
      violations.push(`恒等式3违反: total(${ta}) ≠ available(${aa}) + loaned(${la})`);
    }

    // 恒等式 4: reserved = loaned（V2 分层口径：reserved_amount 即借出占用）
    if (Math.abs(ra - la) > 0.01) {
      violations.push(`恒等式4违反: reserved(${ra}) ≠ loaned(${la})`);
    }

    // 资金分量非负检查
    for (const [name, value] of [['PC', pc], ['UC', uc], ['LA', la], ['available', aa]]) {
      if (value < -0.005) {
        violations.push(`资金分量为负: ${name}=${value}`);
      }
    }

    // 利息非负检查
    if (tie < 0 || uie < 0) {
      violations.push(`利息异常为负: total_interest_earned=${tie}, user_interest_earned=${uie}`);
    }

    if (violations.length > 0) {
      logger.warning('资金池一致性告警', { violations, autoFix });
      if (autoFix) {
        await poolDao.updatePoolV2({
          platform_capital: pc,
          user_capital: uc,
          loaned_amount: la,
          total_interest_earned: Math.max(0, tie),
          user_interest_earned: Math.max(0, uie)
        });
        logger.info('资金池一致性修复完成（autoFix=true）');
      }
    } else {
      logger.info('资金池一致性检查通过');
    }

    return { violations };
  } catch (error) {
    logger.error('资金池一致性检查失败:', error);
    return { violations: ['check_error: ' + error.message] };
  }
};

// 记录当日资金池快照（幂等 upsert），供资金池页历史趋势图使用
exports.recordPoolSnapshot = async () => {
  const pool = await poolDao.getPool();
  if (!pool) return null;
  const { execute } = require('../config/database');
  await execute(
    `INSERT INTO fund_pool_snapshots (snap_date, total_amount, available_amount, platform_capital, user_capital, loaned_amount)
     VALUES (CURDATE(), ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE total_amount=VALUES(total_amount), available_amount=VALUES(available_amount),
       platform_capital=VALUES(platform_capital), user_capital=VALUES(user_capital), loaned_amount=VALUES(loaned_amount)`,
    [Number(pool.total_amount) || 0, Number(pool.available_amount) || 0, Number(pool.platform_capital) || 0,
     Number(pool.user_capital) || 0, Number(pool.loaned_amount) || 0]
  );
  return true;
};

// 读取近 N 天资金池快照（按日期升序），不足的日期不伪造
exports.getPoolHistory = async (days = 30) => {
  const { execute } = require('../config/database');
  const n = Math.max(1, Math.min(365, parseInt(days, 10) || 30));
  const rows = await execute(
    `SELECT DATE_FORMAT(snap_date, '%m-%d') AS date, total_amount, available_amount, platform_capital, user_capital, loaned_amount
     FROM fund_pool_snapshots WHERE snap_date >= DATE_SUB(CURDATE(), INTERVAL ? DAY) ORDER BY snap_date ASC`,
    [n]
  );
  return rows.map(r => ({
    date: r.date,
    totalPool: Number(r.total_amount),
    available: Number(r.available_amount),
    platformCapital: Number(r.platform_capital),
    userCapital: Number(r.user_capital),
    loaned: Number(r.loaned_amount)
  }));
};

// 执行出资操作
exports.invest = async (userId, amount) => {
  try {
    userId = userId.toString();

    if (!userId || !amount) throw new Error('缺少必要参数');
    if (amount < 100) throw new Error('出资金额必须大于等于100元');
    if (amount > 100000) throw new Error('单次出资金额不能超过10万元');

    const user = await userDao.findById(userId);
    if (!user) throw new Error('用户不存在');
    if (user.credit_score < 600) throw new Error('信用分低于600，无法出资');

    await transaction(async (connection) => {
      // 锁定用户余额
      const [userRows] = await connection.execute(
        'SELECT balance FROM users WHERE id = ? FOR UPDATE', [userId]
      );
      const balanceRow = { balance: userRows[0].balance };
      await decryptFields('users', balanceRow, userId, connection);
      const currentBalance = Number(balanceRow.balance) || 0;
      if (currentBalance < amount) throw new Error('余额不足');

      // 锁定资金池
      const [poolRows] = await connection.execute(
        'SELECT * FROM fund_pool WHERE id = 1 FOR UPDATE'
      );
      const pool = poolRows[0];

      // 更新资金池：user_capital += amount
      const newUC = Number(pool.user_capital || 0) + amount;
      const newPC = Number(pool.platform_capital || 0);
      const newLA = Number(pool.loaned_amount || 0);
      const newTotal = newPC + newUC;
      const newAvail = newTotal - newLA;

      await connection.execute(
        `UPDATE fund_pool SET user_capital=?, total_amount=?, available_amount=? WHERE id=1`,
        [newUC, newTotal, newAvail]
      );

      // 扣减用户余额
      const newBalance = currentBalance - amount;
      const balanceData = { balance: newBalance };
      await encryptFields('users', balanceData, userId, connection);
      await connection.execute('UPDATE users SET balance = ? WHERE id = ?', [balanceData.balance, userId]);
    });
    invalidatePoolReadCaches(); // 事务已提交：失效池读缓存

    logger.info(`用户 ${userId} 出资 ${amount} 元成功`);
    return true;
  } catch (error) {
    logger.error('出资操作失败:', { error: error.message, userId, amount });
    throw error;
  }
};

// 执行赎回操作（原子事务）
exports.redeem = async (userId, amount) => {
  try {
    userId = userId.toString();

    if (!userId || !amount) throw new Error('缺少必要参数');
    if (amount < 100) throw new Error('赎回金额必须大于等于100元');
    if (amount > 50000) throw new Error('单次赎回金额不能超过5万元');

    const user = await userDao.findById(userId);
    if (!user) throw new Error('用户不存在');

    const annualRate = await getCurrentLendingRate();
    const dailyRate = annualRate / 365;

    const result = await transaction(async (connection) => {
      // 0. 先锁定用户行（阶段2 锁序统一：user → pool，与 repay/releaseMargin 一致，防死锁）
      const [userRowsEarly] = await connection.execute(
        'SELECT balance FROM users WHERE id = ? FOR UPDATE', [userId]
      );
      const balanceRowEarly = { balance: userRowsEarly[0].balance };
      await decryptFields('users', balanceRowEarly, userId, connection);
      const currentBalance = Number(balanceRowEarly.balance) || 0;

      // 1. 锁定资金池
      const [poolRows] = await connection.execute(
        'SELECT * FROM fund_pool WHERE id = 1 FOR UPDATE'
      );
      const pool = poolRows[0];

      if (amount > Number(pool.available_amount)) {
        throw new Error(`可赎回金额不足，当前可赎回 ${pool.available_amount} 元`);
      }

      // 2. 根据流动性策略筛选可赎回的活跃投资（在事务内）
      const totalPool = Number(pool.total_amount || 0);
      const poolAvail = Number(pool.available_amount || 0);
      const liqRatio = totalPool > 0 ? poolAvail / totalPool : 0;
      let earlyRedeemRatio = 0;
      if (liqRatio >= LIQUIDITY_HIGH) earlyRedeemRatio = 1.0;
      else if (liqRatio >= LIQUIDITY_MEDIUM) earlyRedeemRatio = 0.5;

      const allInvestments = await transactionDao.findByUserId(userId, { type: 'invest' }, connection);
      const now = Date.now();
      const activeInvestments = allInvestments
        .filter(inv => {
          if (inv.status !== 'active') return false;
          if (inv.term && inv.term > 0) {
            const investTime = new Date(inv.created_at).getTime();
            const maturityTime = investTime + inv.term * 24 * 60 * 60 * 1000;
            if (now >= maturityTime) return true; // 已到期，始终可赎
            return earlyRedeemRatio > 0; // 未到期，仅在流动性允许时可赎
          }
          return true;
        })
        .sort((a, b) => new Date(a.created_at) - new Date(b.created_at));

      // 3. 按比例关闭投资记录，计算收益
      let remaining = amount;
      let totalInterestEarned = 0;
      for (const inv of activeInvestments) {
        if (remaining <= 0) break;
        const invAmount = Number(inv.amount || 0);
        if (remaining >= invAmount) {
          const investDays = Math.max(1, Math.ceil((now - new Date(inv.created_at).getTime()) / 86400000));
          const dynamicInterest = Math.round(invAmount * dailyRate * investDays * 100) / 100;
          await transactionDao.update(inv.id, {
            interest: dynamicInterest,
            total_amount: Math.round((invAmount + dynamicInterest) * 100) / 100,
            status: 'completed'
          }, connection);
          remaining -= invAmount;
          totalInterestEarned += dynamicInterest;
        } else {
          const lastInterestDate = inv.updated_at || inv.created_at;
          const partialDays = Math.max(1, Math.ceil((now - new Date(lastInterestDate).getTime()) / 86400000));
          const partialInterest = Math.round(remaining * dailyRate * partialDays * 100) / 100;
          await transactionDao.update(inv.id, {
            amount: invAmount - remaining,
            interest: partialInterest,
            total_amount: Math.round((invAmount - remaining + partialInterest) * 100) / 100
          }, connection);
          remaining = 0;
          totalInterestEarned += partialInterest;
        }
      }

      // 4. 校验投资记录是否覆盖赎回金额
      if (remaining > 0) {
        throw new Error(`到期投资总额不足，剩余 ${remaining} 元无法赎回`);
      }

      // 5. 校验用户利息是否足够
      const currentUserInterest = Number(pool.user_interest_earned || 0);
      const actualInterest = Math.min(totalInterestEarned, currentUserInterest);
      const interestShortfall = totalInterestEarned - actualInterest;

      if (interestShortfall > 0) {
        const currentPlatformInterest = Number(pool.total_interest_earned || 0);
        await connection.execute(
          'UPDATE fund_pool SET total_interest_earned = ? WHERE id=1',
          [currentPlatformInterest + interestShortfall]
        );
        logger.warning('用户利息不足，差额归入平台利润', {
          requested: totalInterestEarned,
          availableUserInterest: currentUserInterest,
          shortfall: interestShortfall
        });
      }

      // 5. 更新资金池（【E/K】赎回本息均出自用户池：UC 减 本金+实付利息，确保付息有资产来源）
      const payoutAmount = Math.round((amount + actualInterest) * 100) / 100;
      const currentUC = Number(pool.user_capital || 0);
      if (currentUC < payoutAmount) {
        throw new Error(`用户池资金不足，当前 UC=${currentUC}，赎回本息=${payoutAmount}`);
      }
      const newUC = currentUC - payoutAmount;
      const newPC = Number(pool.platform_capital || 0);
      const newLA = Number(pool.loaned_amount || 0);
      const newTotal = newPC + newUC;
      const newAvail = newTotal - newLA;
      const newUserInterest = currentUserInterest - actualInterest;

      await connection.execute(
        `UPDATE fund_pool SET user_capital=?, total_amount=?, available_amount=?, user_interest_earned=? WHERE id=1`,
        [newUC, newTotal, newAvail, newUserInterest]
      );

      // 6. 更新用户余额（本金 + 实际可付利息；用户行已在事务开头锁定）
      const newBalance = currentBalance + payoutAmount;
      const balanceData = { balance: newBalance };
      await encryptFields('users', balanceData, userId, connection);
      await connection.execute('UPDATE users SET balance = ? WHERE id = ?', [balanceData.balance, userId]);

      return { actualInterest, newBalance };
    });
    invalidatePoolReadCaches(); // 事务已提交：失效池读缓存

    const totalRedeemed = amount + Math.round(result.actualInterest * 100) / 100;
    logger.info(`用户 ${userId} 赎回 ${totalRedeemed} 元成功（本金 ${amount}，收益 ${result.actualInterest}）`);

    return {
      success: true,
      totalRedeemed,
      totalInterestEarned: result.actualInterest,
      newBalance: result.newBalance
    };
  } catch (error) {
    logger.error('赎回操作失败:', { error: error.message, userId, amount });
    throw error;
  }
};

// 从资金池借款（分层池模型：先用户池，后系统池）
// guaranteeFee：担保费（阶段2 C），计入借款 transactions.total_amount（P+I+F），还款时随本息代收
exports.borrowFromPool = async (userId, amount, duration = 30, loanLimit = Infinity, riskMode = 0, guaranteeFee = 0) => {
  try {
    userId = userId.toString();

    if (!userId || !amount) throw new Error('缺少必要参数');
    if (amount < 100) throw new Error('借款金额必须大于等于100元');
    if (amount > 50000) throw new Error('单次借款金额不能超过5万元');

    const user = await userDao.findById(userId);
    if (!user) throw new Error('用户不存在');
    if (user.credit_score < 600) throw new Error('信用分低于600，无法借款');

    const interest = await calculateInterest(amount, duration, user.credit_score, false, 0, riskMode);
    const feeAmount = Math.round(Number(guaranteeFee || 0) * 100) / 100;
    const dueDate = new Date(Date.now() + duration * 24 * 60 * 60 * 1000);

    const result = await transaction(async (connection) => {
      // 事务内检查借款限额（已借未还含 pending 与 overdue：逾期未还同样占用额度）
      if (loanLimit !== Infinity) {
        const [activeLoanRows] = await connection.execute(
          "SELECT COALESCE(SUM(amount), 0) AS total FROM transactions WHERE user_id = ? AND type = 'loan' AND status IN ('pending', 'overdue') FOR UPDATE",
          [parseInt(userId)]
        );
        const totalActive = Number(activeLoanRows[0].total) || 0;
        if (totalActive + amount > loanLimit) {
          throw new Error(`借款超限：已借${totalActive}，本次${amount}，限额${loanLimit}`);
        }
      }

      // 锁定资金池
      const [poolRows] = await connection.execute(
        'SELECT * FROM fund_pool WHERE id = 1 FOR UPDATE'
      );
      const pool = poolRows[0];

      const poolUC = Number(pool.user_capital || 0);
      const poolPC = Number(pool.platform_capital || 0);
      const poolLA = Number(pool.loaned_amount || 0);
      const poolTotal = poolPC + poolUC;
      const poolAvail = poolTotal - poolLA;

      if (amount > poolAvail) {
        throw new Error('资金池余额不足');
      }

      // 分层借款：先用户池，后系统池
      const systemReserve = poolPC * SYSTEM_POOL_RESERVE_RATIO; // 系统池最低保留
      const systemAvailable = Math.max(0, poolPC - systemReserve);

      let fromUserPool = Math.min(amount, poolUC);
      let fromSystemPool = amount - fromUserPool;

      if (fromSystemPool > systemAvailable) {
        // 系统池不够，部分放贷
        const maxBorrow = poolUC + systemAvailable;
        if (maxBorrow < 100) {
          throw new Error('可用资金不足，无法放贷');
        }
        // 调整为部分放贷
        const actualAmount = Math.min(amount, maxBorrow);
        fromUserPool = Math.min(actualAmount, poolUC);
        fromSystemPool = actualAmount - fromUserPool;
        logger.warning('资金不足，部分放贷', { requested: amount, actual: actualAmount });
      }

      const borrowUserRatio = amount > 0 ? fromUserPool / amount : 0;
      const borrowPlatformRatio = amount > 0 ? fromSystemPool / amount : 0;

      // 更新资金池（会计恒等式：total = PC + UC，available = total - LA）
      // 借款只是资产形态变化（现金→债权）：PC/UC 资本不变，仅 LA 增加、available 减少
      // （借款比例 borrowUserRatio/PlatformRatio 已记入交易，用于还息/违约时按比例分账）
      const newUC = poolUC;
      const newPC = poolPC;
      const newLA = poolLA + amount;
      const newTotal = newPC + newUC;
      const newAvail = newTotal - newLA;

      await connection.execute(
        `UPDATE fund_pool SET platform_capital=?, user_capital=?, loaned_amount=?,
         total_amount=?, available_amount=?, reserved_amount=? WHERE id=1`,
        [newPC, newUC, newLA, newTotal, newAvail, newLA]
      );

      // 更新用户余额
      const [userRows] = await connection.execute(
        'SELECT balance FROM users WHERE id = ? FOR UPDATE', [userId]
      );
      const balanceRow = { balance: userRows[0].balance };
      await decryptFields('users', balanceRow, userId, connection);
      const currentBalance = Number(balanceRow.balance) || 0;
      const actualBorrowAmount = fromUserPool + fromSystemPool;
      const newBalance = currentBalance + actualBorrowAmount;
      const balanceData = { balance: newBalance };
      await encryptFields('users', balanceData, userId, connection);
      await connection.execute('UPDATE users SET balance = ? WHERE id = ?', [balanceData.balance, userId]);

      // 创建借款记录（记录借款比例，用于还款时按比例归还；total_amount 含担保费 P+I+F）
      const newTransaction = await transactionDao.create({
        user_id: parseInt(userId),
        type: 'loan',
        amount: actualBorrowAmount,
        interest: interest,
        total_amount: Math.round((actualBorrowAmount + interest + feeAmount) * 100) / 100,
        status: 'pending',
        due_date: dueDate,
        term: duration
      }, connection);

      // 记录借款比例到 transactions 表
      await connection.execute(
        'UPDATE transactions SET borrow_user_ratio = ?, borrow_platform_ratio = ? WHERE id = ?',
        [borrowUserRatio.toFixed(4), borrowPlatformRatio.toFixed(4), newTransaction.id]
      );

      return { transaction: newTransaction, actualBorrowAmount, fromUserPool, fromSystemPool };
    });
    invalidatePoolReadCaches(); // 事务已提交：失效池读缓存

    logger.info('借款操作成功', {
      userId,
      requested: amount,
      actual: result.actualBorrowAmount,
      fromUserPool: result.fromUserPool,
      fromSystemPool: result.fromSystemPool,
      interest,
      duration,
      riskMode,
      guaranteeDiscount: riskMode === 2 ? '85%' : '无'
    });

    return {
      success: true,
      message: result.actualBorrowAmount < amount ? `部分放贷成功，实际放贷 ${result.actualBorrowAmount} 元` : '借款成功',
      transaction: result.transaction,
      actualAmount: result.actualBorrowAmount
    };
  } catch (error) {
    logger.error('借款操作失败:', { error: error.message, userId, amount });
    throw error;
  }
};

// 执行借款操作（旧版兼容）
exports.borrow = async (userId, amount, interestRate, duration) => {
  return await exports.borrowFromPool(userId, amount, duration);
};

// 执行还款操作（分层池模型：本金按比例归还两池，利息按出资比例分配）
// 阶段2 修复：
//   F  事务内先对贷款行做守卫认领（WHERE status IN('pending','overdue')），affectedRows=0 即回滚，
//      防止并发双重扣款/双重核销；
//   A  认领范围放行 overdue，逾期贷款可还款（罚息由调用方按逾期天数计入 interest）；
//   E  利息中属于用户池的份额计入 UC（赎回付息的资产来源）；
//   C  可选担保费 fee：随借款人本息一并代扣并入平台池（PC+=F），同事务回写合约 fee_collected=1。
exports.repay = async (userId, amount, interest, { transactionId = null, newStatus = null, loanUpdateFields = null, fee = 0, contractId = null } = {}) => {
  try {
    userId = userId.toString();

    if (!userId || !amount || interest == null) throw new Error('缺少必要参数');
    if (amount < 0 || interest < 0) throw new Error('金额不能为负数');

    const user = await userDao.findById(userId);
    if (!user) throw new Error('用户不存在');

    const feeAmount = Math.round(Number(fee || 0) * 100) / 100;
    const totalRepayment = amount + interest + feeAmount;

    await transaction(async (connection) => {
      // 锁定用户余额（统一锁序：先 user 后 pool）
      const [userRows] = await connection.execute(
        'SELECT balance FROM users WHERE id = ? FOR UPDATE', [userId]
      );
      const balanceRow = { balance: userRows[0].balance };
      await decryptFields('users', balanceRow, userId, connection);
      const currentBalance = Number(balanceRow.balance) || 0;
      if (currentBalance < totalRepayment) throw new Error('余额不足');

      // 【F】守卫认领：对贷款行置 'repaying' 中间态并取得行锁（持有至事务提交），
      // 并发第二笔会因 affectedRows=0 抛错整体回滚，确保恰一成功
      if (transactionId) {
        const [claim] = await connection.execute(
          "UPDATE transactions SET status = 'repaying' WHERE id = ? AND status IN ('pending', 'overdue')",
          [transactionId]
        );
        if (claim.affectedRows === 0) {
          throw new Error('该笔贷款不存在、状态已变更或正在还款中，请勿重复还款');
        }
      }

      // 锁定资金池
      const [poolRows] = await connection.execute(
        'SELECT * FROM fund_pool WHERE id = 1 FOR UPDATE'
      );
      const pool = poolRows[0];

      // 获取借款时的资本比例
      let borrowUserRatio = 0.8; // 默认 80%
      let borrowPlatformRatio = 0.2; // 默认 20%
      if (transactionId) {
        const [txRows] = await connection.execute(
          'SELECT borrow_user_ratio, borrow_platform_ratio FROM transactions WHERE id = ?', [transactionId]
        );
        if (txRows.length > 0) {
          if (txRows[0].borrow_user_ratio != null) borrowUserRatio = Number(txRows[0].borrow_user_ratio);
          if (txRows[0].borrow_platform_ratio != null) borrowPlatformRatio = Number(txRows[0].borrow_platform_ratio);
        }
      }

      // 本金按借款时比例归还两池
      const principalToUser = Math.round(amount * borrowUserRatio * 100) / 100;
      const principalToSystem = Math.round((amount - principalToUser) * 100) / 100;

      // 利息按借款时资本比例分配（而非还款时比例，避免时序偏差）
      const interestToUser = Math.round(interest * borrowUserRatio * 100) / 100;
      const interestToSystem = Math.round((interest - interestToUser) * 100) / 100;

      // 更新资金池（资本口径：PC/UC 为两池资本，含已借出部分；LA 为在贷债权；available = total − LA = 可放贷现金）
      // 还本：债权转回现金，资本总量不变 → 只核减 LA；本金不再重复加回 PC/UC（否则与借款时未扣减的资本双计）
      // 【C】担保费全额入平台池（后续由结算按 0.7/0.1/0.2 纯分配）
      // 【E】利息的用户池份额计入 UC，作为日后赎回付息的资产来源
      const newPC = Number(pool.platform_capital || 0) + interestToSystem + feeAmount;
      const newUC = Number(pool.user_capital || 0) + interestToUser;
      const newLA = Number(pool.loaned_amount || 0) - amount;
      const newTotal = newPC + newUC;
      const newAvail = newTotal - newLA;
      const newPlatformInterest = Number(pool.total_interest_earned || 0) + interestToSystem;
      const newUserInterest = Number(pool.user_interest_earned || 0) + interestToUser;

      await connection.execute(
        `UPDATE fund_pool SET platform_capital=?, user_capital=?, loaned_amount=?,
         total_amount=?, available_amount=?, reserved_amount=?,
         total_interest_earned=?, user_interest_earned=? WHERE id=1`,
        [newPC, newUC, newLA, newTotal, newAvail, newLA, newPlatformInterest, newUserInterest]
      );

      // 【C】担保费代收标记与入池同事务：仅当合约尚未收费时回写，异常即整体回滚
      if (feeAmount > 0 && contractId) {
        const [feeRes] = await connection.execute(
          'UPDATE risk_guarantee_contracts SET fee_collected = 1 WHERE id = ? AND fee_collected = 0',
          [contractId]
        );
        if (feeRes.affectedRows === 0) {
          throw new Error('担保费代收失败：合约不存在或担保费已收，拒绝重复代收');
        }
      }

      // 扣减用户余额（本金+利息+担保费）
      const newBalance = currentBalance - totalRepayment;
      const balanceData = { balance: newBalance };
      await encryptFields('users', balanceData, userId, connection);
      await connection.execute('UPDATE users SET balance = ? WHERE id = ?', [balanceData.balance, userId]);

      // 更新贷款记录（认领时 status 已置 'repaying'，此处回写终态）
      if (transactionId && (newStatus || loanUpdateFields)) {
        if (loanUpdateFields) {
          const fields = [];
          const params = [];
          const ENCRYPTED_FIELDS = ['amount', 'interest', 'total_amount'];
          const ALLOWED_FIELDS = [...ENCRYPTED_FIELDS, 'status'];
          for (const [field, value] of Object.entries(loanUpdateFields)) {
            if (!ALLOWED_FIELDS.includes(field)) throw new Error(`不允许更新的字段: ${field}`);
            if (ENCRYPTED_FIELDS.includes(field)) {
              const aad = `transactions:${field}:${userId}`;
              const encrypted = await encrypt(String(Number(value)), userId, aad);
              fields.push(`${field} = ?`);
              params.push(encrypted);
            } else {
              fields.push(`${field} = ?`);
              params.push(value);
            }
          }
          params.push(transactionId);
          await connection.execute(`UPDATE transactions SET ${fields.join(', ')} WHERE id = ?`, params);
        } else if (newStatus) {
          await connection.execute('UPDATE transactions SET status = ? WHERE id = ?', [newStatus, transactionId]);
        }
      }
    });
    invalidatePoolReadCaches(); // 事务已提交：失效池读缓存

    logger.info('还款操作成功', { userId, totalRepayment, principal: amount, interest, fee: feeAmount });
    return true;
  } catch (error) {
    logger.error('还款操作失败:', { error: error.message, userId, amount, interest });
    throw error;
  }
};
