const express = require('express');
const jwt = require('jsonwebtoken');
const { execute } = require('../config/database');
const { antiReplayMiddleware } = require('./antiReplayMiddleware');
const { authPermissionMiddleware } = require('./authPermissionMiddleware');
const { anomalyDetectionMiddleware } = require('./anomalyDetection');
const sm2SignatureMiddleware = require('./sm2SignatureMiddleware');
const logger = require('../utils/logger');

const blacklistCache = new Map();

// 已通过拉黑校验的有效 token 二级缓存：jti -> { exp(ms), cachedAt(ms) }
// 命中且未超 VALID_TOKEN_CACHE_TTL_MS 且 token 未过期 → 免 token_blacklist DB 查询直接放行；
// 未命中走 isTokenBlacklisted，确认未拉黑后写入。
// 失效：addToBlacklist（登出/拉黑的唯一写入口，app.js /auth/logout 调用）同步 delete → 本进程即时失效。
// 诚实口径：这是进程内缓存，若以 PM2 多实例运行，其他进程对同一 jti 的失效窗口最长 = TTL（5 分钟）；
// 当前运维模式为单进程 3003，不存在跨实例窗口。
const validTokens = new Map();
const VALID_TOKEN_CACHE_TTL_MS = 5 * 60 * 1000;

// 双缓存黑名单查询，减少DB压力
const isTokenBlacklisted = async (jti, expiresAt) => {
  const now = Date.now();

  if (blacklistCache.has(jti)) {
    const cachedExpiresAt = blacklistCache.get(jti);
    if (now < cachedExpiresAt) {
      return true;
    }
    blacklistCache.delete(jti);
    return false;
  }

  try {
    const results = await execute(
      'SELECT expires_at FROM token_blacklist WHERE jti = ? AND expires_at > ?',
      [jti, now]
    );

    if (results.length > 0) {
      blacklistCache.set(jti, results[0].expires_at);
      return true;
    }
    return false;
  } catch (dbError) {
    if (blacklistCache.has(jti)) {
      logger.warning('Blacklist DB failed, token found in cache', { jti });
      return true;
    }
    logger.error('CRITICAL: Blacklist database query failed and token not in cache', { error: dbError.message, jti });
    return false;
  }
};

const addToBlacklist = (jti, expiresAt) => {
  blacklistCache.set(jti, expiresAt);
  // 登出/拉黑即时失效：清掉有效 token 缓存，下一次请求必走拉黑查询
  validTokens.delete(jti);
};

// ======================================================================
// 公开路径白名单（真实放行）
// ======================================================================
// 依据：Express 4 中在 app.use 挂载层调用 next('route') 等价于 next()
// （'route' 只能跳出同一路由栈内的同名路由句柄，app.use 层没有可跳出的
// "route"，会继续落入下一个 app.use）。因此旧实现"白名单命中 → 伪造
// req.user → next('route')"从未真正放行任何路径：伪造的 req.user 会被
// 紧随其后的 JWT 中间件以真实解码结果覆盖，无 token 请求则被 401 拦截。
// 真正的公开路径必须重构网关：命中白名单的请求不进入受保护链。
const PUBLIC_PATHS = [
  '/api/v1/auth/register',
  '/api/v1/auth/login',
  '/health',
  '/favicon.ico',
  // 第三方信用证明核验：handler 不读取 req.user（routes/credit.js POST /verify-proof），
  // endpointRegistry 未登记为 financial，无 SM2 验签诉求
  '/api/v1/credit/verify-proof',
  // 阶段3：公开查询端点（第三方独立验证链路）——三个 handler 均不读 req.user：
  //   blockchain/records、blockchain/status（routes/blockchain.js，仅 requireBlockchain 服务可用性检查）
  //   credit/verification-key（routes/credit.js GET，ZKP 公开验证密钥，论文 4.3.3 第三方独立验证）
  // endpointRegistry.js 已同步登记为 public（纵深一致）
  '/api/v1/blockchain/records',
  '/api/v1/blockchain/status',
  '/api/v1/credit/verification-key',
];

// 链上公钥查询（第三方可调用，endpointRegistry.js 已登记为 public）。
// 用 \d+ 段精确匹配，天然排除同前缀的写操作 POST /public-key/revoke（需管理员 JWT）。
const PUBLIC_KEY_PATH_RE = /^\/api\/v1\/blockchain\/public-key\/\d+$/;
const PUBLIC_KEY_HISTORY_PATH_RE = /^\/api\/v1\/blockchain\/public-key\/\d+\/history$/;

