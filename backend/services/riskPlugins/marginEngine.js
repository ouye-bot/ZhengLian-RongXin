const { transaction } = require('../../config/database');
const { invalidatePoolReadCaches } = require('../../utils/ttlCache');
const marginOrderDao = require('../../dao/marginOrderDao');
const userDao = require('../../dao/userDao');
const { encryptFields, decryptFields } = require('../../utils/sm4Crypto');
const logger = require('../../utils/logger');

// 保证金配置参数（通过环境变量覆盖）
const MARGIN_BASE_RATE = parseFloat(process.env.MARGIN_BASE_RATE) || 0.20;
const MARGIN_MIN_RATE = parseFloat(process.env.MARGIN_MIN_RATE) || 0.15;
const MARGIN_MAX_RATE = parseFloat(process.env.MARGIN_MAX_RATE) || 0.25;
const MARGIN_INTEREST_RATE = parseFloat(process.env.MARGIN_INTEREST_RATE) || 0.0035;

class MarginEngine {
  /**
   * 计算保证金费率
   * @param {number} creditScore - 信用分
   * @param {number} term - 贷款期限（天）
   * @returns {number} 保证金费率
   */
  calculateMarginRate(creditScore, term) {
    let rate = MARGIN_BASE_RATE;

    // 期限溢价：长期贷款需要更高保证金
    if (term >= 90) {
      rate += 0.05;
    } else if (term >= 30) {
      rate += 0.03;
    }

    // 信用折扣：高信用分降低保证金要求
    if (creditScore >= 800) {
      rate -= 0.05;
    } else if (creditScore >= 700) {
      rate -= 0.03;
    }

    // 钳位到允许范围
    return Math.min(MARGIN_MAX_RATE, Math.max(MARGIN_MIN_RATE, rate));
  }

  /**
   * 计算保证金金额
   * @param {number} loanAmount - 贷款金额
   * @param {number} creditScore - 信用分
   * @param {number} term - 贷款期限（天）
   * @returns {{ marginRate: number, marginAmount: number }}
   */
  calculateMargin(loanAmount, creditScore, term) {
    const marginRate = this.calculateMarginRate(creditScore, term);
    const marginAmount = Math.round(loanAmount * marginRate * 100) / 100;
    return { marginRate, marginAmount };
  }

  /**
   * 冻结保证金（原子事务）
   * @param {number|string} userId - 用户ID
   * @param {number} amount - 冻结金额
   * @param {number} loanId - 贷款ID
   * @param {number} [marginRate=0] - 押金费率（阶段2 I：由调用方按 calculateMarginRate 传入并落库）
   * @returns {Promise<Object>} 保证金订单
   */
  async freezeMargin(userId, amount, loanId, marginRate = 0) {
    if (!userId || !amount || loanId === undefined) {
      throw new Error('缺少必要参数：userId, amount, loanId');
    }
    if (amount <= 0) {
      throw new Error('冻结金额必须大于0');
    }

    userId = userId.toString();

    return await transaction(async (connection) => {
      // 1. 锁定用户行，读取余额和冻结余额
      const [userRows] = await connection.execute(
        'SELECT balance, frozen_balance FROM users WHERE id = ? FOR UPDATE',
        [userId]
      );
      if (!userRows || userRows.length === 0) {
        throw new Error('用户不存在');
      }

      // 2. 解密余额字段
      const balanceRow = {
        balance: userRows[0].balance,
        frozen_balance: userRows[0].frozen_balance
      };
      await decryptFields('users', balanceRow, userId, connection);

      const currentBalance = Number(balanceRow.balance) || 0;
      const currentFrozen = Number(balanceRow.frozen_balance) || 0;

      // 3. 检查可用余额
      if (currentBalance < amount) {
        throw new Error(`余额不足：当前余额 ${currentBalance}，需要冻结 ${amount}`);
      }

      // 4. 计算新余额
      const newBalance = currentBalance - amount;
      const newFrozen = currentFrozen + amount;

      // 5. 加密并更新用户余额
      const balanceData = { balance: newBalance, frozen_balance: newFrozen };
      await encryptFields('users', balanceData, userId, connection);
      await connection.execute(
        'UPDATE users SET balance = ?, frozen_balance = ? WHERE id = ?',
        [balanceData.balance, balanceData.frozen_balance, userId]
      );

      // 6. 创建保证金订单（默认状态为 FROZEN；阶段2 I：margin_rate 落真实费率）
      const marginOrder = await marginOrderDao.create(
        {
          loan_id: loanId,
          user_id: parseInt(userId),
          margin_amount: amount,
          margin_rate: Number(marginRate) || 0,
          frozen_interest: 0,
          status: 'FROZEN'
        },
        connection
      );

      logger.info('保证金冻结成功', { userId, loanId, amount });
      return marginOrder;
    });
  }

