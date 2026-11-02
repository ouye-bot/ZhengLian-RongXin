/**
 * auth 操作流水日志
 * ─────────────────────────────
 * 分工（与 services/cryptoLogger.js 界定，阶段3）：
 *   本模块 = 操作流水：logs/crypto_operations.log（一行一条 JSON）为主，
 *            每条成功追加后双写 crypto_logs 表 source='op'（username/status 有值，无链哈希），
 *            DB 写失败仅告警不抛错（流水日志不影响业务主流程）；auth.js 13 处调用。
 *   services/cryptoLogger.js = 防篡改审计链（SM3 哈希链，data/crypto_logs.json 主链 + crypto_logs source='chain'）。
 */
const fs = require('fs').promises;
const path = require('path');
const { execute } = require('../config/database');

// 密码操作日志文件路径
const CRYPTO_LOG_DIR = path.join(__dirname, '../logs');
const CRYPTO_LOG_FILE = path.join(CRYPTO_LOG_DIR, 'crypto_operations.log');

// 确保日志目录存在
const ensureCryptoLogDir = async () => {
  try {
    await fs.mkdir(CRYPTO_LOG_DIR, { recursive: true });
  } catch (error) {
    console.error('创建密码操作日志目录失败:', error);
  }
};

// 初始化日志目录
ensureCryptoLogDir();

/**
 * 记录密码操作日志
 * @param {string} operationType - 操作类型（如：SM2密钥生成、SM2签名、SM3哈希、密码验证等）
 * @param {string} userId - 用户ID
 * @param {string} username - 用户名
 * @param {string} status - 操作状态（成功、失败、发起）
 * @param {string} description - 操作描述
 * @param {Object} detail - 操作详情
 * @param {Object} correlationInfo - 关联信息
 */
const logCryptoOperation = async (operationType, userId, username, status, description, detail = {}, correlationInfo = null) => {
  try {
    const now = new Date();
    const formattedTime = now.toLocaleTimeString('zh-CN', {
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    });
    const fullTimestamp = now.toISOString();
    
    // 生成唯一ID
    const logId = Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
    
    const logEntry = {
      id: logId,
      userId: userId || 'anonymous',
      username: username || 'anonymous',
      operationType,
      description,
      status,
      detail,
      timestamp: formattedTime,
      fullTimestamp,
      correlationInfo
    };

    // 控制台输出
    console.log(`[${fullTimestamp}] [CRYPTO] ${operationType} - ${status} - ${username || userId || 'anonymous'}: ${description}`);

    // 文件输出（主）
    const logString = JSON.stringify(logEntry) + '\n';
    await fs.appendFile(CRYPTO_LOG_FILE, logString);

    // 双写 crypto_logs 表（source='op'，操作流水副本；DB 失败仅告警，不影响业务主流程）
    try {
      await execute(
        `INSERT INTO crypto_logs (source, user_id, username, operation_type, status, description, data)
         VALUES ('op', ?, ?, ?, ?, ?, ?)`,
        [
          String(userId ?? ''),
          username ? String(username) : null,
          operationType,
          status ? String(status) : null,
          String(description ?? ''),
          JSON.stringify({ detail, correlationInfo })
        ]
      );
    } catch (dbError) {
      console.error('[cryptoLogger] crypto_logs(op) DB 双写失败（log 文件不受影响）:', dbError.message);
    }
  } catch (error) {
    console.error('记录密码操作日志失败:', error);
  }
};

/**
 * 清理过期日志
 * @param {number} days - 保留天数
 */
const cleanExpiredLogs = async (days = 30) => {
  try {
    const logs = await fs.readFile(CRYPTO_LOG_FILE, 'utf8');
    const logEntries = logs.split('\n').filter(line => line.trim() !== '').map(JSON.parse);
    
    const cutoffTime = Date.now() - (days * 24 * 60 * 60 * 1000);
    const validLogs = logEntries.filter(entry => new Date(entry.fullTimestamp).getTime() > cutoffTime);
    
    if (validLogs.length < logEntries.length) {
      const validLogStrings = validLogs.map(entry => JSON.stringify(entry)).join('\n');
      await fs.writeFile(CRYPTO_LOG_FILE, validLogStrings + '\n');
      console.log(`清理了 ${logEntries.length - validLogs.length} 条过期密码操作日志`);
    }
  } catch (error) {
    console.error('清理过期日志失败:', error);
  }
};

// 导出密码操作日志函数
module.exports = {
  logCryptoOperation,
  cleanExpiredLogs
};
