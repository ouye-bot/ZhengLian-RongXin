/**
 * 阶段6 全链路验收 e2e（full-loop-e2e.js）
 * ---------------------------------------------------------------
 * 与 finance-e2e.js 的关系：工具函数（financialHeaders/post/openDB/getPool/
 * checkInvariants/loanCalcInterest/poolCalcInterest/marginRateOf/fixture/
 * makeProof）自包含复制自 backend/test/finance-e2e.js——有意复制，避免改动
 * 已绿套件；两脚本头部注释互为同源声明。逻辑口径与 finance-e2e.js 一致处
 * 均标注其行号出处（行号为阶段6会话实读，后续漂移按内容定位）。
 *
 * 场景序列（S0-S16）：
 *   S0  环境预检（/health、DB、初始池恒等式、链 isConnected+totalRecords 基线）
 *   S1  注册 A/B（e2e_full_<ts> 前缀）+ 各登录 1 次（命中 429 等 61s 重试一次）
 *   S2  夹具 balance=5000 / credit_score=700 / created_at 拨回 30 天（绕开冷静期）
 *   S3  信用证明：zkService.generateProof(700,600,1) → POST /credit/generate-proof
 *       （签名原文 credit.js:139 JSON.stringify({userId:String(id),creditScore})）
 *       → proofId/verificationCode、publicSignals=['1','600']
 *   S4  阈值篡改三连拒：(a) 恶意低阈值 500 证明 (b) 合法证明篡改 publicSignals[1]
 *       (c) 真实分 500<阈值 600 → isValid=0（zkService.js isValid 分支）
 *       → 均 400 '零知识证明验证失败'；credit_proofs 表 count 不增
 *   S5  担保邀约 /guarantee/request + 担保人 /guarantee/accept/:id
 *   S6  担保借款 1000/30d risk_mode=2：total_amount=P+I(85折)+F、合约 ACTIVE、
 *       fee_collected=0/released_amount=0、B frozen+1000、LA+1000、恒等式
 *   S7  押金借款 1000/30d risk_mode=1：低押金 400 '押金金额不足' 负例 →
 *       正常借款 FROZEN/margin_rate/A 余额净变/恒等式
 *   S8  纯信用借款 500/30d risk_mode=0：LA+500（活跃并发 2500 < 动态限额）
 *   S9  部分还款 300（担保贷）：released_amount 增量释放、fee_collected 仍 0、
 *       LA−已还本金、A 扣 300（finance-e2e.js:413-451 口径）
 *   S10 全额还款（担保贷）【担保费代扣核心断言】：借款人 Δ=−(P2+I2+F)+0.1F、
 *       B Δbal=0.7F+loyalty+剩余解冻/Δfrozen=−剩余、PC Δ=(P2+I2)×platformRatio+
 *       (0.2F−loyalty)、合约 COMPLETED+fee_collected=1（finance-e2e.js:453-500；
 *       loan.js:792-793 注释：借款人扣 P+I+F、担保费入池、poolService.repay 原子回写）
 *   S11 押金贷全额还款（订单 created_at 拨回制造冻结期利息）→ RELEASED+
 *       frozen_interest、PC 支付冻结期利息（finance-e2e.js:552-587 口径）
 *   S12 改库制造逾期：due_date=NOW()-1DAY → 直调 overdueService.checkOverdueLoans()
 *       → status='overdue'；负例：此刻 A 生成证明 400 '您当前有逾期借款记录'
 *       （credit.js:164-170）
 *   S13 罚息还款 → completed、扣款=P+约定利息+罚息（finance-e2e.js:591-635 口径）
 *   S14 B 出资 /invest 1000/30d → UC+1000；B 赎回 /redeem 100 → UC−(100+实付利息)、
 *       UIE 扣减、B 余额+（finance-e2e.js:748-814 口径）
 *   S15 区块链浏览器：GET /blockchain/status（public，securityChain.js:83）→
 *       isConnected/contracts/totalRecords；GET /blockchain/explorer?limit=3
 *       （需 JWT A；GET 免 SM2/防重放：sm2SignatureMiddleware.js:9-11、
 *       antiReplayMiddleware.js:48-50）→ totalRecords/recentRecords/typeStats 结构；
 *       链不可用/零值 → 降级注明不失败（blockchainServiceFisco getExplorerData
 *       按设计返回零值而非 5xx）；软检轮询 totalRecords ≥ S0 值+1（S3 异步上链）
 *   S16 终态恒等式 + 汇总
 *
 * 运行模式（同 finance-e2e.js）：
 *   GREEN：任何断言失败 → 收集失败 → 写 backend/test/results/full-loop-red.txt → 退出码 1。
 *   测试基建失败（/health、DB、初始恒等式）立即退出码 1，不写清单文件。
 *   每个资金步骤后校验资金池恒等式：total==PC+UC；available==total−LA；分量 ≥ −0.005。
 *
 * 运行：node backend/test/full-loop-e2e.js
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const axios = require('axios');
const mysql = require('mysql2/promise');
const sm2 = require('sm-crypto').sm2;

const { canonicalStringify, signWithSM2, buildSignatureData } = require('../utils/cryptoUtils');
const { encryptFields } = require('../utils/sm4Crypto');
const zkService = require('../services/zkService');
const dynamicConfig = require('../services/dynamicConfigService');
const { getCurrentLendingRate } = require('../services/interestRateService');
const { getInterestRate: getBaseInterestRate } = require('../utils/interestRate');
const guaranteeEngine = require('../services/riskPlugins/guaranteeEngine');

const BASE = 'http://127.0.0.1:3003';
const API = `${BASE}/api/v1`;
const RED_LIST_PATH = path.resolve(__dirname, 'results/full-loop-red.txt');

// ───────────────── 工具（自包含复制自 finance-e2e.js:55-129） ─────────────────
const round2 = (x) => Math.round(x * 100) / 100;

function fail(msg) { throw new Error(`断言失败：${msg}`); }
function assert(cond, msg) { if (!cond) fail(msg); }
function assertNear(actual, expected, tolerance, msg) {
  if (Math.abs(Number(actual) - Number(expected)) > tolerance) {
    fail(`${msg}：actual=${actual}，expected=${expected}，diff=${round2(Number(actual) - Number(expected))}，tol=${tolerance}`);
  }
}

/** 与 routes/loan.js calculateInterest 完全一致的复本（finance-e2e.js:73-89） */
function loanCalcInterest(principal, days, creditScore, isOverdue = false, overdueDays = 0) {
  const rates = { 750: 4.0, 700: 6.0, 650: 8.0, 600: 10.0, 300: 13.8 };
  const scores = Object.keys(rates).map(Number).sort((a, b) => b - a);
  let annual = 13.8;
  for (const s of scores) { if (creditScore >= s) { annual = rates[s]; break; } }
  const baseAnnualRate = annual / 100;
  const dailyRate = baseAnnualRate / 365;
  let rate;
  if (isOverdue && overdueDays > 0) {
    rate = dailyRate * dynamicConfig.getOverduePenaltyRate(overdueDays);
  } else if (isOverdue) {
    rate = dailyRate * 1.5;
  } else {
    rate = dailyRate;
  }
  return round2(principal * rate * days);
}