  /**
   * 释放保证金（原子事务）
   * @param {number} loanId - 贷款ID
   * @param {Object} [connection] - 可选外部事务连接（由调用方保证原子性，如违约清算）
   * @returns {Promise<Object>} 更新后的保证金订单
   */
  async releaseMargin(loanId, connection = null) {
    if (!loanId) {
      throw new Error('缺少必要参数：loanId');
    }

    const round2 = (x) => Math.round(x * 100) / 100;
    const run = async (connection) => {
      // 1. 查找保证金订单
      const marginOrder = await marginOrderDao.findByLoanId(loanId, connection);
      if (!marginOrder) {
        throw new Error(`未找到贷款 ${loanId} 的保证金订单`);
      }
      if (marginOrder.status !== 'FROZEN') {
        throw new Error(`保证金订单状态异常：当前状态 ${marginOrder.status}，期望 FROZEN`);
      }

      // 2. 计算冻结利息
      const freezeStart = new Date(marginOrder.created_at);
      const freezeEnd = new Date();
      const freezeDays = Math.max(1, Math.ceil((freezeEnd - freezeStart) / (1000 * 60 * 60 * 24)));
      const interest = Math.round(marginOrder.margin_amount * MARGIN_INTEREST_RATE * freezeDays / 365 * 100) / 100;

      // 3. 锁定用户行，解密余额（锁序：先 user 后 pool，与 repay 一致）
      const userId = marginOrder.user_id.toString();
      const [userRows] = await connection.execute(
        'SELECT balance, frozen_balance FROM users WHERE id = ? FOR UPDATE',
        [userId]
      );
      if (!userRows || userRows.length === 0) {
        throw new Error('用户不存在');
      }

      const balanceRow = {
        balance: userRows[0].balance,
        frozen_balance: userRows[0].frozen_balance
      };
      await decryptFields('users', balanceRow, userId, connection);

      const currentBalance = Number(balanceRow.balance) || 0;
      const currentFrozen = Number(balanceRow.frozen_balance) || 0;

      // 4.【阶段2 D】冻结期利息由平台池支付：同事务锁池，PC−=利息、total 同减；
      // PC 不足则抛错回滚（由结算对账定时任务重试兜底），杜绝利息无源发放
      const [poolRows] = await connection.execute('SELECT * FROM fund_pool WHERE id = 1 FOR UPDATE');
      if (!poolRows || poolRows.length === 0) {
        throw new Error('资金池不存在');
      }
      const pool = poolRows[0];
      const poolPC = Number(pool.platform_capital || 0);
      if (poolPC < interest) {
        throw new Error(`平台资金不足以支付押金冻结期利息：PC=${poolPC}，应付=${interest}`);
      }
      const newPC = round2(poolPC - interest);
      const newUC = Number(pool.user_capital || 0);
      const newLA = Number(pool.loaned_amount || 0);
      const newTotal = round2(newPC + newUC);
      const newAvail = round2(newTotal - newLA);

      await connection.execute(
        'UPDATE fund_pool SET platform_capital=?, total_amount=?, available_amount=? WHERE id=1',
        [newPC, newTotal, newAvail]
      );

      // 5. 计算新余额：归还保证金 + 冻结利息（利息部分已由 PC 支付）
      const newBalance = round2(currentBalance + marginOrder.margin_amount + interest);
      const newFrozen = round2(currentFrozen - marginOrder.margin_amount);

      // 6. 加密并更新用户余额
      const balanceData = { balance: newBalance, frozen_balance: newFrozen };
      await encryptFields('users', balanceData, userId, connection);
      await connection.execute(
        'UPDATE users SET balance = ?, frozen_balance = ? WHERE id = ?',
        [balanceData.balance, balanceData.frozen_balance, userId]
      );

      // 7. 更新保证金订单状态为 RELEASED
      const updatedOrder = await marginOrderDao.updateStatus(
        marginOrder.id,
        'RELEASED',
        { frozen_interest: interest },
        connection
      );

      logger.info('保证金释放成功', { loanId, userId, amount: marginOrder.margin_amount, interest, paidByPool: interest });
      return updatedOrder;
    };
    // 传入 connection（嵌套在外层事务）时由外层提交后失效（当前无嵌套调用方，预留口径）；
    // 自有事务分支在此提交后失效（写点清单见 utils/ttlCache.js）
    if (connection) return await run(connection);
    const released = await transaction(run);
    invalidatePoolReadCaches();
    return released;
  }

