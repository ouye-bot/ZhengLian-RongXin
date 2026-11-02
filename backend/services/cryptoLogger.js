/**
 * 防篡改审计链日志（SM3 哈希链）
 * ─────────────────────────────
 * 分工（与 utils/cryptoLogger.js 界定，阶段3）：
 *   本模块 = 哈希链审计日志：data/crypto_logs.json 为主链（SM3 逐条链式哈希，verifyChain 复核），
 *            每条成功写文件后双写 crypto_logs 表 source='chain'（含 prev_hash/current_hash 与完整条目 JSON），
 *            DB 写失败仅告警不抛错（文件链完整性优先）；消费者 routes/cryptoLog.js、routes/audit.js。
 *   utils/cryptoLogger.js = auth 操作流水（logs/crypto_operations.log + crypto_logs 表 source='op'），无链哈希。
 */
const fs = require('fs').promises;
const path = require('path');
const { sm3 } = require('sm-crypto');
const { execute } = require('../config/database');

const LOG_FILE_PATH = path.join(__dirname, '..', 'data', 'crypto_logs.json');

class CryptoLogger {
  constructor() {
    this._writeLock = Promise.resolve();
  }

  async logOperation(userId, operationType, description, data = {}) {
    // 串行化写入，防止并发损坏
    return new Promise((resolve, reject) => {
      this._writeLock = this._writeLock.then(() => this._doLog(userId, operationType, description, data)).then(resolve).catch(reject);
    });
  }

  async _doLog(userId, operationType, description, data = {}) {
    try {
      // 确保 data 目录存在
      await fs.mkdir(path.dirname(LOG_FILE_PATH), { recursive: true });

      // 读取现有日志
      let logs = [];
      try {
        const content = await fs.readFile(LOG_FILE_PATH, 'utf8');
        logs = JSON.parse(content);
      } catch (error) {
        // 文件不存在或为空，初始化空数组
        logs = [];
      }

      // 生成新日志ID
      const id = logs.length + 1;

      // 计算上一条日志的哈希
      let prevHash = '';
      if (logs.length > 0) {
        prevHash = logs[logs.length - 1].currentHash;
      }

      // 构造日志对象
      const newLog = {
        id,
        index: id,
        userId,
        operationType,
        description,
        data,
        timestamp: new Date().toISOString(),
        prevHash
      };

      // 计算当前日志的哈希
      const hashInput = newLog.index +
                       newLog.timestamp +
                       newLog.userId +
                       newLog.operationType +
                       newLog.description +
                       JSON.stringify(newLog.data) +
                       newLog.prevHash;
      newLog.currentHash = sm3(hashInput);

      // 追加新日志
      logs.push(newLog);

      // 写回文件（主链）
      await fs.writeFile(LOG_FILE_PATH, JSON.stringify(logs, null, 2), 'utf8');

      // 双写 crypto_logs 表（source='chain'）：data 列存完整条目 JSON（含 index/timestamp/data，
      // 供 verifyChainFromDb 查库重算 SM3 复核）；DB 失败仅告警，不影响文件链与调用方
      try {
        await execute(
          `INSERT INTO crypto_logs (source, user_id, operation_type, description, data, prev_hash, current_hash)
           VALUES ('chain', ?, ?, ?, ?, ?, ?)`,
          [
            String(userId ?? ''),
            operationType,
            String(description ?? ''),
            JSON.stringify(newLog),
            newLog.prevHash || null,
            newLog.currentHash
          ]
        );
      } catch (dbError) {
        console.error('[cryptoLogger] crypto_logs DB 双写失败（文件链不受影响）:', dbError.message);
      }

      return id;
    } catch (error) {
      console.error('Error logging crypto operation:', error);
      throw error;
    }
  }
  
  async getLogs(options = {}) {
    const { limit = 50, offset = 0, userId } = options;
    
    try {
      // 读取日志文件
      let logs = [];
      try {
        const content = await fs.readFile(LOG_FILE_PATH, 'utf8');
        logs = JSON.parse(content);
      } catch (error) {
        // 文件不存在，返回空数组
        return { logs: [], total: 0 };
      }
      
      // 按用户筛选（兼容字符串和数字类型）
      if (userId) {
        logs = logs.filter(log => String(log.userId) === String(userId));
      }
      
      // 按时间倒序排序
      logs.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
      
      // 分页
      const total = logs.length;
      const paginatedLogs = logs.slice(offset, offset + limit);
      
      return {
        logs: paginatedLogs,
        total
      };
    } catch (error) {
      console.error('Error getting crypto logs:', error);
      return { logs: [], total: 0 };
    }
  }
  
