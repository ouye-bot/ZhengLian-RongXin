const { execute, transaction } = require('../config/database');
const { invalidatePoolReadCaches } = require('../utils/ttlCache');
const logger = require('../utils/logger');
const transactionDao = require('../dao/transactionDao');

const checkOverdueLoans = async () => {
  const result = { total: 0, marked: 0, errors: 0 };

  try {
    const overdueLoans = await execute(
      `SELECT t.id, t.user_id, t.due_date
       FROM transactions t
       WHERE t.type = 'loan'
         AND t.status = 'pending'
         AND t.due_date IS NOT NULL
         AND t.due_date < NOW()
       LIMIT 100`
    );

    result.total = overdueLoans.length;

    if (overdueLoans.length === 0) {
      return result;
    }

    // 在单个事务内批量标记逾期，保证原子性
    await transaction(async (connection) => {
      for (const loan of overdueLoans) {
        try {
          const dueDate = new Date(loan.due_date);
          const now = new Date();
          const daysOverdue = Math.floor((now - dueDate) / (24 * 60 * 60 * 1000));

          await connection.execute(
            'UPDATE transactions SET status = ? WHERE id = ?',
            ['overdue', loan.id]
          );

          result.marked++;
          logger.info('借款已标记为逾期', {
            transactionId: loan.id,
            userId: loan.user_id,
            dueDate: loan.due_date,
            daysOverdue
          });
        } catch (error) {
          result.errors++;
          logger.error('标记借款逾期失败', {
            transactionId: loan.id,
            error: error.message
          });
        }
      }
    });

    if (overdueLoans.length === 100) {
      logger.info('逾期借款处理达到100条上限，下一轮定时任务将继续处理');
    }

    return result;
  } catch (error) {
    logger.error('查询逾期借款失败', { error: error.message });
    throw error;
  }
};

const getOverdueStats = async () => {
  try {
    const overdueResult = await execute(
      "SELECT COUNT(*) as count FROM transactions WHERE type = 'loan' AND status = 'overdue'"
    );
    const overdueCount = overdueResult[0]?.count || 0;

    const pendingOverdueResult = await execute(
      `SELECT COUNT(*) as count FROM transactions
       WHERE type = 'loan'
         AND status = 'pending'
         AND due_date IS NOT NULL
         AND due_date < NOW()`
    );
    const pendingOverdueCount = pendingOverdueResult[0]?.count || 0;

    // amount 字段已加密，无法直接 SUM，使用解密后的 DAO 查询
    const overdueTransactions = await transactionDao.findByStatus('overdue');
    const totalOverdueAmount = overdueTransactions
      .filter(t => t.type === 'loan')
      .reduce((sum, t) => sum + Number(t.amount || 0), 0);

    return {
      overdueCount,
      pendingOverdueCount,
      totalOverdueAmount
    };
  } catch (error) {
    logger.error('获取逾期统计失败', { error: error.message });
    return {
      overdueCount: 0,
      pendingOverdueCount: 0,
      totalOverdueAmount: 0
    };
  }
};

const getOverdueDays = (transaction) => {
  try {
    const dueDate = new Date(transaction.due_date || transaction.dueDate);
    const now = new Date();
    if (dueDate >= now) return 0;
    return Math.max(0, Math.floor((now - dueDate) / 86400000));
  } catch (error) {
    logger.error('计算逾期天数失败', { error: error.message, transactionId: transaction?.id });
    return 0;
  }
};

// 违约清算阈值：逾期超过 15 天进入清算（与产品口径一致）
const LIQUIDATION_OVERDUE_DAYS = 15;