  /**
   * 清算保证金（原子事务，扣除冻结金额不归还）
   * 阶段2 B 改造：没收的保证金入平台池（PC+=margin）、核销贷款剩余本金（LA−=剩余本金），
   * 保持资金池恒等式；支持传入外部事务 connection（由调用方保证原子性，如违约清算）
   * @param {number} loanId - 贷款ID
   * @param {Object} [connection] - 可选外部事务连接
   * @returns {Promise<Object>} 更新后的保证金订单
   */
  async liquidateMargin(loanId, connection = null) {
    if (!loanId) {
      throw new Error('缺少必要参数：loanId');
    }

    const round2 = (x) => Math.round(x * 100) / 100;
    const run = async (connection) => {
      // 1. 查找保证金订单
      const marginOrder = await marginOrderDao.findByLoanId(loanId, connection);
      if (!marginOrder) {
        throw new Error(`未找到贷款 ${loanId} 的保证金订单`);
      }
      if (marginOrder.status !== 'FROZEN') {
        throw new Error(`保证金订单状态异常：当前状态 ${marginOrder.status}，期望 FROZEN`);
      }

      // 2. 锁定用户行，解密冻结余额（锁序：先 user 后 pool）
      const userId = marginOrder.user_id.toString();
      const [userRows] = await connection.execute(
        'SELECT balance, frozen_balance FROM users WHERE id = ? FOR UPDATE',
        [userId]
      );
      if (!userRows || userRows.length === 0) {
        throw new Error('用户不存在');
      }

      const balanceRow = {
        balance: userRows[0].balance,
        frozen_balance: userRows[0].frozen_balance
      };
      await decryptFields('users', balanceRow, userId, connection);

      const currentFrozen = Number(balanceRow.frozen_balance) || 0;

      // 3. 扣除冻结余额（不归还到可用余额）
      const newFrozen = round2(currentFrozen - marginOrder.margin_amount);

      // 4. 加密并更新用户冻结余额
      const balanceData = { frozen_balance: newFrozen };
      await encryptFields('users', balanceData, userId, connection);
      await connection.execute(
        'UPDATE users SET frozen_balance = ? WHERE id = ?',
        [balanceData.frozen_balance, userId]
      );

      // 5.【阶段2 B】没收保证金入平台池、核销该贷款剩余本金（PC+=margin、LA−=剩余本金）
      const transactionDao = require('../../dao/transactionDao');
      const loanTx = await transactionDao.findById(loanId, connection);
      const principalOutstanding = loanTx ? Math.max(0, Number(loanTx.amount) || 0) : 0;

      const [poolRows] = await connection.execute('SELECT * FROM fund_pool WHERE id = 1 FOR UPDATE');
      if (!poolRows || poolRows.length === 0) {
        throw new Error('资金池不存在');
      }
      const pool = poolRows[0];
      // 资本口径：没收押金替代核销债权入池 → PC 净变 = 押金 − 核销本金（押金不足覆盖本金的差额由平台承担）
      const newPC = round2(Number(pool.platform_capital || 0) + Number(marginOrder.margin_amount || 0) - principalOutstanding);
      const newLA = round2(Number(pool.loaned_amount || 0) - principalOutstanding);
      const newUC = Number(pool.user_capital || 0);
      const newTotal = round2(newPC + newUC);
      const newAvail = round2(newTotal - newLA);

      await connection.execute(
        'UPDATE fund_pool SET platform_capital=?, loaned_amount=?, total_amount=?, available_amount=? WHERE id=1',
        [newPC, newLA, newTotal, newAvail]
      );

      // 6. 更新保证金订单状态为 LIQUIDATED
      const updatedOrder = await marginOrderDao.updateStatus(
        marginOrder.id,
        'LIQUIDATED',
        {},
        connection
      );

      logger.info('保证金清算完成', { loanId, userId, liquidated: marginOrder.margin_amount, principalOutstanding });
      return updatedOrder;
    };
    // 嵌套（overdueService.liquidateOverdueLoans 传入 connection）由外层提交后失效；自有事务分支在此失效
    if (connection) return await run(connection);
    const liquidated = await transaction(run);
    invalidatePoolReadCaches();
    return liquidated;
  }
}

module.exports = new MarginEngine();
