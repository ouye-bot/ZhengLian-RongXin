const crypto = require('crypto');
const logger = require('./logger');

const BLACKLISTED_KEYS = new Set([
  '00112233445566778899aabbccddeeff',
  '00000000000000000000000000000000',
  'ffffffffffffffffffffffffffffffff',
  '1234567890abcdef1234567890abcdef',
  'abcdef1234567890abcdef1234567890'
]);

// 知名测试私钥的 0x+8位hex 前缀：Hardhat 默认账户（0xac0974be/0x59c6995e/0x359d3c2b）、
// geth 文档知名测试钥及 FISCO BCOS 示例所用变体（0x4c0883a6）。
// 用前缀匹配代替全值匹配，可一并拦截同源的变体私钥。
const KNOWN_TEST_PRIVATE_KEY_PREFIXES = ['0xac0974be', '0x59c6995e', '0x359d3c2b', '0x4c0883a6'];

let keyCache = {};
const keyAccessAuditLog = [];
let sm4KeyFirstAccess = false;

function validateKeys() {
  const errors = [];

  const sm4Key = process.env.SM4_MASTER_KEY;
  if (!sm4Key) {
    errors.push('SM4_MASTER_KEY 未配置');
  } else {
    if (!/^[0-9a-fA-F]{32}$/.test(sm4Key)) {
      errors.push('SM4_MASTER_KEY 必须是32位十六进制字符串');
    }
    if (BLACKLISTED_KEYS.has(sm4Key.toLowerCase())) {
      errors.push('SM4_MASTER_KEY 为黑名单测试值，禁止使用');
    }
  }

  const jwtSecret = process.env.JWT_SECRET;
  if (!jwtSecret) {
    errors.push('JWT_SECRET 未配置');
  } else {
    if (jwtSecret.length < 32) {
      errors.push('JWT_SECRET 长度至少需要32个字符');
    }
    if (jwtSecret === 'your-secret-key' || jwtSecret === 'your-jwt-secret-key-here') {
      errors.push('JWT_SECRET 为默认弱值，禁止使用');
    }
  }

  const hardhatKey = process.env.HARDHAT_PRIVATE_KEY;
  if (hardhatKey) {
    if (!/^0x[0-9a-fA-F]{64}$/.test(hardhatKey)) {
      errors.push('HARDHAT_PRIVATE_KEY 必须是64位十六进制字符串前缀0x');
    }
    const lowerKey = hardhatKey.toLowerCase();
    if (KNOWN_TEST_PRIVATE_KEY_PREFIXES.some((prefix) => lowerKey.startsWith(prefix))) {
      errors.push('HARDHAT_PRIVATE_KEY 为知名测试私钥，禁止使用');
    }
  }

  const sessionSecret = process.env.SESSION_SECRET;
  if (!sessionSecret) {
    errors.push('SESSION_SECRET 未配置');
  } else {
    if (sessionSecret.length < 32) {
      errors.push('SESSION_SECRET 长度至少需要32个字符');
    }
    if (sessionSecret === 'your-secret-key') {
      errors.push('SESSION_SECRET 为默认弱值，禁止使用');
    }
  }

  // 校验 JWT_REFRESH_SECRET
  const jwtRefreshSecret = process.env.JWT_REFRESH_SECRET;
  if (!jwtRefreshSecret) {
    errors.push('JWT_REFRESH_SECRET 未配置');
  } else {
    if (jwtRefreshSecret.length < 32) {
      errors.push('JWT_REFRESH_SECRET 长度至少需要32个字符');
    }
    if (jwtRefreshSecret === jwtSecret) {
      errors.push('JWT_REFRESH_SECRET 不能等于 JWT_SECRET');
    }
  }

  // 校验 DB_PASSWORD
  const dbPassword = process.env.DB_PASSWORD;
  if (dbPassword === '123456') {
    errors.push('DB_PASSWORD 不能使用默认弱密码 123456');
  }

  if (errors.length > 0) {
    const errMsg = '密钥校验失败：' + errors.join('; ');
    logger.error(errMsg);
    throw new Error(errMsg);
  }

  logger.info('密钥校验通过');
  return true;
}

function getKey(keyName) {
  const now = new Date().toISOString();
  const auditEntry = { timestamp: now, keyName };
  
  if (keyName === 'SM4_MASTER_KEY' && sm4KeyFirstAccess) {
  } else {
    keyAccessAuditLog.push(auditEntry);
  }

  if (keyCache[keyName]) {
    return keyCache[keyName];
  }

  const value = process.env[keyName];
  if (value) {
    keyCache[keyName] = value;
    if (keyName === 'SM4_MASTER_KEY') {
      sm4KeyFirstAccess = true;
      logger.info('SM4_MASTER_KEY 已加载并缓存');
    }
  }
  return value || null;
}

function getAccessAuditLog(limit = 100) {
  const count = Math.min(limit, keyAccessAuditLog.length);
  return keyAccessAuditLog.slice(-count);
}

function generateRandomHex(length) {
  return crypto.randomBytes(Math.ceil(length / 2)).toString('hex').slice(0, length);
}

function hashKey(keyHex) {
  return crypto.createHash('sha256').update(keyHex, 'hex').digest('hex');
}

module.exports = {
  validateKeys,
  getKey,
  getAccessAuditLog,
  generateRandomHex,
  hashKey,
  BLACKLISTED_KEYS
};