/**
 * 违约清算（阶段2 B）：对逾期超 15 天的贷款逐笔核销，替代还款钩子里的 >15 天分支
 * 每笔一个独立事务，单笔失败不阻断其它笔：
 *   1. 守卫认领：UPDATE status='liquidating' WHERE id=? AND status='overdue'（行锁持有至提交，防并发重复清算）
 *   2. 押金订单 FROZEN → liquidateMargin 改造版：没收保证金入平台池（PC+=margin）、LA−=剩余本金
 *   3. 担保合约 ACTIVE → executeGuaranteeCompensation 改造版：
 *      实收→PC、LA−=剩余本金、退残余冻结、利息部分记 TIE；担保人信用分 −10
 *   4. 贷款守卫置 liquidated
 * 剩余欠额口径与还款一致：本金 + 约定利息 + 按逾期天数的罚息
 * @returns {Promise<{total:number, liquidated:number, skipped:number, errors:number}>}
 */
const liquidateOverdueLoans = async () => {
  const result = { total: 0, liquidated: 0, skipped: 0, errors: 0 };

  try {
    const overdueLoans = await execute(
      `SELECT id FROM transactions
       WHERE type = 'loan'
         AND status = 'overdue'
         AND due_date IS NOT NULL
         AND due_date < NOW() - INTERVAL ? DAY
       LIMIT 100`,
      [LIQUIDATION_OVERDUE_DAYS]
    );

    result.total = overdueLoans.length;
    if (overdueLoans.length === 0) {
      return result;
    }

    const marginEngine = require('./riskPlugins/marginEngine');
    const guaranteeEngine = require('./riskPlugins/guaranteeEngine');
    const marginOrderDao = require('../dao/marginOrderDao');
    const guaranteeContractDao = require('../dao/guaranteeContractDao');
    const userDao = require('../dao/userDao');
    const { transaction } = require('../config/database');
    const { encryptFields, decryptFields } = require('../utils/sm4Crypto');
    const poolService = require('./poolService');

    for (const row of overdueLoans) {
      const loanId = row.id;
      try {
        // 借款与欠额信息（DAO 读取已解密字段）
        const loanTx = await transactionDao.findById(loanId);
        if (!loanTx) {
          result.errors++;
          logger.error('违约清算失败：借款记录不存在', { loanId });
          continue;
        }
        const principal = Math.max(0, Number(loanTx.amount) || 0);
        const agreedInterest = Number(loanTx.interest || 0);
        const daysLate = Math.max(1, Math.floor((Date.now() - new Date(loanTx.due_date).getTime()) / 86400000));
        const borrower = await userDao.findById(String(loanTx.user_id));
        const creditScore = borrower ? (borrower.credit_score || 600) : 600;
        // 罚息与还款路由同口径：本金 × 日利率 × 逾期天数 × 动态倍数
        const penalty = await poolService.calculateInterest(principal, daysLate, creditScore, true, daysLate);
        const outstanding = Math.round((principal + agreedInterest + penalty) * 100) / 100;

        await transaction(async (connection) => {
          // 1. 守卫认领（行锁持有至事务提交）
          const [claim] = await connection.execute(
            "UPDATE transactions SET status = 'liquidating' WHERE id = ? AND status = 'overdue'",
            [loanId]
          );
          if (claim.affectedRows === 0) {
            result.skipped++;
            logger.warning('违约清算跳过：贷款状态已变更', { loanId });
            return;
          }

          // 2. 押金订单没收（同事务，入池+核销本金）
          const marginOrder = await marginOrderDao.findByLoanId(loanId, connection);
          if (marginOrder && marginOrder.status === 'FROZEN') {
            await marginEngine.liquidateMargin(loanId, connection);
            logger.info('违约清算：保证金已没收', { loanId, margin: Number(marginOrder.margin_amount) });
          }

          // 3. 担保代偿（同事务，实收入池+核销本金+退残余冻结+TIE 记利息）+ 担保人 −10 分
          const contract = await guaranteeContractDao.findByLoanId(loanId, connection);
          if (contract && contract.status === 'ACTIVE') {
            await guaranteeEngine.executeGuaranteeCompensation(contract.id, outstanding, connection);

            const guarantorId = contract.guarantor_id;
            const [gRows] = await connection.execute(
              'SELECT credit_score FROM users WHERE id = ? FOR UPDATE', [guarantorId]
            );
            if (gRows && gRows.length > 0) {
              // credit_score 为加密字段，须解密扣分后回写
              const scoreRow = { credit_score: gRows[0].credit_score };
              await decryptFields('users', scoreRow, guarantorId, connection);
              const newScore = Math.max(0, Number(scoreRow.credit_score || 0) - 10);
              const scoreData = { credit_score: newScore };
              await encryptFields('users', scoreData, guarantorId, connection);
              await connection.execute('UPDATE users SET credit_score = ? WHERE id = ?', [scoreData.credit_score, guarantorId]);
              logger.info('违约清算：担保人信用分扣减', { loanId, guarantorId, delta: -10 });
            }
          }

          // 4. 终态：置 liquidated
          await connection.execute(
            "UPDATE transactions SET status = 'liquidated' WHERE id = ? AND status = 'liquidating'",
            [loanId]
          );
        });
        // 外层事务已提交：liquidateMargin / executeGuaranteeCompensation 以本事务 connection 嵌套写入 fund_pool，
        // 其自身不失效（见各插件注释），统一由此处在提交后失效池读缓存
        invalidatePoolReadCaches();

        result.liquidated++;
        logger.info('违约清算完成', { loanId, outstanding });
      } catch (error) {
        result.errors++;
        logger.error('违约清算失败', { loanId, error: error.message });
      }
    }

    logger.info('违约清算任务结束', result);
    return result;
  } catch (error) {
    logger.error('违约清算任务失败', { error: error.message });
    throw error;
  }
};