const isPublicPath = (req) =>
  PUBLIC_PATHS.includes(req.path) ||
  req.path.startsWith('/api-docs') ||
  PUBLIC_KEY_PATH_RE.test(req.path) ||
  PUBLIC_KEY_HISTORY_PATH_RE.test(req.path);

// ======================================================================
// 1. JWT 解析与黑名单校验中间件（受纵深网关强保护的端点 FINANCIAL）
// ======================================================================
const jwtAuthMiddleware = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.split(' ')[1];
    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);

      if (decoded.jti && decoded.exp) {
        const expiresAt = decoded.exp * 1000;
        const now = Date.now();

        // 二级缓存命中（<5min 且未过期）→ 免 DB 拉黑查询
        const cached = validTokens.get(decoded.jti);
        const cacheHit = !!cached && (now - cached.cachedAt) < VALID_TOKEN_CACHE_TTL_MS && now < cached.exp;

        if (!cacheHit) {
          const isBlacklisted = await isTokenBlacklisted(decoded.jti, expiresAt);

          if (isBlacklisted) {
            logger.warning('JWT Token is blacklisted', { jti: decoded.jti });
            return res.status(401).json({ success: false, message: 'Token 已被撤销' });
          }

          validTokens.set(decoded.jti, { exp: expiresAt, cachedAt: now });
        }
      }

      req.user = decoded;
      logger.debug('JWT User parsed', { userId: req.user?.id });
    } catch(err) {
      logger.debug('JWT Token invalid', { error: err.message });
      return res.status(401).json({ success: false, message: '无效的认证令牌' });
    }
  } else {
    return res.status(401).json({ success: false, message: '缺少认证令牌' });
  }
  next();
};

// ======================================================================
// 受保护链：五层中间件，与重构前 app.use 注册顺序完全一致
// ======================================================================
const protectedChain = express.Router();
protectedChain.use(jwtAuthMiddleware);
protectedChain.use(anomalyDetectionMiddleware);
protectedChain.use(sm2SignatureMiddleware);
protectedChain.use(antiReplayMiddleware);
protectedChain.use(authPermissionMiddleware);

const setupSecurityChain = (app) => {
  // 统一网关：公开请求真实跳过整条安全链，其余请求进入受保护链
  app.use((req, res, next) => {
    logger.debug('SecurityChain incoming request', { path: req.path, method: req.method });

    if (isPublicPath(req)) {
      // 真实跳过 JWT / 异常检测 / SM2 验签 / 防重放 / RBAC 五层
      return next();
    }

    // 压测上下文标记：仅在显式开关 ALLOW_TEST_BYPASS=ON 时置位，
    // 供限流豁免（app.js generalLimiter.skip）识别；不伪造 req.user、
    // 不跳过安全链——请求仍须通过认证/签名/防重放全部检查。
    if (process.env.ALLOW_TEST_BYPASS === 'ON' && req.headers['x-test-mode'] === 'benchmark') {
      req.testBypass = true;
    }

    protectedChain(req, res, next);
  });
};

// 内存与数据库过期黑名单常驻清理任务
const blacklistCleanupInterval = setInterval(async () => {
  const now = Date.now();

  for (const [jti, expiresAt] of blacklistCache.entries()) {
    if (now > expiresAt) {
      blacklistCache.delete(jti);
    }
  }

  // 顺带清理有效 token 缓存中已过期或超 TTL 的条目（防止 Map 随登录量无界增长）
  for (const [jti, entry] of validTokens.entries()) {
    if (now >= entry.exp || (now - entry.cachedAt) >= VALID_TOKEN_CACHE_TTL_MS) {
      validTokens.delete(jti);
    }
  }

  if (Math.floor(Date.now() / 600000) % 1 === 0) {
    try {
      const result = await execute(
        'DELETE FROM token_blacklist WHERE expires_at < ?',
        [now]
      );
      if (result.affectedRows > 0) {
        logger.debug('Cleaned up expired blacklist entries', { count: result.affectedRows });
      }
    } catch (dbError) {
      logger.warning('Failed to clean up blacklist', { error: dbError.message });
    }
  }
}, 60000);
blacklistCleanupInterval.unref();

module.exports = {
  setupSecurityChain,
  addToBlacklist
};
