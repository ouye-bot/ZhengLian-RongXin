const SecurityLevel = {
  PUBLIC: 'public',
  AUTHENTICATED: 'authenticated',
  FINANCIAL: 'financial',
};

const endpoints = {
  // === PUBLIC ===
  'POST /api/v1/auth/login':            { level: 'public' },
  'POST /api/v1/auth/register':         { level: 'public' },
  'POST /api/v1/auth/refresh-token':    { level: 'public' },
  'GET /api/v1/health/detailed':        { level: 'public' },
  'POST /api/v1/health/csp-report':     { level: 'public' },
  'POST /api/v1/mfa/verify':            { level: 'public' },
  'GET /api/v1/mfa/setup':              { level: 'public' },
  'POST /api/v1/mfa/setup':             { level: 'public' },
  'POST /api/v1/mfa/reset':             { level: 'public' },
  'POST /api/v1/mfa/verify-and-enable': { level: 'public' },
  'GET /api/v1/public/*':               { level: 'public' },
  'GET /api-docs/*':                    { level: 'public' },
  'GET /health':                        { level: 'public' },
  'GET /api/v1/blockchain/public-key/:userId': { level: 'public' },
  'GET /api/v1/blockchain/public-key/:userId/history': { level: 'public' },
  // 阶段3：公开查询端点（与 securityChain.js PUBLIC_PATHS 同步；三 handler 均不读 req.user）
  'GET /api/v1/blockchain/records':     { level: 'public' },
  'GET /api/v1/blockchain/status':      { level: 'public' },
  'GET /api/v1/credit/verification-key': { level: 'public' },

  // === FINANCIAL ===
  'POST /api/v1/loan/borrow':           { level: 'financial' },
  // /apply 与 /borrow 挂同一 handler（routes/loan.js），登记后同样经过传输层 SM2 校验
  'POST /api/v1/loan/apply':            { level: 'financial' },
  'POST /api/v1/loan/repay':            { level: 'financial' },
  'POST /api/v1/loan/verify-transaction': { level: 'financial' },
  'POST /api/v1/invest':                { level: 'financial' },
  'POST /api/v1/redeem':                { level: 'financial' },
  'POST /api/v1/credit/generate-proof': { level: 'financial' },
  'POST /api/v1/zk/generate-proof':     { level: 'financial' },
  'POST /api/v1/risk/assess':           { level: 'financial' },

  // Risk Enhancement - Margin
  'POST /api/v1/margin/calculate':      { level: 'authenticated' },
  'GET /api/v1/margin/orders/:userId':  { level: 'authenticated' },
  'GET /api/v1/margin/orders/detail/:orderId': { level: 'authenticated' },

  // Risk Enhancement - Guarantee
  'GET /api/v1/guarantee/eligible-guarantors': { level: 'authenticated' },
  'POST /api/v1/guarantee/request':            { level: 'financial' },
  'POST /api/v1/guarantee/accept/:requestId':  { level: 'financial' },
  'POST /api/v1/guarantee/reject/:requestId':  { level: 'authenticated' },
  'GET /api/v1/guarantee/pending-requests':    { level: 'authenticated' },
  'GET /api/v1/guarantee/contract/:contractId': { level: 'authenticated' },

  // Risk Enhancement - Notifications
  'GET /api/v1/notifications/unread-count': { level: 'authenticated' },
  'GET /api/v1/notifications':              { level: 'authenticated' },
  'PUT /api/v1/notifications/:id/read':    { level: 'authenticated' },
  'PUT /api/v1/notifications/read-all':    { level: 'authenticated' },
};

function getSecurityLevel(method, path) {
  const exactKey = `${method} ${path}`;
  if (endpoints[exactKey]) return endpoints[exactKey].level;

  for (const [pattern, config] of Object.entries(endpoints)) {
    const [patternMethod, patternPath] = pattern.split(' ');
    if (patternMethod !== method) continue;
    if (matchPath(patternPath, path)) return config.level;
  }

  return 'authenticated';
}

function matchPath(pattern, path) {
  const patternParts = pattern.split('/');
  const pathParts = path.split('/');
  if (patternParts.length !== pathParts.length) return false;
  return patternParts.every((part, i) =>
    part.startsWith(':') || part === '*' || part === pathParts[i]
  );
}

module.exports = { SecurityLevel, endpoints, getSecurityLevel };