/**
 * 孤儿押金订单清理（阶段2 J，两阶段提交窗口收敛）：
 * beforeBorrow 先冻结押金（此时 loan_id 为 NULL），借款成功后才回填 loan_id；
 * 该窗口内进程崩溃/借款失败会留下无主 FROZEN 订单。本任务将
 * FROZEN + loan_id IS NULL + 创建超 10 分钟 的订单解冻为 RELEASED（不计息），
 * 冻结额退回用户可用余额，资金池不变（冻结是用户侧负债，不动池）。
 * e2e 直调入口：overdueService.cleanupOrphanMarginOrders()
 * @returns {Promise<{total:number, cleaned:number, skipped:number, errors:number}>}
 */
const cleanupOrphanMarginOrders = async () => {
  const result = { total: 0, cleaned: 0, skipped: 0, errors: 0 };
  try {
    const orphans = await execute(
      `SELECT id FROM risk_margin_orders
       WHERE status = 'FROZEN'
         AND loan_id IS NULL
         AND created_at < NOW() - INTERVAL 10 MINUTE
       LIMIT 100`
    );
    result.total = orphans.length;
    if (orphans.length === 0) {
      return result;
    }

    const marginOrderDao = require('../dao/marginOrderDao');
    const { transaction } = require('../config/database');
    const { encryptFields, decryptFields } = require('../utils/sm4Crypto');
    const round2 = (x) => Math.round(x * 100) / 100;

    for (const row of orphans) {
      try {
        await transaction(async (connection) => {
          // 事务内重读并守卫状态（行锁持有至提交，防与回填 loan_id 并发）
          const [orders] = await connection.execute(
            'SELECT id, user_id, margin_amount, status, loan_id FROM risk_margin_orders WHERE id = ? FOR UPDATE',
            [row.id]
          );
          const order = orders[0];
          if (!order || order.status !== 'FROZEN' || order.loan_id !== null) {
            result.skipped++;
            return;
          }

          const userId = String(order.user_id);
          const margin = Math.max(0, Number(order.margin_amount) || 0);
          const [userRows] = await connection.execute(
            'SELECT balance, frozen_balance FROM users WHERE id = ? FOR UPDATE',
            [userId]
          );
          if (!userRows || userRows.length === 0) {
            throw new Error(`孤儿清理：用户不存在 ${userId}`);
          }
          const balRow = { balance: userRows[0].balance, frozen_balance: userRows[0].frozen_balance };
          await decryptFields('users', balRow, userId, connection);
          const balanceData = {
            balance: round2(Number(balRow.balance || 0) + margin),
            frozen_balance: round2(Number(balRow.frozen_balance || 0) - margin)
          };
          await encryptFields('users', balanceData, userId, connection);
          await connection.execute(
            'UPDATE users SET balance = ?, frozen_balance = ? WHERE id = ?',
            [balanceData.balance, balanceData.frozen_balance, userId]
          );

          // RELEASED 不计息（frozen_interest 保持 0）
          await marginOrderDao.updateStatus(order.id, 'RELEASED', { frozen_interest: 0 }, connection);
        });
        result.cleaned++;
        logger.info('孤儿押金订单已清理解冻', { orderId: row.id });
      } catch (error) {
        result.errors++;
        logger.error('孤儿押金订单清理失败', { orderId: row.id, error: error.message });
      }
    }

    if (result.total > 0) {
      logger.info('孤儿押金订单清理任务结束', result);
    }
    return result;
  } catch (error) {
    logger.error('孤儿押金订单清理任务失败', { error: error.message });
    throw error;
  }
};