/** 与 services/poolService.js calculateInterest 一致的复本，含担保 85 折（finance-e2e.js:92-101） */
function poolCalcInterest(principal, days, creditScore, riskMode = 0) {
  const rates = { 750: 4.0, 700: 6.0, 650: 8.0, 600: 10.0, 300: 13.8 };
  const scores = Object.keys(rates).map(Number).sort((a, b) => b - a);
  let annual = 13.8;
  for (const s of scores) { if (creditScore >= s) { annual = rates[s]; break; } }
  const baseAnnualRate = annual / 100;
  const guaranteeDiscount = riskMode === 2 ? 0.85 : 1.0;
  const dailyRate = (baseAnnualRate * guaranteeDiscount) / 365;
  return round2(principal * dailyRate * days);
}

/** 与 services/riskPlugins/marginEngine.js calculateMarginRate 一致的复本（finance-e2e.js:104-113） */
function marginRateOf(creditScore, term) {
  let rate = parseFloat(process.env.MARGIN_BASE_RATE) || 0.20;
  if (term >= 90) rate += 0.05;
  else if (term >= 30) rate += 0.03;
  if (creditScore >= 800) rate -= 0.05;
  else if (creditScore >= 700) rate -= 0.03;
  const min = parseFloat(process.env.MARGIN_MIN_RATE) || 0.15;
  const max = parseFloat(process.env.MARGIN_MAX_RATE) || 0.25;
  return Math.min(max, Math.max(min, rate));
}

const daysBetween = (from, to) => Math.max(1, Math.ceil((to - from) / 86400000));

// ───────────────── 场景收集器（同 finance-e2e.js:118-145） ─────────────────
const failures = [];
const passed = [];
async function runScenario(name, fn) {
  console.log(`\n== ${name}`);
  try {
    await fn();
    passed.push(name);
    console.log(`  ✅ ${name} —— 通过`);
  } catch (e) {
    const message = (e && e.message) || String(e);
    failures.push({ name, message });
    console.error(`  ❌ [FAIL] ${name}\n     ${message}`);
  }
}

function writeFailuresFile() {
  try {
    const lines = [
      '阶段6 full-loop-e2e 失败清单（RED 证据）',
      `运行时间：${new Date().toISOString()}`,
      `失败场景数：${failures.length}`,
      '',
      ...failures.map((f, i) => `${i + 1}. ${f.name}\n   └─ ${f.message}`),
    ];
    fs.writeFileSync(RED_LIST_PATH, lines.join('\n') + '\n', 'utf8');
    console.error(`\n失败清单已写入：${RED_LIST_PATH}`);
  } catch (e) {
    console.error(`\n[WARN] 失败清单写入失败：${e.message}`);
  }
}

// ───────────────── HTTP 封装（同 finance-e2e.js:148-178） ─────────────────
function financialHeaders(user, body) {
  const timestamp = String(Date.now());
  // 签名中间件要求 nonce 长度 ≥ 32 字符（16 字节 hex）
  const nonce = crypto.randomBytes(16).toString('hex');
  const signature = signWithSM2(timestamp + nonce + canonicalStringify(body), user.privKey);
  return {
    'x-user-id': String(user.id),
    'x-request-timestamp': timestamp,
    'x-request-nonce': nonce,
    'x-sm2-signature': signature
  };
}

