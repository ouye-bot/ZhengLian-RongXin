const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const { execute } = require('../config/database');

// 创建数据库表
const createTables = async () => {
  try {
    console.log('开始创建数据库表...');
    
    // 创建users表
    await execute(`
      CREATE TABLE IF NOT EXISTS users (
        id BIGINT PRIMARY KEY AUTO_INCREMENT,
        username VARCHAR(255) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        salt VARCHAR(255) NOT NULL,
        sm2_public_key TEXT NOT NULL,
        balance TEXT,
        frozen_balance TEXT,
        credit_score TEXT,
        role VARCHAR(50) DEFAULT 'user',
        totp_secret VARCHAR(500) DEFAULT NULL,
        totp_enabled BOOLEAN DEFAULT FALSE,
        backup_codes_hashed TEXT DEFAULT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_username (username)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    console.log('users表创建成功');
    
    // 创建transactions表
    await execute(`
      CREATE TABLE IF NOT EXISTS transactions (
        id INT PRIMARY KEY AUTO_INCREMENT,
        user_id BIGINT NOT NULL,
        type VARCHAR(50) NOT NULL,
        amount TEXT,
        interest TEXT,
        total_amount TEXT,
        status VARCHAR(50) NOT NULL,
        tx_hash VARCHAR(255),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_user_id (user_id),
        INDEX idx_status (status),
        INDEX idx_created_at (created_at),
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    console.log('transactions表创建成功');
    
    // 创建fund_pool表
    await execute(`
      CREATE TABLE IF NOT EXISTS fund_pool (
        id INT PRIMARY KEY AUTO_INCREMENT,
        total_amount DECIMAL(20,2) DEFAULT 0,
        available_amount DECIMAL(20,2) DEFAULT 0,
        reserved_amount DECIMAL(20,2) DEFAULT 0,
        total_interest_earned DECIMAL(20,2) DEFAULT 0.00 COMMENT '平台已赚取的总利息收入',
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    console.log('fund_pool表创建成功');

    // 兼容 MySQL 5.7/8.0：先检查字段是否存在，再决定是否添加
    const addColumnIfNotExists = async (table, column, definition) => {
      const rows = await execute(`
        SELECT COUNT(*) AS cnt FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?
      `, [table, column]);
      if (rows[0].cnt === 0) {
        await execute(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
        console.log(`${table}.${column} 字段已添加`);
      } else {
        console.log(`${table}.${column} 字段已存在，跳过`);
      }
    };

    // 为已有表添加新字段（幂等操作）
    await addColumnIfNotExists('fund_pool', 'total_interest_earned', "DECIMAL(20,2) DEFAULT 0.00 COMMENT '平台已赚取的总利息收入'");
    await addColumnIfNotExists('fund_pool', 'platform_capital', "DECIMAL(15,2) NOT NULL DEFAULT 0 COMMENT '平台自有资金'");
    await addColumnIfNotExists('fund_pool', 'user_capital', "DECIMAL(15,2) NOT NULL DEFAULT 0 COMMENT '用户出资总额'");
    await addColumnIfNotExists('fund_pool', 'loaned_amount', "DECIMAL(15,2) NOT NULL DEFAULT 0 COMMENT '已借出本金总额'");
    await addColumnIfNotExists('fund_pool', 'user_interest_earned', "DECIMAL(20,2) NOT NULL DEFAULT 0.00 COMMENT '用户应得利息累计'");
    console.log('fund_pool表新字段迁移完成');

    // 初始化新字段数据（幂等：仅当新字段为默认值时执行）
    try {
      await execute(`
        UPDATE fund_pool
        SET platform_capital = 10000,
            user_capital = total_amount - 10000,
            loaned_amount = reserved_amount
        WHERE platform_capital = 0 AND user_capital = 0 AND loaned_amount = 0
      `);
      console.log('fund_pool表新字段数据初始化完成');
    } catch (e) {
      console.log('fund_pool表新字段数据初始化跳过:', e.message);
    }

    // 为transactions表添加term和due_date字段（幂等操作）
    await addColumnIfNotExists('transactions', 'term', "INT DEFAULT NULL COMMENT '投资期限(天)'");
    await addColumnIfNotExists('transactions', 'due_date', "TIMESTAMP NULL DEFAULT NULL COMMENT '到期日期'");
    await addColumnIfNotExists('transactions', 'borrow_user_ratio', "DECIMAL(5,4) DEFAULT NULL COMMENT '借款时用户池出资比例'");
    await addColumnIfNotExists('transactions', 'borrow_platform_ratio', "DECIMAL(5,4) DEFAULT NULL COMMENT '借款时系统池出资比例'");
    console.log('transactions表字段检查完成');

    // 创建credit_proofs表
    await execute(`
      CREATE TABLE IF NOT EXISTS credit_proofs (
        id INT PRIMARY KEY AUTO_INCREMENT,
        user_id BIGINT NOT NULL,
        proof_id VARCHAR(255) UNIQUE NOT NULL,
        verification_code VARCHAR(255) NOT NULL,
        sm3_hash VARCHAR(255) NOT NULL,
        proof_data TEXT NOT NULL,
        expires_at TIMESTAMP NOT NULL,
        zk_proof TEXT DEFAULT NULL COMMENT 'snarkjs proof JSON (pi_a, pi_b, pi_c)',
        public_signals TEXT DEFAULT NULL COMMENT 'publicSignals array JSON',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_user_id (user_id),
        INDEX idx_proof_id (proof_id),
        INDEX idx_expires_at (expires_at),
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    console.log('credit_proofs表创建成功');

    // 为credit_proofs表添加ZKP持久化字段（幂等操作）
    await addColumnIfNotExists('credit_proofs', 'zk_proof', "TEXT DEFAULT NULL COMMENT 'snarkjs proof JSON (pi_a, pi_b, pi_c)'");
    await addColumnIfNotExists('credit_proofs', 'public_signals', "TEXT DEFAULT NULL COMMENT 'publicSignals array JSON'");
    // 验证口令24h有效期（独立于证明本体 expires_at 的 30 天）；
    // 校验语义为 COALESCE(code_expires_at, expires_at)：存量行该列为 NULL 时退回原 30 天口径，不误伤在途证明
    await addColumnIfNotExists('credit_proofs', 'code_expires_at', "TIMESTAMP NULL DEFAULT NULL COMMENT '验证口令有效期(24h)，NULL=存量行退回expires_at'");
    console.log('credit_proofs表ZKP持久化字段迁移完成');
    
    // 创建replay_nonces表
    await execute(`
      CREATE TABLE IF NOT EXISTS replay_nonces (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        nonce VARCHAR(64) NOT NULL UNIQUE,
        expires_at BIGINT NOT NULL COMMENT '过期时间戳（毫秒）',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_expires_at (expires_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    console.log('replay_nonces表创建成功');
    
    // 创建token_blacklist表
    await execute(`
      CREATE TABLE IF NOT EXISTS token_blacklist (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        jti VARCHAR(64) NOT NULL UNIQUE,
        expires_at BIGINT NOT NULL COMMENT '过期时间戳（毫秒）',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_expires_at (expires_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    console.log('token_blacklist表创建成功');
    
    // 创建user_keys表（Round 4：每用户独立 DEK）
    await execute(`
      CREATE TABLE IF NOT EXISTS user_keys (
        user_id       BIGINT PRIMARY KEY,
        encrypted_dek TEXT NOT NULL COMMENT 'DEK 被 Master Key 加密后的密文（SM4-CBC + HMAC-SM3 格式）',
        created_at    BIGINT NOT NULL COMMENT '创建时间戳',
        rotated_at    BIGINT DEFAULT NULL COMMENT '最近一次密钥轮换时间戳',
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    console.log('user_keys表创建成功');

    // 创建credit_history表
    await execute(`
      CREATE TABLE IF NOT EXISTS credit_history (
        id INT PRIMARY KEY AUTO_INCREMENT,
        user_id BIGINT NOT NULL,
        score INT NOT NULL COMMENT '变更后的信用分',
        change_amount INT NOT NULL COMMENT '分值变化（正为增加，负为减少）',
        reason VARCHAR(255) NOT NULL COMMENT '变更原因',
        transaction_id INT DEFAULT NULL COMMENT '关联的交易ID',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_user_id (user_id),
        INDEX idx_created_at (created_at),
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    console.log('credit_history表创建成功');

    // 创建blockchain_queue表（区块链写入重试队列）
    await execute(`
      CREATE TABLE IF NOT EXISTS blockchain_queue (
        id INT PRIMARY KEY AUTO_INCREMENT,
        operation_type VARCHAR(50) NOT NULL COMMENT '操作类型: storeAuditHash/storeTransactionHash/registerUserOnChain/verifyZKPOnChain',
        payload TEXT NOT NULL COMMENT '操作参数 JSON',
        status VARCHAR(20) NOT NULL DEFAULT 'pending' COMMENT '状态: pending/processing/completed/failed',
        retry_count INT NOT NULL DEFAULT 0,
        max_retries INT NOT NULL DEFAULT 3,
        last_error TEXT DEFAULT NULL,
        next_retry_at TIMESTAMP NULL DEFAULT NULL,
        completed_at TIMESTAMP NULL DEFAULT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_status (status),
        INDEX idx_next_retry (next_retry_at),
        INDEX idx_created_at (created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    console.log('blockchain_queue表创建成功');

    // 创建risk_margin_orders表（保证金订单表）
    await execute(`
      CREATE TABLE IF NOT EXISTS risk_margin_orders (
        id INT PRIMARY KEY AUTO_INCREMENT,
        loan_id INT NOT NULL COMMENT '关联借款ID',
        user_id BIGINT NOT NULL COMMENT '用户ID',
        margin_amount DECIMAL(12,2) NOT NULL COMMENT '保证金金额',
        margin_rate DECIMAL(5,4) NOT NULL COMMENT '保证金比例',
        frozen_interest DECIMAL(12,2) DEFAULT 0 COMMENT '冻结期利息',
        status VARCHAR(20) NOT NULL DEFAULT 'FROZEN' COMMENT '状态: FROZEN/RELEASED/LIQUIDATED',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_loan_id (loan_id),
        INDEX idx_user_id (user_id),
        INDEX idx_status (status)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    console.log('risk_margin_orders表创建成功');

    // 修复 loan_id 为允许 NULL（beforeBorrow hook 在借款记录创建前冻结保证金）
    try {
      await execute("ALTER TABLE risk_margin_orders MODIFY COLUMN loan_id INT DEFAULT NULL COMMENT '关联借款ID'");
      console.log('risk_margin_orders.loan_id 已修改为允许NULL');
    } catch (e) {
      if (e.message.includes('Duplicate column') || e.message.includes('check your')) {
        console.log('risk_margin_orders.loan_id 已经允许NULL，跳过');
      } else {
        console.log('risk_margin_orders.loan_id 修改跳过:', e.message);
      }
    }

    // 创建risk_guarantee_contracts表（担保合约表）
    await execute(`
      CREATE TABLE IF NOT EXISTS risk_guarantee_contracts (
        id INT PRIMARY KEY AUTO_INCREMENT,
        loan_id INT COMMENT '关联借款ID',
        borrower_id BIGINT NOT NULL COMMENT '借款人ID',
        guarantor_id BIGINT NOT NULL COMMENT '担保人ID',
        guarantee_amount DECIMAL(12,2) NOT NULL COMMENT '担保金额',
        fee_rate DECIMAL(5,4) NOT NULL COMMENT '担保费率',
        fee_amount DECIMAL(12,2) NOT NULL COMMENT '担保服务费',
        guarantor_signature TEXT COMMENT '担保人SM2签名',
        signature_data TEXT COMMENT '签名原文',
        status VARCHAR(20) NOT NULL DEFAULT 'PENDING' COMMENT '状态: PENDING/ACTIVE/COMPLETED/LIQUIDATED',
        expire_time TIMESTAMP NULL DEFAULT NULL COMMENT '过期时间',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_loan_id (loan_id),
        INDEX idx_borrower_id (borrower_id),
        INDEX idx_guarantor_id (guarantor_id),
        INDEX idx_status (status)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    console.log('risk_guarantee_contracts表创建成功');

    // 阶段2 资金账务修复：担保费代收标记与增量释放额度（幂等迁移）
    await addColumnIfNotExists('risk_guarantee_contracts', 'fee_collected', "TINYINT DEFAULT 0 COMMENT '担保费是否已随借款人还款代收入池 0否1是'");
    await addColumnIfNotExists('risk_guarantee_contracts', 'released_amount', "DECIMAL(15,2) DEFAULT 0 COMMENT '已按累计还款比例释放的担保额度'");
    console.log('risk_guarantee_contracts表字段检查完成');

    // 创建user_notifications表（用户通知表）
    await execute(`
      CREATE TABLE IF NOT EXISTS user_notifications (
        id INT PRIMARY KEY AUTO_INCREMENT,
        user_id BIGINT NOT NULL COMMENT '用户ID',
        type VARCHAR(50) NOT NULL COMMENT '通知类型: GUARANTEE_REQUEST/GUARANTEE_ACCEPTED/GUARANTEE_REJECTED/GUARANTEE_EXPIRED/LOAN_OVERDUE/SYSTEM',
        title VARCHAR(100) NOT NULL COMMENT '通知标题',
        content TEXT COMMENT '通知内容',
        related_id INT COMMENT '关联业务ID',
        is_read TINYINT(1) DEFAULT 0 COMMENT '是否已读',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_user_id (user_id),
        INDEX idx_is_read (is_read),
        INDEX idx_created_at (created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    console.log('user_notifications表创建成功');

    // 创建guarantee_requests表（担保邀约表）
    await execute(`
      CREATE TABLE IF NOT EXISTS guarantee_requests (
        id INT PRIMARY KEY AUTO_INCREMENT,
        borrower_id BIGINT NOT NULL COMMENT '借款人ID',
        guarantor_id BIGINT NOT NULL COMMENT '目标担保人ID',
        loan_amount DECIMAL(12,2) NOT NULL COMMENT '借款金额',
        proposed_fee_rate DECIMAL(5,4) NOT NULL COMMENT '提议费率',
        status VARCHAR(20) NOT NULL DEFAULT 'PENDING' COMMENT '状态: PENDING/ACCEPTED/REJECTED/EXPIRED',
        expire_time TIMESTAMP NULL DEFAULT NULL COMMENT '过期时间（默认24小时）',
        borrower_signature TEXT COMMENT '借款人SM2签名',
        guarantor_signature TEXT COMMENT '担保人SM2签名',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_borrower_id (borrower_id),
        INDEX idx_guarantor_id (guarantor_id),
        INDEX idx_status (status)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    console.log('guarantee_requests表创建成功');

    // 为transactions表添加风控增强字段（幂等操作）
    await addColumnIfNotExists('transactions', 'risk_mode', "TINYINT DEFAULT 0 COMMENT '风控模式：0-无，1-押金，2-担保'");
    await addColumnIfNotExists('transactions', 'margin_order_id', "INT DEFAULT NULL COMMENT '保证金订单ID'");
    await addColumnIfNotExists('transactions', 'guarantee_contract_id', "INT DEFAULT NULL COMMENT '担保合约ID'");
    console.log('transactions表风控增强字段迁移完成');

    // 创建zk_queue表（ZKP任务持久化队列）
    await execute(`
      CREATE TABLE IF NOT EXISTS zk_queue (
        id INT PRIMARY KEY AUTO_INCREMENT,
        task_id VARCHAR(64) UNIQUE NOT NULL COMMENT '任务UUID',
        task_data TEXT NOT NULL COMMENT '任务参数 JSON',
        status VARCHAR(20) NOT NULL DEFAULT 'pending' COMMENT '状态: pending/processing/completed/failed',
        result TEXT DEFAULT NULL COMMENT '结果 JSON',
        error TEXT DEFAULT NULL COMMENT '错误信息',
        retry_count INT NOT NULL DEFAULT 0,
        max_retries INT NOT NULL DEFAULT 3,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_status (status),
        INDEX idx_task_id (task_id),
        INDEX idx_created_at (created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    console.log('zk_queue表创建成功');

    // 创建fund_pool_snapshots表（资金池日快照，供资金池页历史趋势图；由 GET /pool/history 读取时 upsert 当日快照）
    await execute(`
      CREATE TABLE IF NOT EXISTS fund_pool_snapshots (
        snap_date DATE PRIMARY KEY,
        total_amount DECIMAL(20,2) NOT NULL DEFAULT 0,
        available_amount DECIMAL(20,2) NOT NULL DEFAULT 0,
        platform_capital DECIMAL(20,2) NOT NULL DEFAULT 0,
        user_capital DECIMAL(20,2) NOT NULL DEFAULT 0,
        loaned_amount DECIMAL(20,2) NOT NULL DEFAULT 0,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    console.log('fund_pool_snapshots表创建成功');

    // 创建crypto_logs表（阶段3：密码操作日志落库，两套 logger 双写）
    //   source='chain'：services/cryptoLogger.js 防篡改审计链（JSON 文件为主链，DB 为可查询副本，
    //                   data 列存完整条目 JSON（含 index/timestamp/data），prev_hash/current_hash 为 SM3 链哈希，
    //                   verifyChainFromDb() 可查库逐条重算复核）
    //   source='op'   ：utils/cryptoLogger.js auth 操作流水（log 文件 + DB），username/status 有值，无链哈希
    await execute(`
      CREATE TABLE IF NOT EXISTS crypto_logs (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        source ENUM('chain','op') NOT NULL COMMENT 'chain=哈希链审计/op=操作流水',
        user_id VARCHAR(64) NOT NULL DEFAULT '' COMMENT '用户ID（匿名/缺省为空串）',
        username VARCHAR(64) DEFAULT NULL,
        operation_type VARCHAR(100) NOT NULL,
        status VARCHAR(20) DEFAULT NULL,
        description VARCHAR(512) DEFAULT NULL,
        data JSON DEFAULT NULL COMMENT 'chain=完整日志条目JSON；op={detail,correlationInfo}',
        prev_hash CHAR(64) DEFAULT NULL,
        current_hash CHAR(64) DEFAULT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_crypto_logs_user (user_id),
        INDEX idx_crypto_logs_op (operation_type)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    console.log('crypto_logs表创建成功');

    console.log('所有表创建完成');
  } catch (error) {
    console.error('创建表时出错:', error);
    throw error;
  }
};

module.exports = { createTables };

// 直接运行时执行
if (require.main === module) {
  createTables().then(() => process.exit(0)).catch(() => process.exit(1));
}