/**
 * 结算对账（阶段2 J，幂等）：贷款已 completed 但风控侧未收尾的补偿——
 * 押金订单仍 FROZEN → releaseMargin（释放+PC 付息，PC 不足时报错下轮重试）；
 * 担保合约仍 ACTIVE → settleGuaranteeRevenue（须 fee_collected=1，否则记 warning 跳过）+ releaseGuarantorQuota。
 * @returns {Promise<{total:number, marginReleased:number, contractsSettled:number, skipped:number, errors:number}>}
 */
const reconcileSettlements = async () => {
  const result = { total: 0, marginReleased: 0, contractsSettled: 0, skipped: 0, errors: 0 };
  try {
    const rows = await execute(
      `SELECT t.id FROM transactions t
       WHERE t.type = 'loan' AND t.status = 'completed'
         AND (
           EXISTS (SELECT 1 FROM risk_margin_orders m WHERE m.loan_id = t.id AND m.status = 'FROZEN')
           OR EXISTS (SELECT 1 FROM risk_guarantee_contracts g WHERE g.loan_id = t.id AND g.status = 'ACTIVE')
         )
       LIMIT 100`
    );
    result.total = rows.length;
    if (rows.length === 0) {
      return result;
    }

    const marginEngine = require('./riskPlugins/marginEngine');
    const guaranteeEngine = require('./riskPlugins/guaranteeEngine');
    const marginOrderDao = require('../dao/marginOrderDao');
    const guaranteeContractDao = require('../dao/guaranteeContractDao');

    for (const row of rows) {
      const loanId = row.id;
      try {
        const marginOrder = await marginOrderDao.findByLoanId(loanId);
        if (marginOrder && marginOrder.status === 'FROZEN') {
          await marginEngine.releaseMargin(loanId);
          result.marginReleased++;
          logger.info('结算对账：押金订单补释放', { loanId, orderId: marginOrder.id });
        }

        const contract = await guaranteeContractDao.findByLoanId(loanId);
        if (contract && contract.status === 'ACTIVE') {
          if (Number(contract.fee_collected) !== 1) {
            // 担保费未代收入池，无法无源结算；记录后由人工/后续轮次处理
            result.skipped++;
            logger.warning('结算对账：合约担保费未代收（fee_collected≠1），跳过结算', { loanId, contractId: contract.id });
          } else {
            await guaranteeEngine.settleGuaranteeRevenue(contract.id);
            await guaranteeEngine.releaseGuarantorQuota(contract.id);
            result.contractsSettled++;
            logger.info('结算对账：担保合约补结算', { loanId, contractId: contract.id });
          }
        }
      } catch (error) {
        result.errors++;
        logger.error('结算对账失败', { loanId, error: error.message });
      }
    }

    if (result.total > 0) {
      logger.info('结算对账任务结束', result);
    }
    return result;
  } catch (error) {
    logger.error('结算对账任务失败', { error: error.message });
    throw error;
  }
};

module.exports = { checkOverdueLoans, getOverdueStats, getOverdueDays, liquidateOverdueLoans, cleanupOrphanMarginOrders, reconcileSettlements };