async function post(user, urlPath, body, expectStatus = 200) {
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${user.jwt}`, ...financialHeaders(user, body) };
  let resp;
  try {
    resp = await axios.post(`${API}${urlPath}`, body, { headers, validateStatus: () => true, timeout: 30000 });
  } catch (err) {
    fail(`POST ${urlPath} 网络异常：${err.message}`);
  }
  if (expectStatus !== null && resp.status !== expectStatus) {
    const err = new Error(`POST ${urlPath} 期望 ${expectStatus} 实得 ${resp.status}：${JSON.stringify(resp.data).slice(0, 400)}`);
    err.response = { status: resp.status, data: resp.data };
    err.status = resp.status;
    throw err;
  }
  return resp.data;
}

/** GET 封装：S15 浏览器用。GET 免 SM2 验签/防重放（sm2SignatureMiddleware.js:9-11、antiReplayMiddleware.js:48-50），仅需 JWT */
async function get(user, urlPath, expectStatus = 200) {
  const headers = user ? { Authorization: `Bearer ${user.jwt}` } : {};
  let resp;
  try {
    resp = await axios.get(`${API}${urlPath}`, { headers, validateStatus: () => true, timeout: 30000 });
  } catch (err) {
    fail(`GET ${urlPath} 网络异常：${err.message}`);
  }
  if (expectStatus !== null && resp.status !== expectStatus) {
    const err = new Error(`GET ${urlPath} 期望 ${expectStatus} 实得 ${resp.status}：${JSON.stringify(resp.data).slice(0, 400)}`);
    err.response = { status: resp.status, data: resp.data };
    err.status = resp.status;
    throw err;
  }
  return resp.data;
}

// ───────────────── 数据读取（同 finance-e2e.js:181-238） ─────────────────
let db;
async function openDB() {
  db = await mysql.createConnection({
    host: '127.0.0.1',
    port: 3307,
    user: process.env.DB_USER || 'finzktrust',
    password: process.env.DB_PASSWORD || process.env.DB_PASS,
    database: process.env.DB_NAME || 'finzktrust'
  });
}

async function getPool() {
  const [rows] = await db.query('SELECT * FROM fund_pool WHERE id = 1');
  const p = rows[0];
  return {
    PC: parseFloat(p.platform_capital),
    UC: parseFloat(p.user_capital),
    LA: parseFloat(p.loaned_amount),
    total: parseFloat(p.total_amount),
    available: parseFloat(p.available_amount),
    TIE: parseFloat(p.total_interest_earned),
    UIE: parseFloat(p.user_interest_earned)
  };
}

async function checkInvariants(tag) {
  const p = await getPool();
  const d1 = p.total - (p.PC + p.UC);
  const d2 = p.available - (p.total - p.LA);
  console.log(`  [池·${tag}] PC=${p.PC} UC=${p.UC} LA=${p.LA} total=${p.total} avail=${p.available} UIE=${p.UIE} | Δ1=${round2(d1)} Δ2=${round2(d2)}`);
  if (Math.abs(d1) >= 0.01) fail(`恒等式1违反（${tag}）：|total−(PC+UC)|=${Math.abs(d1)} ≥ 0.01`);
  if (Math.abs(d2) >= 0.01) fail(`恒等式2违反（${tag}）：|available−(total−LA)|=${Math.abs(d2)} ≥ 0.01`);
  for (const [k, v] of Object.entries({ PC: p.PC, UC: p.UC, LA: p.LA, available: p.available })) {
    if (v < -0.005) fail(`资金池字段为负（${tag}）：${k}=${v}`);
  }
  return p;
}

async function getUser(userId) {
  // 通过后端 DAO（全局池）读取解密后的用户
  const userDao = require('../dao/userDao');
  return userDao.findById(String(userId));
}

async function getContract(id) {
  const [rows] = await db.query('SELECT * FROM risk_guarantee_contracts WHERE id = ?', [id]);
  return rows[0] || null;
}

async function getMarginOrder(id) {
  const [rows] = await db.query('SELECT * FROM risk_margin_orders WHERE id = ?', [id]);
  return rows[0] || null;
}

async function getTxStatus(id) {
  const [rows] = await db.query('SELECT status FROM transactions WHERE id = ?', [id]);
  return rows[0] ? rows[0].status : null;
}

async function getChainStatus() {
  const resp = await axios.get(`${API}/blockchain/status`, { validateStatus: () => true, timeout: 15000 });
  return resp.data && resp.data.data ? resp.data.data : null;
}

// ═══════════════ 主流程 ═══════════════
(async () => {
  const t0 = Date.now();

  // ── S0 环境预检 ──
  await runScenario('S0 环境预检：/health、DB、初始池恒等式、链状态基线', async () => {
    try {
      const health = await axios.get(`${BASE}/health`, { timeout: 5000 });
      assert(health.data && health.data.status === 'ok', `后端健康检查异常：${JSON.stringify(health.data)}`);
      console.log('  后端在线 /health ok');
    } catch (e) {
      fail(`后端不在线（${BASE}）：${e.message}`);
    }
    await openDB();
    await db.query('SELECT 1');
    console.log('  数据库可达 127.0.0.1:3307/finzktrust');

    const initialPool = await getPool();
    console.log(`  初始池：PC=${initialPool.PC} UC=${initialPool.UC} LA=${initialPool.LA}`);
    const d1 = initialPool.total - (initialPool.PC + initialPool.UC);
    const d2 = initialPool.available - (initialPool.total - initialPool.LA);
    assert(Math.abs(d1) < 0.01 && Math.abs(d2) < 0.01, `初始池恒等式已破坏：Δ1=${round2(d1)} Δ2=${round2(d2)}（需先修复基线再跑 e2e）`);

    const chain = await getChainStatus();
    assert(chain && typeof chain.isConnected === 'boolean', `链状态响应异常：${JSON.stringify(chain).slice(0, 200)}`);
    global.chainTotal0 = Number(chain.totalRecords) || 0;
    console.log(`  链 isConnected=${chain.isConnected} totalRecords 基线=${global.chainTotal0} 合约=${JSON.stringify(chain.contracts)}`);
  });
  if (!db) {
    // S0 失败 = 测试基建不可用，立即终止且不写清单（同 finance-e2e.js:244-261 口径）
    console.error('\n[FATAL] S0 预检失败，测试基建不可用，终止（非契约红）');
    process.exit(1);
  }

  // ── S1 注册 / 登录 ──
  console.log(`\n== S1 注册并登录两个用户（借款人A / 担保人B，e2e_full_ 前缀）`);
  const ts = Date.now();
  const kpA = sm2.generateKeyPairHex();
  const kpB = sm2.generateKeyPairHex();
  const mk = (n) => `e2e_full_${n}_${ts}`;
  const password = 'E2eFullP0rd';

  async function register(user, username, pubKey) {
    const resp = await axios.post(`${API}/auth/register`, { username, password, sm2PublicKey: pubKey }, { validateStatus: () => true, timeout: 15000 });
    if (resp.status !== 200 || !resp.data.success) fail(`注册 ${username} 失败：${resp.status} ${JSON.stringify(resp.data).slice(0, 200)}`);
    return resp.data.user.id;
  }
  const aId = await register('A', mk('a'), kpA.publicKey);
  const bId = await register('B', mk('b'), kpB.publicKey);
  const userA = { id: aId, privKey: kpA.privateKey, pubKey: kpA.publicKey };
  const userB = { id: bId, privKey: kpB.privateKey, pubKey: kpB.publicKey };

  async function login(user, username) {
    const doLogin = () => axios.post(`${API}/auth/login`, { username, password }, { validateStatus: () => true, timeout: 15000 });
    let resp = await doLogin();
    if (resp.status === 429) {
      // loginLimiter 5次/分/IP（app.js:100-110/155）；全程仅 2 次登录≪限值，此为共存环境的兜底
      console.log('  登录命中 429（IP 限流），等待 61s 后重试一次');
      await new Promise((r) => setTimeout(r, 61000));
      resp = await doLogin();
    }
    if (resp.status !== 200 || !resp.data.success || !resp.data.token) fail(`登录 ${username} 失败：${resp.status} ${JSON.stringify(resp.data).slice(0, 200)}`);
    user.jwt = resp.data.token;
  }
  await login(userA, mk('a'));
  await login(userB, mk('b'));
  console.log(`  S1 通过：A#${aId} B#${bId} 注册登录成功`);

  // ── S2 夹具 ──
  console.log(`\n== S2 夹具：A/B 设 credit_score=700、balance=5000（sm4Crypto 加密写库，同 finance-e2e.js:292-307）`);
  async function fixture(user, balance, credit) {
    const data = { balance, credit_score: credit };
    await encryptFields('users', data, user.id, db);
    await db.execute('UPDATE users SET balance = ?, credit_score = ? WHERE id = ?', [data.balance, data.credit_score, user.id]);
    const u = await getUser(user.id);
    assertNear(u.balance, balance, 0.001, `夹具写入后余额不符`);
    assertNear(Number(u.credit_score), credit, 0.001, `夹具写入后信用分不符`);
  }
  await fixture(userA, 5000, 700);
  await fixture(userB, 5000, 700);
  // created_at 拨回 30 天：绕开动态冷静期（与被测资金契约无关的产品规则，同 finance-e2e.js:302-307）
  await db.execute('UPDATE users SET created_at = NOW() - INTERVAL 30 DAY WHERE id IN (?, ?)', [aId, bId]);
  console.log('  S2 通过：A/B 余额 5000、信用分 700 解密回读一致；created_at 已拨回 30 天');

  // ── S3 信用证明 ──
  console.log(`\n== S3 信用证明生成（阈值 600=借款准入强核值，credit.js:61）`);
  // 业务级 SM2 签名原文用 DB 实时信用分（credit.js:139 JSON.stringify({userId:String(id),creditScore:user.credit_score||0})）。
  // 信用分是动态的（还款 +10 等），必须回读 DB 构造，硬编码夹具值会在首次还款后全部失配（首跑实测教训）。
  async function creditProofSig(user) {
    const u = await getUser(user.id);
    const score = Number(u.credit_score) || 0;
    return signWithSM2(JSON.stringify({ userId: String(user.id), creditScore: score }), user.privKey);
  }
  async function makeProof(user) {
    // 同 finance-e2e.js:311-324：阈值 600 服务端强核（credit.js PROOF_REQUIRED_THRESHOLD）
    const zk = await zkService.generateProof(700, 600, 1);
    const bizSig = await creditProofSig(user);
    const body = { userId: user.id, proof: zk.proof, publicSignals: zk.publicSignals, signature: bizSig };
    const data = await post(user, '/credit/generate-proof', body);
    const p = (data.data && data.data.proof) ? data.data.proof : data;
    assert(data.success && p.proofId && p.verificationCode, `信用证明生成失败：${JSON.stringify(data).slice(0, 300)}`);
    return { id: p.proofId, verificationCode: p.verificationCode, proof: zk.proof, publicSignals: zk.publicSignals };
  }
  await runScenario('S3 端侧 ZKP + 服务端验证存证（proofId/verificationCode/publicSignals）', async () => {
    const zkA = await zkService.generateProof(700, 600, 1);
    assert(JSON.stringify(zkA.publicSignals) === JSON.stringify(['1', '600']),
      `publicSignals 应为 ['1','600']（isValid 输出在前、threshold 公共输入在后），实为 ${JSON.stringify(zkA.publicSignals)}`);
    global.proofA = await makeProof(userA);
    global.proofB = await makeProof(userB);
    console.log(`  proofA=${global.proofA.id.slice(0, 26)}... proofB=${global.proofB.id.slice(0, 26)}... publicSignals=${JSON.stringify(zkA.publicSignals)}`);
  });

  // 签名口径封装（同 finance-e2e.js:326-333）
  const borrowSig = (user, amount, proof) => signWithSM2(
    buildSignatureData({ userId: String(user.id), amount: parseInt(amount), creditProofId: proof.id }, ['amount', 'creditProofId', 'userId']),
    user.privKey
  );
  const repaySig = (user, txId, proof) => signWithSM2(
    buildSignatureData({ userId: String(user.id), transactionId: txId, creditProofId: proof.id }, ['creditProofId', 'transactionId', 'userId']),
    user.privKey
  );
  const proofA = () => global.proofA;
  const proofB = () => global.proofB;

  // ── S4 阈值篡改三连拒 ──
  await runScenario('S4 阈值篡改被拒：(a)低阈值证明 (b)篡改publicSignals (c)isValid=0；credit_proofs 不增', async () => {
    const [beforeRows] = await db.query('SELECT COUNT(*) AS c FROM credit_proofs');
    const countBefore = Number(beforeRows[0].c);

    // (a) 恶意低阈值：合法分 700 + 阈值 500 的证明（zkService 阈值强核 publicSignals[1]!==600 拒绝）
    const zkLowThreshold = await zkService.generateProof(700, 500, 1);
    const sigA = await creditProofSig(userA);
    const respA = await axios.post(`${API}/credit/generate-proof`,
      { userId: aId, proof: zkLowThreshold.proof, publicSignals: zkLowThreshold.publicSignals, signature: sigA },
      { headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${userA.jwt}`, ...financialHeaders(userA, { userId: aId, proof: zkLowThreshold.proof, publicSignals: zkLowThreshold.publicSignals, signature: sigA }) }, validateStatus: () => true, timeout: 30000 });
    assert(respA.status === 400, `(a) 低阈值证明应 400，实得 ${respA.status}：${JSON.stringify(respA.data).slice(0, 200)}`);
    assert(String(respA.data.message || '').includes('零知识证明验证失败'), `(a) 消息应含"零知识证明验证失败"，实为 ${respA.data.message}`);

    // (b) 合法 600 阈值证明，篡改 publicSignals[1] '600'→'500'（密码学验证失败：proof 与被篡改公开输入不再配对）
    const tamperedSignals = [...global.proofA.publicSignals];
    tamperedSignals[1] = '500';
    const sigB = await creditProofSig(userA);
    const bodyB = { userId: aId, proof: global.proofA.proof, publicSignals: tamperedSignals, signature: sigB };
    const respB = await axios.post(`${API}/credit/generate-proof`, bodyB,
      { headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${userA.jwt}`, ...financialHeaders(userA, bodyB) }, validateStatus: () => true, timeout: 30000 });
    assert(respB.status === 400, `(b) 篡改 publicSignals 应 400，实得 ${respB.status}：${JSON.stringify(respB.data).slice(0, 200)}`);
    assert(String(respB.data.message || '').includes('零知识证明验证失败'), `(b) 消息应含"零知识证明验证失败"，实为 ${respB.data.message}`);

    // (c) 真实分 500 < 阈值 600 → 电路 isValid=0（zkService.js isValid 分支业务拒绝）
    //     签名原文用 DB 的 credit_score=700（credit.js:139 用库值，与证明输入无关）
    const zkInvalid = await zkService.generateProof(500, 600, 1);
    assert(zkInvalid.publicSignals[0] === '0', `(c) 前置：generateProof(500,600,1) 的 publicSignals[0] 应为 '0'（isValid=0），实为 ${zkInvalid.publicSignals[0]}`);
    const sigC = await creditProofSig(userA);
    const bodyC = { userId: aId, proof: zkInvalid.proof, publicSignals: zkInvalid.publicSignals, signature: sigC };
    const respC = await axios.post(`${API}/credit/generate-proof`, bodyC,
      { headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${userA.jwt}`, ...financialHeaders(userA, bodyC) }, validateStatus: () => true, timeout: 30000 });
    assert(respC.status === 400, `(c) isValid=0 证明应 400，实得 ${respC.status}：${JSON.stringify(respC.data).slice(0, 200)}`);
    assert(String(respC.data.message || '').includes('零知识证明验证失败'), `(c) 消息应含"零知识证明验证失败"，实为 ${respC.data.message}`);

    const [afterRows] = await db.query('SELECT COUNT(*) AS c FROM credit_proofs');
    const countAfter = Number(afterRows[0].c);
    assert(countAfter === countBefore, `credit_proofs 表 count 不应增加：前=${countBefore} 后=${countAfter}`);
    console.log(`  三连拒均为 400"零知识证明验证失败"；(a)低阈值 (b)篡改信号 (c)isValid=0；credit_proofs count ${countBefore}→${countAfter} 不增`);
  });

  // ── S5 担保邀约 + 接受 ──
  await runScenario('S5 担保邀约 /guarantee/request → 担保人 /guarantee/accept/:id', async () => {
    const reqBody = {
      guarantorId: bId,
      loanAmount: 1000,
      borrowerSignature: signWithSM2(
        buildSignatureData({ borrowerId: String(aId), guarantorId: String(bId), loanAmount: String(1000) }, ['borrowerId', 'guarantorId', 'loanAmount']),
        userA.privKey
      ),
      creditProof: { id: proofA().id },
      verificationCode: proofA().verificationCode
    };
    const reqData = await post(userA, '/guarantee/request', reqBody);
    assert(reqData.success === true, `邀约创建失败：${JSON.stringify(reqData).slice(0, 200)}`);
    assert(reqData.requestId !== undefined, `/guarantee/request 返回 requestId 为 undefined（guarantee.js 应取 result.request.id）`);
    global.requestId = reqData.requestId;
    console.log(`  邀约#${global.requestId} 创建成功`);

    // accept 签名原文：服务端用 DB 回读 loan_amount（DECIMAL 两位小数）构造，按现实口径
    // Number(x).toFixed(2) 签名（同 finance-e2e.js:364-374 注释，缺陷 M 口径）
    const acceptBody = {
      guarantorSignature: signWithSM2(
        buildSignatureData({ requestId: String(global.requestId), guarantorId: String(bId), loanAmount: Number(1000).toFixed(2) }, ['guarantorId', 'loanAmount', 'requestId']),
        userB.privKey
      )
    };
    const acceptData = await post(userB, `/guarantee/accept/${global.requestId}`, acceptBody);
    assert(acceptData.success && acceptData.status === 'ACCEPTED', `邀约接受失败：${JSON.stringify(acceptData).slice(0, 200)}`);
    console.log(`  邀约#${global.requestId} 已被 B 接受（ACCEPTED）`);
  });

  // ── S6 担保借款 ──
  await runScenario('S6 担保借款 1000/30d risk_mode=2：total=P+I(85折)+F、合约 ACTIVE、B frozen+1000、LA+1000', async () => {
    const G_AMOUNT = 1000;
    const G_TERM = 30;
    const gInterestAgreed = poolCalcInterest(G_AMOUNT, G_TERM, 700, 2); // 担保 85 折
    const gFeeInfo = guaranteeEngine.calculateGuaranteeFee(G_AMOUNT, getBaseInterestRate(700) / 100, 0);
    global.gFee = round2(gFeeInfo.feeAmount);
    global.gLoyalty = round2(gFeeInfo.loyaltyBonus);
    console.log(`  预期：利息=${gInterestAgreed} 担保费F=${global.gFee} loyalty=${global.gLoyalty}`);

    const poolPreBorrow = await checkInvariants('S6借款前');
    const bPreBorrow = await getUser(bId);
    const borrowBody = {
      userId: aId,
      amount: G_AMOUNT,
      term: G_TERM,
      risk_mode: 2,
      guarantee_request_id: global.requestId,
      creditProof: { id: proofA().id, proof: proofA().proof, publicSignals: proofA().publicSignals },
      verificationCode: proofA().verificationCode,
      signature: borrowSig(userA, G_AMOUNT, proofA())
    };
    const borrowData = await post(userA, '/loan/borrow', borrowBody);
    assert(borrowData.success && borrowData.transaction, `担保借款失败：${JSON.stringify(borrowData).slice(0, 300)}`);
    global.gTxId = borrowData.transaction.id;
    global.gContractId = borrowData.guaranteeContractId;
    assert(global.gContractId, `借款响应缺少 guaranteeContractId`);
    const gTx = borrowData.transaction;
    console.log(`  借款#${global.gTxId} 合约#${global.gContractId} total_amount=${gTx.total_amount}`);

    const gContract = await getContract(global.gContractId);
    assert(gContract && gContract.status === 'ACTIVE', `合约状态非 ACTIVE：${gContract && gContract.status}`);
    assertNear(gContract.guarantee_amount, G_AMOUNT, 0.001, '合约担保金额不符');
    assertNear(gContract.fee_amount, global.gFee, 0.011, `合约费不符（计算值=${global.gFee}）`);
    assert(Number(gContract.fee_collected) === 0, `新合约 fee_collected 应为 0`);
    assert(Number(gContract.released_amount) === 0, `新合约 released_amount 应为 0`);
    assertNear(gTx.total_amount, G_AMOUNT + gInterestAgreed + global.gFee, 0.011,
      `total_amount 应含担保费（P+I+F=${round2(G_AMOUNT + gInterestAgreed + global.gFee)}）`);
    const bAfterLock = await getUser(bId);
    assertNear(Number(bAfterLock.frozen_balance), Number(bPreBorrow.frozen_balance || 0) + G_AMOUNT, 0.011, '担保人 frozen 未增加担保额度');
    const poolAfterBorrow = await checkInvariants('S6借款后');
    assertNear(poolAfterBorrow.LA, poolPreBorrow.LA + G_AMOUNT, 0.011, '借款后 LA 增量不符');
    global.gTxCreatedAt = gTx.created_at;
    global.gInterestAgreed = gInterestAgreed;
  });

  // ── S7 押金借款 ──
  await runScenario('S7 押金借款 1000/30d risk_mode=1：低押金 400 负例 → FROZEN/margin_rate/余额净变', async () => {
    const M_AMOUNT = 1000;
    const mRate = marginRateOf(700, 30);
    const mMargin = round2(M_AMOUNT * mRate);
    console.log(`  费率=${mRate} 押金=${mMargin}`);

    // 负例：低于计算值 10 元 → 400 '押金金额不足'
    const lowMargin = round2(mMargin - 10);
    const lowBody = {
      userId: aId, amount: M_AMOUNT, term: 30, risk_mode: 1, margin_amount: lowMargin,
      creditProof: { id: proofA().id, proof: proofA().proof, publicSignals: proofA().publicSignals },
      verificationCode: proofA().verificationCode,
      signature: borrowSig(userA, M_AMOUNT, proofA())
    };
    const lowResp = await axios.post(`${API}/loan/borrow`, lowBody, {
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${userA.jwt}`, ...financialHeaders(userA, lowBody) },
      validateStatus: () => true, timeout: 30000
    });
    assert(lowResp.status === 400, `押金 ${lowMargin} 低于要求 ${mMargin} 应返回 400，实得 ${lowResp.status}：${JSON.stringify(lowResp.data).slice(0, 200)}`);
    assert(String(lowResp.data.message || '').includes('押金金额不足'), `400 消息应说明押金金额不足：${lowResp.data.message}`);
    console.log(`  低押金 ${lowMargin} 被拒（400 押金金额不足）`);

    const poolPreMarginBorrow = await checkInvariants('S7借款前');
    const aPreMarginBorrow = await getUser(aId);
    const mBorrowBody = {
      userId: aId, amount: M_AMOUNT, term: 30, risk_mode: 1, margin_amount: mMargin,
      creditProof: { id: proofA().id, proof: proofA().proof, publicSignals: proofA().publicSignals },
      verificationCode: proofA().verificationCode,
      signature: borrowSig(userA, M_AMOUNT, proofA())
    };
    const mBorrow = await post(userA, '/loan/borrow', mBorrowBody);
    assert(mBorrow.success && mBorrow.marginOrderId, `押金借款失败：${JSON.stringify(mBorrow).slice(0, 300)}`);
    global.mTxId = mBorrow.transaction.id;
    global.marginOrderId = mBorrow.marginOrderId;
    const mOrder = await getMarginOrder(global.marginOrderId);
    assert(mOrder && mOrder.status === 'FROZEN', '押金订单应 FROZEN');
    assertNear(Number(mOrder.margin_rate), mRate, 0.0001, `订单 margin_rate 应为计算费率 ${mRate}（实为 ${mOrder.margin_rate}）`);
    assert(Number(mOrder.loan_id) === global.mTxId, '押金订单应关联借款');
    const aAfterMarginBorrow = await getUser(aId);
    // 借款入账（+1000）与押金冻结（−mMargin）同时发生：净变动 = 入账 − 押金
    assertNear(Number(aAfterMarginBorrow.balance), Number(aPreMarginBorrow.balance) + M_AMOUNT - mMargin, 0.011, '押金冻结后余额应 = 借款入账 − 押金');
    assertNear(Number(aAfterMarginBorrow.frozen_balance), Number(aPreMarginBorrow.frozen_balance || 0) + mMargin, 0.011, '押金冻结后 frozen 应增加');
    const poolAfterMarginBorrow = await checkInvariants('S7借款后');
    assertNear(poolAfterMarginBorrow.LA, poolPreMarginBorrow.LA + M_AMOUNT, 0.011, '押金借款后 LA 增量不符');
    global.mMargin = mMargin;
    global.mTxCreatedAt = mBorrow.transaction.created_at;
  });

  // ── S8 纯信用借款 ──
  await runScenario('S8 纯信用借款 500/30d risk_mode=0：LA+500（活跃并发 2500 < 动态限额）', async () => {
    const poolPre = await checkInvariants('S8借款前');
    const dynLimit = await dynamicConfig.getLoanLimit(700, 70);
    // userRisk=70（loan.js:1006 creditScore>=700→70）→ multiplier 1.0（dynamicConfigService）→ base 5000
    console.log(`  动态限额 getLoanLimit(700,70)=${dynLimit}（期望口径 5000），借款前活跃并发=2000（S6 担保 1000 + S7 押金 1000）`);
    assert(dynLimit > 2500, `动态限额 ${dynLimit} 应大于借款后活跃并发 2500（否则 .env 定制了限额口径，需人工核对）`);
    const oBorrow = await post(userA, '/loan/borrow', {
      userId: aId, amount: 500, term: 30, risk_mode: 0,
      creditProof: { id: proofA().id, proof: proofA().proof, publicSignals: proofA().publicSignals },
      verificationCode: proofA().verificationCode,
      signature: borrowSig(userA, 500, proofA())
    });
    assert(oBorrow.success, `纯信用借款失败：${JSON.stringify(oBorrow).slice(0, 200)}`);
    global.oTxId = oBorrow.transaction.id;
    const poolAfter = await checkInvariants('S8借款后');
    assertNear(poolAfter.LA, poolPre.LA + 500, 0.011, '纯信用借款后 LA 增量应 +500');
    global.oInterestAgreed = poolCalcInterest(500, 30, 700, 0);
    console.log(`  借款#${global.oTxId} 成功；LA+500；活跃并发 2500 < 限额 ${dynLimit}`);
  });

  // ── S9 部分还款 300（担保贷） ──
  await runScenario('S9 部分还款 300（担保贷）：released_amount 增量释放、fee_collected 仍 0、LA−已还本金', async () => {
    const PARTIAL = 300;
    const nowPartial = Date.now();
    const actualDaysAll = daysBetween(new Date(global.gTxCreatedAt).getTime(), nowPartial); // 借款当天=1
    const finalInterestAtPartial = Math.min(loanCalcInterest(1000, actualDaysAll, 700), global.gInterestAgreed);
    const paidInterest = Math.min(PARTIAL, finalInterestAtPartial);
    const paidPrincipal = round2(PARTIAL - paidInterest);
    console.log(`  部分还款${PARTIAL}：利息${paidInterest} 本金${paidPrincipal}（同 finance-e2e.js:413-451 口径）`);

    const poolPrePartial = await checkInvariants('S9还款前');
    const aPrePartial = await getUser(aId);
    const bPrePartial = await getUser(bId);
    await post(userA, '/loan/repay', {
      userId: aId,
      transactionId: global.gTxId,
      partialAmount: PARTIAL,
      creditProof: { id: proofA().id },
      verificationCode: proofA().verificationCode,
      signature: repaySig(userA, global.gTxId, proofA())
    });

    const contractAfterPartial = await getContract(global.gContractId);
    const targetRelease = round2(1000 * Math.min(1, paidPrincipal / 1000));
    assertNear(Number(contractAfterPartial.released_amount), targetRelease, 0.011,
      `部分还款后 released_amount 应为累计已还本金比例目标 ${targetRelease}`);
    assert(Number(contractAfterPartial.fee_collected) === 0, `部分还款不应代收担保费（fee_collected 仍应为 0）`);
    assert(contractAfterPartial.status === 'ACTIVE', '部分还款后合约应保持 ACTIVE');
    const bAfterPartial = await getUser(bId);
    assertNear(Number(bAfterPartial.frozen_balance), Number(bPrePartial.frozen_balance || 0) - targetRelease, 0.011, '部分还款后担保人 frozen 未按增量释放');
    assertNear(Number(bAfterPartial.balance) - Number(bPrePartial.balance), targetRelease, 0.011, '部分还款后担保人 balance 增量应等于释放额');
    const aAfterPartial = await getUser(aId);
    assertNear(Number(aAfterPartial.balance), Number(aPrePartial.balance) - PARTIAL, 0.011, '借款人部分还款扣款不符');
    const poolAfterPartial = await checkInvariants('S9还款后');
    assertNear(poolAfterPartial.LA, poolPrePartial.LA - paidPrincipal, 0.011, '部分还款后 LA 减量应等于已还本金');
    global.releasedAfterPartial = Number(contractAfterPartial.released_amount);
    console.log(`  released_amount=${global.releasedAfterPartial} fee_collected=0；LA Δ=${round2(poolAfterPartial.LA - poolPrePartial.LA)}`);
  });

  // ── S10 全额还款（担保贷）——担保费代扣核心断言 ──
  await runScenario('S10 全额还款（担保贷）：借款人Δ=−(P+I+F)+0.1F、B 0.7F+loyalty+解冻、PC Δ、COMPLETED+fee_collected=1', async () => {
    const remainingTx = require('../dao/transactionDao');
    const txAfterPartial = await remainingTx.findById(global.gTxId);
    const P2 = round2(Number(txAfterPartial.amount));
    const actualDays2 = daysBetween(new Date(txAfterPartial.created_at).getTime(), Date.now());
    const actualInterest2 = loanCalcInterest(P2, actualDays2, 700);
    const finalInterest2 = Math.min(actualInterest2, round2(Number(txAfterPartial.interest)));
    const F = global.gFee;
    const fullPayTotal = round2(P2 + finalInterest2 + F);
    console.log(`  全额还款：P2=${P2} I2=${finalInterest2} F=${F} 合计=${fullPayTotal}`);

    const poolPreFull = await checkInvariants('S10还款前');
    const aPreFull = await getUser(aId);
    const bPreFull = await getUser(bId);
    await post(userA, '/loan/repay', {
      userId: aId,
      transactionId: global.gTxId,
      creditProof: { id: proofA().id },
      verificationCode: proofA().verificationCode,
      signature: repaySig(userA, global.gTxId, proofA())
    });

    const contractFinal = await getContract(global.gContractId);
    assert(contractFinal.status === 'COMPLETED', `全额还款后合约应 COMPLETED，实为 ${contractFinal.status}`);
    assert(Number(contractFinal.fee_collected) === 1, `全额还款后 fee_collected 应为 1（担保费代扣入池）`);
    assertNear(Number(contractFinal.released_amount), 1000, 0.011, `合约完成时 released_amount 应累计至全额 1000`);

    const aFinal = await getUser(aId);
    const bFinal = await getUser(bId);
    const aDelta = Number(aFinal.balance) - Number(aPreFull.balance);
    const bBalDelta = Number(bFinal.balance) - Number(bPreFull.balance);
    const bFrozenDelta = Number(bFinal.frozen_balance) - Number(bPreFull.frozen_balance || 0);
    assertNear(aDelta, -(P2 + finalInterest2 + F) + round2(F * 0.10), 0.011,
      `借款人净变动应为 −(P+I+F)+0.1F = ${round2(-(P2 + finalInterest2 + F) + F * 0.10)}`);
    assertNear(bBalDelta, round2(F * 0.70) + global.gLoyalty + round2(1000 - global.releasedAfterPartial), 0.011,
      `担保人 balance 增量应为 0.7F+loyalty+剩余解冻额度`);
    assertNear(bFrozenDelta, -(1000 - global.releasedAfterPartial), 0.011, `担保人 frozen 应解冻剩余额度`);

    const poolAfterFull = await checkInvariants('S10还款后');
    const pcDelta = poolAfterFull.PC - poolPreFull.PC;
    const laDelta = poolAfterFull.LA - poolPreFull.LA;
    assertNear(laDelta, -P2, 0.011, `全额还款后 LA 减量应为剩余本金 ${P2}`);
    // PC 增量 = 归还两池的本息 + 费净留存(0.2F−loyalty)。借款比例从 transactions 读取
    const [ratioRows] = await db.query('SELECT borrow_platform_ratio FROM transactions WHERE id = ?', [global.gTxId]);
    const platformRatio = Number(ratioRows[0].borrow_platform_ratio);
    const expectPcDelta = round2(P2 * platformRatio + finalInterest2 * platformRatio + (round2(F * 0.20) - global.gLoyalty));
    assertNear(pcDelta, expectPcDelta, 0.02,
      `PC 净增量应为 本息×平台比例 + (0.2F−loyalty) = ${expectPcDelta}（其中费净留存 ${round2(F * 0.20) - global.gLoyalty}）`);
    console.log(`  借款人 Δ=${round2(aDelta)} 担保人 Δbal=${round2(bBalDelta)} Δfrozen=${round2(bFrozenDelta)} PC Δ=${round2(pcDelta)} LA Δ=${round2(laDelta)}（loan.js:792-793 担保费代扣口径）`);
  });

  // ── S11 押金贷全额还款 ──
  await runScenario('S11 押金贷全额还款：RELEASED + frozen_interest（PC 支付冻结期利息，有源）', async () => {
    // 订单 created_at 拨回 1000 天，制造非平凡冻结期利息（同 finance-e2e.js:552-557）
    await db.execute('UPDATE risk_margin_orders SET created_at = NOW() - INTERVAL 1000 DAY WHERE id = ?', [global.marginOrderId]);
    const [orderRows] = await db.query('SELECT created_at FROM risk_margin_orders WHERE id = ?', [global.marginOrderId]);
    const freezeDays = daysBetween(new Date(orderRows[0].created_at).getTime(), Date.now());
    const freezeInterest = round2(global.mMargin * (parseFloat(process.env.MARGIN_INTEREST_RATE) || 0.0035) * freezeDays / 365);
    console.log(`  冻结期拨回 ${freezeDays} 天，预期冻结期利息=${freezeInterest}`);

    const poolPreMarginRepay = await checkInvariants('S11还款前');
    const aPreMarginRepay = await getUser(aId);
    const mFinalInterest = Math.min(loanCalcInterest(1000, daysBetween(new Date(global.mTxCreatedAt).getTime(), Date.now()), 700), poolCalcInterest(1000, 30, 700, 1));
    await post(userA, '/loan/repay', {
      userId: aId, transactionId: global.mTxId,
      creditProof: { id: proofA().id },
      verificationCode: proofA().verificationCode,
      signature: repaySig(userA, global.mTxId, proofA())
    });

    const mOrderAfter = await getMarginOrder(global.marginOrderId);
    assert(mOrderAfter.status === 'RELEASED', `押金订单应 RELEASED，实为 ${mOrderAfter.status}`);
    assertNear(Number(mOrderAfter.frozen_interest), freezeInterest, 0.02,
      `frozen_interest 应等于冻结期利息 ${freezeInterest}（实为 ${mOrderAfter.frozen_interest}）`);
    const poolAfterMarginRepay = await checkInvariants('S11还款后');
    // PC 净变 = 归还本息的平台份额 − 支付冻结期利息（利息由 PC 支付，有源）
    const [mRatioRows] = await db.query('SELECT borrow_platform_ratio FROM transactions WHERE id = ?', [global.mTxId]);
    const mPlatformRatio = Number(mRatioRows[0].borrow_platform_ratio);
    const expectPcNet = round2(round2(1000 * mPlatformRatio) + round2(mFinalInterest * mPlatformRatio) - freezeInterest);
    assertNear(poolAfterMarginRepay.PC, poolPreMarginRepay.PC + expectPcNet, 0.02,
      `PC 净变应为 本息×平台比例−冻结期利息 = ${expectPcNet}（实变 ${round2(poolAfterMarginRepay.PC - poolPreMarginRepay.PC)}）`);
    const aAfterMarginRepay = await getUser(aId);
    const mFinalTotal = round2(1000 + mFinalInterest);
    assertNear(Number(aAfterMarginRepay.balance), Number(aPreMarginRepay.balance) - mFinalTotal + global.mMargin + Number(mOrderAfter.frozen_interest), 0.02,
      `押金借款人净变动应为 −(P+I)+押金+利息`);
    console.log(`  押金订单 RELEASED，frozen_interest=${mOrderAfter.frozen_interest}，PC 支付一致（利息有源）`);
  });

  // ── S12 制造逾期 + 负例 ──
  await runScenario('S12 改库制造逾期 → checkOverdueLoans → overdue；负例：逾期用户生成证明 400', async () => {
    await db.execute('UPDATE transactions SET due_date = NOW() - INTERVAL 1 DAY WHERE id = ?', [global.oTxId]);
    const { checkOverdueLoans } = require('../services/overdueService');
    const overdueResult = await checkOverdueLoans();
    console.log(`  checkOverdueLoans: ${JSON.stringify(overdueResult)}`);
    assert(await getTxStatus(global.oTxId) === 'overdue', `checkOverdueLoans 后借款应为 overdue，实为 ${await getTxStatus(global.oTxId)}`);

    // 负例：逾期用户生成信用证明 → 400 '您当前有逾期借款记录'（credit.js:164-170，ZKP 验证通过后的服务端独立校验）
    const zk = await zkService.generateProof(700, 600, 1);
    const bizSig = await creditProofSig(userA);
    const body = { userId: aId, proof: zk.proof, publicSignals: zk.publicSignals, signature: bizSig };
    const resp = await axios.post(`${API}/credit/generate-proof`, body,
      { headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${userA.jwt}`, ...financialHeaders(userA, body) }, validateStatus: () => true, timeout: 30000 });
    assert(resp.status === 400, `逾期用户生成证明应 400，实得 ${resp.status}：${JSON.stringify(resp.data).slice(0, 200)}`);
    assert(String(resp.data.message || '').includes('您当前有逾期借款记录'), `消息应含"您当前有逾期借款记录"，实为 ${resp.data.message}`);
    console.log(`  信用贷#${global.oTxId} → overdue；逾期生成证明被拒（400 您当前有逾期借款记录）`);
  });

  // ── S13 罚息还款 ──
  await runScenario('S13 罚息还款：completed、扣款=P+约定利息+罚息（按日计息×罚息倍数）', async () => {
    const poolPreOverdueRepay = await checkInvariants('S13还款前');
    const aPreOverdueRepay = await getUser(aId);
    const oDaysLate = 1; // S12 拨回 1 天
    const oPenalty = loanCalcInterest(500, oDaysLate, 700, true, oDaysLate);
    const oFinalInterest = round2(global.oInterestAgreed + oPenalty);
    const penaltyMultiplier = dynamicConfig.getOverduePenaltyRate(oDaysLate);
    console.log(`  逾期${oDaysLate}天 罚息倍数=${penaltyMultiplier} 罚息=${oPenalty} 总利息=${oFinalInterest}`);
    await post(userA, '/loan/repay', {
      userId: aId, transactionId: global.oTxId,
      creditProof: { id: proofA().id },
      verificationCode: proofA().verificationCode,
      signature: repaySig(userA, global.oTxId, proofA())
    });
    assert(await getTxStatus(global.oTxId) === 'completed', `逾期还款后状态应 completed，实为 ${await getTxStatus(global.oTxId)}`);
    const aAfterOverdueRepay = await getUser(aId);
    const expectOverduePay = round2(500 + oFinalInterest);
    assertNear(Number(aAfterOverdueRepay.balance), Number(aPreOverdueRepay.balance) - expectOverduePay, 0.02,
      `逾期还款扣款应含罚息 ${expectOverduePay}`);
    // 罚息公式与 dynamicConfig 倍数一致性
    const manualPenalty = round2(500 * ((6.0 / 100) / 365) * oDaysLate * penaltyMultiplier);
    assertNear(oPenalty, manualPenalty, 0.011, `罚息应等于 本金×日利率×逾期天数×${penaltyMultiplier}`);
    const poolAfterOverdueRepay = await checkInvariants('S13还款后');
    assertNear(poolAfterOverdueRepay.LA, poolPreOverdueRepay.LA - 500, 0.011, '逾期还款后 LA 减量不符');
    console.log(`  逾期还款成功：状态 completed、扣款 ${expectOverduePay}（P+约定利息+罚息）`);
  });

  // ── S14 出资 / 赎回 ──
  await runScenario('S14 B 出资 1000/30d → UC+1000；B 赎回 100 → UC−(100+实付利息)、UIE 扣减、B 余额+', async () => {
    const poolPreInvest = await checkInvariants('S14出资前');
    await post(userB, '/invest', {
      userId: bId, amount: 1000, term: 30,
      creditProof: { id: proofB().id },
      verificationCode: proofB().verificationCode,
      signature: signWithSM2(
        buildSignatureData({ userId: String(bId), amount: 1000, term: 30, creditProofId: proofB().id }, ['amount', 'creditProofId', 'term', 'userId']),
        userB.privKey
      )
    });
    const poolAfterInvest = await checkInvariants('S14出资后');
    assertNear(poolAfterInvest.UC, poolPreInvest.UC + 1000, 0.011, '出资后 UC 应 +1000');

    // 赎回 100（同 finance-e2e.js:790-814：实付利息有源上限 UIE）
    const poolPreRedeem = await checkInvariants('S14赎回前');
    const uieBefore = poolPreRedeem.UIE;
    const bPreRedeem = await getUser(bId);
    const annualLending = await getCurrentLendingRate();
    const redeemInterestDynamic = round2(100 * (annualLending / 365) * 1);
    const redeemActualInterest = Math.min(redeemInterestDynamic, uieBefore);
    console.log(`  出资年利率=${annualLending} 动态利息=${redeemInterestDynamic} 实付=${redeemActualInterest}（有源上限 UIE=${uieBefore}）`);
    await post(userB, '/redeem', {
      userId: bId, amount: 100,
      creditProof: { id: proofB().id },
      verificationCode: proofB().verificationCode,
      signature: signWithSM2(
        buildSignatureData({ userId: String(bId), amount: 100, creditProofId: proofB().id }, ['amount', 'creditProofId', 'userId']),
        userB.privKey
      )
    });
    const poolAfterRedeem = await checkInvariants('S14赎回后');
    assertNear(poolAfterRedeem.UC, poolPreRedeem.UC - (100 + redeemActualInterest), 0.02,
      `赎回后 UC 减量应为 100+实付利息 ${round2(100 + redeemActualInterest)}（实减 ${round2(poolPreRedeem.UC - poolAfterRedeem.UC)}）`);
    assertNear(poolAfterRedeem.UIE, uieBefore - redeemActualInterest, 0.02, `赎回后应付利息应扣减 ${redeemActualInterest}`);
    const bAfterRedeem = await getUser(bId);
    assertNear(Number(bAfterRedeem.balance) - Number(bPreRedeem.balance), 100 + redeemActualInterest, 0.02, `赎回到账应为本金+有源利息`);
    console.log(`  赎回完成：UC Δ=${round2(poolAfterRedeem.UC - poolPreRedeem.UC)} UIE Δ=${round2(poolAfterRedeem.UIE - poolPreRedeem.UIE)}`);
  });

  // ── S15 区块链浏览器 ──
  await runScenario('S15 区块链浏览器：/status（public）+ /explorer（JWT）结构断言 + 上链软检轮询', async () => {
    const chain = await getChainStatus();
    const chainTotal0 = global.chainTotal0;
    console.log(`  /blockchain/status：isConnected=${chain.isConnected} totalRecords=${chain.totalRecords}（S0 基线=${chainTotal0}）`);

    if (!chain.isConnected || Number(chain.totalRecords) === 0) {
      // 降级口径：getExplorerData 按设计返回零值而非 5xx（blockchainServiceFisco.js getExplorerData）
      console.log(`  【降级注明：链不可用/浏览器零值降级，getExplorerData 按设计返回零值而非 5xx】`);
      return;
    }

    // /explorer 需 JWT（不在 PUBLIC_PATHS）；GET 免 SM2/防重放 → 仅带 Authorization 即可
    const expData = await get(userA, '/blockchain/explorer?limit=3');
    assert(expData.success === true, `explorer 响应 success 应为 true：${JSON.stringify(expData).slice(0, 200)}`);
    const d = expData.data;
    assert(d && typeof d.totalRecords === 'number', `explorer totalRecords 应为数字：${JSON.stringify(d).slice(0, 200)}`);
    assert(Array.isArray(d.recentRecords), `explorer recentRecords 应为数组`);
    assert(d.recentRecords.length <= 3, `limit=3 时 recentRecords.length 应 ≤3，实为 ${d.recentRecords.length}`);
    assert(d.typeStats && typeof d.typeStats === 'object', `explorer typeStats 应为对象`);
    assert(Number(d.totalRecords) >= chainTotal0, `explorer totalRecords=${d.totalRecords} 不应小于 S0 基线 ${chainTotal0}`);
    console.log(`  /explorer：totalRecords=${d.totalRecords} recentRecords=${d.recentRecords.length}条 typeStats=${JSON.stringify(d.typeStats)}`);

    // 软检轮询：S3 的 CREDIT_PROOF_GENERATE 异步上链（blockchainQueueService 重试队列），30s 超时仅降级注明
    const deadline = Date.now() + 30000;
    let reached = Number(chain.totalRecords) >= chainTotal0 + 1;
    while (!reached && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 3000));
      const c = await getChainStatus();
      if (c && Number(c.totalRecords) >= chainTotal0 + 1) { reached = true; console.log(`  轮询：totalRecords=${c.totalRecords} ≥ 基线+1`); }
    }
    if (reached) {
      console.log(`  上链软检通过：totalRecords ≥ ${chainTotal0 + 1}（S3 存证已入链）`);
    } else {
      console.log(`  【降级注明：30s 内 totalRecords 未达基线+1（异步上链队列延迟），降级不失败】`);
    }
  });

  // ── S16 终态恒等式 + 汇总 ──
  await runScenario('S16 终态恒等式校验', async () => {
    await checkInvariants('终态');
    const finalPool = await getPool();
    console.log(`终态池：PC=${finalPool.PC} UC=${finalPool.UC} LA=${finalPool.LA} total=${finalPool.total} avail=${finalPool.available}`);
  });

  await db.end();
  if (failures.length > 0) {
    console.error(`\n══════════ 失败清单（${failures.length} 项）══════════`);
    failures.forEach((f, i) => console.error(`${i + 1}. ${f.name}\n   └─ ${f.message}`));
    writeFailuresFile();
    console.error(`\n[FATAL] full-loop e2e 共 ${failures.length} 个场景失败，退出码 1`);
    process.exit(1);
  }
  console.log(`\n══════════ S0-S16 全部场景通过（${passed.length} 项）══════════`);
  console.log(`耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log(`全程恒等式校验通过：total==PC+UC，available==total−LA，各分量非负`);
  process.exit(0);
})().catch((e) => {
  // 测试基建失败（预检/注册/夹具/连接），属于环境错误而非契约红，不写清单文件
  console.error(`\n[FATAL] e2e 环境异常终止（非契约红）：${e.stack || e.message}`);
  if (db) db.end().catch(() => {});
  process.exit(1);
});