  async getLogCount() {
    try {
      let logs = [];
      try {
        const content = await fs.readFile(LOG_FILE_PATH, 'utf8');
        logs = JSON.parse(content);
      } catch (error) {
        // 文件不存在，返回 0
        return 0;
      }
      
      return logs.length;
    } catch (error) {
      console.error('Error getting log count:', error);
      return 0;
    }
  }
  
  async verifyChain() {
    try {
      // 读取日志文件
      let logs = [];
      try {
        const content = await fs.readFile(LOG_FILE_PATH, 'utf8');
        logs = JSON.parse(content);
      } catch (error) {
        // 文件不存在，返回有效（空链）
        return { valid: true, totalEntries: 0, firstInvalidIndex: null };
      }
      
      // 验证链的完整性
      let prevHash = '';
      for (let i = 0; i < logs.length; i++) {
        const log = logs[i];
        
        // 检查索引是否正确
        if (log.index !== i + 1) {
          return { valid: false, totalEntries: logs.length, firstInvalidIndex: log.index };
        }
        
        // 检查 prevHash 是否正确
        if (log.prevHash !== prevHash) {
          return { valid: false, totalEntries: logs.length, firstInvalidIndex: log.index };
        }
        
        // 重新计算 currentHash
        const hashInput = log.index + 
                         log.timestamp + 
                         log.userId + 
                         log.operationType + 
                         log.description + 
                         JSON.stringify(log.data) + 
                         log.prevHash;
        const calculatedHash = sm3(hashInput);
        
        // 检查 currentHash 是否正确
        if (log.currentHash !== calculatedHash) {
          return { valid: false, totalEntries: logs.length, firstInvalidIndex: log.index };
        }
        
        prevHash = log.currentHash;
      }
      
      return { valid: true, totalEntries: logs.length, firstInvalidIndex: null };
    } catch (error) {
      console.error('Error verifying chain:', error);
      return { valid: false, totalEntries: 0, firstInvalidIndex: 1 };
    }
  }

  /**
   * 查库复核哈希链：读取 crypto_logs(source='chain') 按入库顺序逐条重算 SM3，
   * 校验 current_hash 列 = 重算值 = 条目自带 currentHash，且 prev_hash 与前一条 current_hash 连续。
   * 口径说明：
   *   - DB 是双写副本（阶段3 起才有），首条 DB 记录的 prev_hash 是文件主链当时的末哈希，作为锚点接受、不强制为空；
   *   - DB 写失败不阻断文件链，若曾失败，DB 链会出现断点 → valid=false 且 firstInvalidIndex 指向断点，
   *     此时以 verifyChain()（文件主链）为准排查。
   * 返回 { valid, totalEntries, firstInvalidIndex, reason? }，与 verifyChain 同形。
   */
  async verifyChainFromDb() {
    try {
      const rows = await execute(
        "SELECT id, data, prev_hash, current_hash FROM crypto_logs WHERE source = 'chain' ORDER BY id ASC"
      );
      let prevHash = null; // null = 尚无前驱（首条取锚点）
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const position = i + 1;
        let entry;
        try {
          entry = typeof row.data === 'string' ? JSON.parse(row.data) : row.data;
        } catch (e) {
          return { valid: false, totalEntries: rows.length, firstInvalidIndex: position, reason: 'data_json_invalid' };
        }
        if (!entry || typeof entry !== 'object') {
          return { valid: false, totalEntries: rows.length, firstInvalidIndex: position, reason: 'data_missing' };
        }

        const storedPrev = row.prev_hash || '';
        if (prevHash !== null && storedPrev !== prevHash) {
          return { valid: false, totalEntries: rows.length, firstInvalidIndex: position, reason: 'prev_hash_mismatch' };
        }
        if ((entry.prevHash || '') !== storedPrev) {
          return { valid: false, totalEntries: rows.length, firstInvalidIndex: position, reason: 'prev_hash_column_entry_mismatch' };
        }

        const hashInput = entry.index +
                          entry.timestamp +
                          entry.userId +
                          entry.operationType +
                          entry.description +
                          JSON.stringify(entry.data) +
                          (entry.prevHash || '');
        const calculatedHash = sm3(hashInput);
        if (calculatedHash !== row.current_hash || calculatedHash !== entry.currentHash) {
          return { valid: false, totalEntries: rows.length, firstInvalidIndex: position, reason: 'current_hash_mismatch' };
        }

        prevHash = row.current_hash;
      }

      return { valid: true, totalEntries: rows.length, firstInvalidIndex: null };
    } catch (error) {
      console.error('Error verifying chain from DB:', error);
      return { valid: false, totalEntries: 0, firstInvalidIndex: 1, reason: error.message };
    }
  }
}

module.exports = new CryptoLogger();