/**
 * 阶段2 资金账务修复 e2e 验证脚本
 * ---------------------------------------------------------------
 * 覆盖线索（与阶段2计划步骤 3-9 的修复点一一对应）：
 *   A  逾期还款状态闸门 + 罚息（loan.js:612 放行 IN('pending','overdue')）
 *   B  违约清算闭环（overdueService.liquidateOverdueLoans + 没收入池 + afterRepay 去清算化）
 *   C  担保费闭环（借款 total_amount 含费 → 全额还款代收入池 fee_collected=1 → 结算分配 0.7F/0.1F）
 *   D  押金释放利息有源（releaseMargin 由 PC 支付冻结期利息）
 *   E  赎回利息有源（还款时利息计入 UC，赎回时从 UC 支付）
 *   K  赎回校验口径（UC ≥ amount+actualInterest；由场景⑤ UC/UIE 减量断言覆盖效果路径，
 *      不足拒赎回的拒绝分支计划未定义 HTTP 契约，故不做状态码断言）
 *   F  并发还款恰一成功（事务行锁 + 状态守卫 + affectedRows 校验）
 *   G  担保额度按累计还款比例增量释放（released_amount）
 *   H  部分还款/全额还款边界归一化（场景①-d 部分还款 300 + ①-e 全额尾款）
 *   I  押金金额服务端强校验 + margin_rate 落库
 *   J  孤儿冻结清理（直调入口：overdueService.cleanupOrphanMarginOrders()，
 *      本脚本按计划步骤9/12 约定该名字；实现若用其它名字，同步改场景⑦一行 require 即可）
 *   L  /guarantee/request 返回 requestId（guarantee.js:69 result.request.id）
 *
 * 运行模式：
 *   GREEN（默认）：任何断言失败 → 记入失败清单 → 退出码 1；全绿退出码 0。
 *   RED（修复前运行）：场景间失败互不阻断（runScenario 逐场景收集），跑完全部场景
 *   输出失败清单并写 backend/test/results/phase2-red.txt，便于一次拿到全部红证据。
 *   预检/夹具/登录等测试基建失败视为环境错误，立即终止且不写清单文件。
 *
 * 每个资金步骤后校验资金池恒等式：
 *   total == PC + UC；available == total − LA；PC/UC/LA/available ≥ −0.005
 * 任何断言失败：打印差值明细，绝不静默跳过。
 * 环境不可用（后端不在线 / ZK 失败 / 数据库不可达）时显式报错退出。
 *
 * 运行：node backend/test/finance-e2e.js
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
const RED_LIST_PATH = path.resolve(__dirname, 'results/phase2-red.txt');

// ───────────────────────────── 工具 ─────────────────────────────
const round2 = (x) => Math.round(x * 100) / 100;

/** 断言失败统一抛出（不再直接退出），由场景运行器收集/或顶层终止 */
function fail(msg) {
  throw new Error(`断言失败：${msg}`);
}

function assert(cond, msg) {
  if (!cond) fail(`断言失败：${msg}`);
}

function assertNear(actual, expected, tolerance, msg) {
  if (Math.abs(Number(actual) - Number(expected)) > tolerance) {
    fail(`${msg}：actual=${actual}，expected=${expected}，diff=${round2(Number(actual) - Number(expected))}，tol=${tolerance}`);
  }
}

/** 与 routes/loan.js calculateInterest 完全一致的复本 */
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

/** 与 services/poolService.js calculateInterest 一致的复本（含担保 85 折） */
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

/** 与 services/riskPlugins/marginEngine.js calculateMarginRate 一致的复本 */
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

// ───────────────────────────── 场景收集器 ─────────────────────────────
const failures = []; // { name, message }
async function runScenario(name, fn) {
  console.log(`\n== ${name}`);
  try {
    await fn();
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
      '阶段2 finance-e2e 失败清单（RED 证据）',
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

// ───────────────────────────── HTTP 封装 ─────────────────────────────
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
  // expectStatus === null 表示“接受任意状态码”（场景⑥并发竞争用），不做断言
  if (expectStatus !== null && resp.status !== expectStatus) {
    // 抛出带 axios 风格 response 的错误，供调用方（如并发 repayOnce）catch 判定
    const err = new Error(`POST ${urlPath} 期望 ${expectStatus} 实得 ${resp.status}：${JSON.stringify(resp.data).slice(0, 400)}`);
    err.response = { status: resp.status, data: resp.data };
    err.status = resp.status;
    throw err;
  }
  return resp.data;
}

// ───────────────────────────── 数据读取 ─────────────────────────────
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

// ───────────────────────────── 主流程 ─────────────────────────────
(async () => {
  const t0 = Date.now();

  // 0. 环境预检 —— 不可用即显式报错，绝不伪通过（测试基建失败 ≠ 契约红）
  console.log(`\n== 环境预检`);
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

  // 1. 注册 / 登录 双用户
  console.log(`\n== 注册并登录两个用户（借款人A / 担保人B）`);
  const ts = Date.now();
  const kpA = sm2.generateKeyPairHex();
  const kpB = sm2.generateKeyPairHex();
  const mk = (n) => `e2e_${n}_${ts}`;
  const password = 'E2ePassw0rd';

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
    const resp = await axios.post(`${API}/auth/login`, { username, password }, { validateStatus: () => true, timeout: 15000 });
    if (resp.status !== 200 || !resp.data.success || !resp.data.token) fail(`登录 ${username} 失败：${resp.status} ${JSON.stringify(resp.data).slice(0, 200)}`);
    user.jwt = resp.data.token;
  }
  await login(userA, mk('a'));
  await login(userB, mk('b'));
  console.log(`  A#${aId} B#${bId} 注册登录成功`);

  // 2. 夹具：credit_score=700、balance=5000（加密写入）
  console.log(`\n== 夹具：A/B 设 credit_score=700、balance=5000（sm4Crypto 加密写库）`);
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
  // 夹具补充：注册时间拨回 30 天。理由：动态冷静期（dynamicConfig.getCoolingOff）对新注册用户
  // 的借款限额按 ratio 缩减（纯信用模式再减半），属于与被测资金契约无关的产品规则，
  // 会在 RED 运行中制造“借款超限”级联失败、淹没真正的账务红证据。本测试聚焦资金账务，
  // 故模拟已过冷静期的老用户；不修改任何业务断言。
  await db.execute('UPDATE users SET created_at = NOW() - INTERVAL 30 DAY WHERE id IN (?, ?)', [aId, bId]);
  console.log('  A/B 余额 5000、信用分 700 写入并解密回读一致；created_at 已拨回 30 天（绕开注册冷静期限额）');

  // 3. ZK 证明 + 信用证明（可复用）
  console.log(`\n== 生成 ZK 证明与信用证明`);
  async function makeProof(user) {
    // 阈值 600 = 服务端强核的借款准入阈值（credit.js PROOF_REQUIRED_THRESHOLD），非 600 会被 /credit/generate-proof 拒绝
    const zk = await zkService.generateProof(700, 600, 1);
    const bizSig = signWithSM2(JSON.stringify({ userId: String(user.id), creditScore: 700 }), user.privKey);
    const body = { userId: user.id, proof: zk.proof, publicSignals: zk.publicSignals, signature: bizSig };
    const data = await post(user, '/credit/generate-proof', body);
    // 路由响应为 {success, data:{proof:{proofId, verificationCode, ...}}} 嵌套结构（routes/credit.js）
    const p = (data.data && data.data.proof) ? data.data.proof : data;
    assert(data.success && p.proofId && p.verificationCode, `信用证明生成失败：${JSON.stringify(data).slice(0, 300)}`);
    return { id: p.proofId, verificationCode: p.verificationCode, proof: zk.proof, publicSignals: zk.publicSignals };
  }
  const proofA = await makeProof(userA);
  const proofB = await makeProof(userB);
  console.log(`  proofA=${proofA.id.slice(0, 26)}... proofB=${proofB.id.slice(0, 26)}...`);

  const borrowSig = (user, amount, proof) => signWithSM2(
    buildSignatureData({ userId: String(user.id), amount: parseInt(amount), creditProofId: proof.id }, ['amount', 'creditProofId', 'userId']),
    user.privKey
  );
  const repaySig = (user, txId, proof) => signWithSM2(
    buildSignatureData({ userId: String(user.id), transactionId: txId, creditProofId: proof.id }, ['creditProofId', 'transactionId', 'userId']),
    user.privKey
  );

  // ═══════════════ 场景① 担保借款全周期（C/G/H/L） ═══════════════
  await runScenario('场景① 担保模式：邀约→借款→部分还款→全额还款', async () => {
    const G_AMOUNT = 1000;
    const G_TERM = 30;
    const credit700 = 700;
    const gInterestAgreed = poolCalcInterest(G_AMOUNT, G_TERM, credit700, 2); // 借款利息（担保85折）
    const gFeeInfo = guaranteeEngine.calculateGuaranteeFee(G_AMOUNT, getBaseInterestRate(700) / 100, 0);
    const gFee = round2(gFeeInfo.feeAmount);
    const gLoyalty = round2(gFeeInfo.loyaltyBonus);
    console.log(`  预期：利息=${gInterestAgreed} 担保费F=${gFee} loyalty=${gLoyalty} (0.7F+loyalty→担保人, 0.1F→借款人)`);

    // ①-a 担保邀约（验 L）
    const reqBody = {
      guarantorId: bId,
      loanAmount: G_AMOUNT,
      borrowerSignature: signWithSM2(
        buildSignatureData({ borrowerId: String(aId), guarantorId: String(bId), loanAmount: String(G_AMOUNT) }, ['borrowerId', 'guarantorId', 'loanAmount']),
        userA.privKey
      ),
      creditProof: { id: proofA.id },
      verificationCode: proofA.verificationCode
    };
    const reqData = await post(userA, '/guarantee/request', reqBody);
    assert(reqData.success === true, `邀约创建失败：${JSON.stringify(reqData).slice(0, 200)}`);
    assert(reqData.requestId !== undefined, `【L】/guarantee/request 返回 requestId 为 undefined（result.id 取值错误，应为 result.request.id）`);
    const requestId = reqData.requestId;
    console.log(`  邀约#${requestId} 创建成功（L 通过）`);

    // ①-b 担保人接受
    // 签名原文口径说明（计划外缺陷 M）：acceptRequest 用 DB 回读的 loan_amount（DECIMAL(12,2) →
    // "1000.00"）构造签名原文（services/riskPlugins/guaranteeRequestService.js），与邀约创建时的
    // 整数形态（"1000"）不一致。本脚本按服务端当前实现的两位小数形态签名以保持流程可达；
    // 若后续统一口径（修复 M），需同步本行。
    const acceptBody = {
      guarantorSignature: signWithSM2(
        buildSignatureData({ requestId: String(requestId), guarantorId: String(bId), loanAmount: Number(G_AMOUNT).toFixed(2) }, ['guarantorId', 'loanAmount', 'requestId']),
        userB.privKey
      )
    };
    const acceptData = await post(userB, `/guarantee/accept/${requestId}`, acceptBody);
    assert(acceptData.success && acceptData.status === 'ACCEPTED', `邀约接受失败：${JSON.stringify(acceptData).slice(0, 200)}`);

    // ①-c 担保借款 risk_mode=2
    const poolPreBorrow = await checkInvariants('①借款前');
    const aPreBorrow = await getUser(aId);
    const bPreBorrow = await getUser(bId);
    const borrowBody = {
      userId: aId,
      amount: G_AMOUNT,
      term: G_TERM,
      risk_mode: 2,
      guarantee_request_id: requestId,
      creditProof: { id: proofA.id, proof: proofA.proof, publicSignals: proofA.publicSignals },
      verificationCode: proofA.verificationCode,
      signature: borrowSig(userA, G_AMOUNT, proofA)
    };
    const borrowData = await post(userA, '/loan/borrow', borrowBody);
    assert(borrowData.success && borrowData.transaction, `担保借款失败：${JSON.stringify(borrowData).slice(0, 300)}`);
    const gTxId = borrowData.transaction.id;
    const contractId = borrowData.guaranteeContractId;
    assert(contractId, `借款响应缺少 guaranteeContractId`);
    const gTx = borrowData.transaction;
    console.log(`  借款#${gTxId} 合约#${contractId} total_amount=${gTx.total_amount}`);

    // 借款断言：合约 ACTIVE、担保人冻结、total_amount 含费（C）
    const gContract = await getContract(contractId);
    assert(gContract && gContract.status === 'ACTIVE', `合约状态非 ACTIVE：${gContract && gContract.status}`);
    assertNear(gContract.guarantee_amount, G_AMOUNT, 0.001, '合约担保金额不符');
    assertNear(gContract.fee_amount, gFee, 0.011, `合约费不符（计算值=${gFee}）`);
    assert(Number(gContract.fee_collected) === 0, `新合约 fee_collected 应为 0`);
    assert(Number(gContract.released_amount) === 0, `新合约 released_amount 应为 0`);
    assertNear(gTx.total_amount, G_AMOUNT + gInterestAgreed + gFee, 0.011, `【C】total_amount 应含担保费（P+I+F=${round2(G_AMOUNT + gInterestAgreed + gFee)}）`);
    const bAfterLock = await getUser(bId);
    assertNear(Number(bAfterLock.frozen_balance), Number(bPreBorrow.frozen_balance || 0) + G_AMOUNT, 0.011, '担保人 frozen 未增加担保额度');
    const poolAfterBorrow = await checkInvariants('①借款后');
    assertNear(poolAfterBorrow.LA, poolPreBorrow.LA + G_AMOUNT, 0.011, '借款后 LA 增量不符');

    // ①-d 部分还款 300（验 G 增量释放、C 未收fee）
    const PARTIAL = 300;
    const nowPartial = Date.now();
    const actualDaysAll = daysBetween(new Date(gTx.created_at).getTime(), nowPartial); // 借款当天=1
    const finalInterestAtPartial = Math.min(loanCalcInterest(G_AMOUNT, actualDaysAll, credit700), gInterestAgreed);
    const totalRepaymentFull = round2(G_AMOUNT + finalInterestAtPartial); // 无费口径（服务端先算本金+利息）
    const paidInterest = Math.min(PARTIAL, finalInterestAtPartial);
    const paidPrincipal = round2(PARTIAL - paidInterest);
    const remainingPrincipal = round2(G_AMOUNT - paidPrincipal);
    const daysRemaining = Math.max(1, Math.ceil((new Date(gTx.due_date).getTime() - nowPartial) / 86400000));
    const originalDailyRate = gInterestAgreed / (G_AMOUNT * G_TERM);
    const remainingInterest = round2(remainingPrincipal * daysRemaining * originalDailyRate);
    const newTotalAmount = round2(remainingPrincipal + remainingInterest + gFee);
    console.log(`  部分还款${PARTIAL}：利息${paidInterest} 本金${paidPrincipal} 剩余本金${remainingPrincipal} 剩余利息${remainingInterest} 新总额(含F)${newTotalAmount}（参考全额无费口径=${totalRepaymentFull}）`);

    const poolPrePartial = await checkInvariants('①部分还款前');
    const aPrePartial = await getUser(aId);
    const bPrePartial = await getUser(bId);
    await post(userA, '/loan/repay', {
      userId: aId,
      transactionId: gTxId,
      partialAmount: PARTIAL,
      creditProof: { id: proofA.id },
      verificationCode: proofA.verificationCode,
      signature: repaySig(userA, gTxId, proofA)
    });

    const contractAfterPartial = await getContract(contractId);
    const targetRelease = round2(G_AMOUNT * Math.min(1, paidPrincipal / G_AMOUNT));
    assertNear(Number(contractAfterPartial.released_amount), targetRelease, 0.011,
      `【G】部分还款后 released_amount 应为累计已还本金比例目标 ${targetRelease}`);
    assert(Number(contractAfterPartial.fee_collected) === 0, `【C】部分还款不应代收担保费（fee_collected 仍应为 0）`);
    assert(contractAfterPartial.status === 'ACTIVE', '部分还款后合约应保持 ACTIVE');
    const bAfterPartial = await getUser(bId);
    assertNear(Number(bAfterPartial.frozen_balance), Number(bPrePartial.frozen_balance || 0) - targetRelease, 0.011, '部分还款后担保人 frozen 未按增量释放');
    assertNear(Number(bAfterPartial.balance) - Number(bPrePartial.balance), targetRelease, 0.011, '部分还款后担保人 balance 增量应等于释放额');
    const aAfterPartial = await getUser(aId);
    assertNear(Number(aAfterPartial.balance), Number(aPrePartial.balance) - PARTIAL, 0.011, '借款人部分还款扣款不符');
    const poolAfterPartial = await checkInvariants('①部分还款后');
    assertNear(poolAfterPartial.LA, poolPrePartial.LA - paidPrincipal, 0.011, '部分还款后 LA 减量应等于已还本金');

    // ①-e 全额还款（剩余部分）——断言 −(P+I+F)、0.7F+loyalty、0.1F、PC 净 +0.2F−loyalty、COMPLETED+fee_collected=1
    const remainingTx = require('../dao/transactionDao');
    const txAfterPartial = await remainingTx.findById(gTxId);
    const P2 = round2(Number(txAfterPartial.amount));
    const actualDays2 = daysBetween(new Date(txAfterPartial.created_at).getTime(), Date.now());
    const actualInterest2 = loanCalcInterest(P2, actualDays2, credit700);
    const finalInterest2 = Math.min(actualInterest2, round2(Number(txAfterPartial.interest)));
    const fullPayTotal = round2(P2 + finalInterest2 + gFee);
    console.log(`  全额还款：P2=${P2} I2=${finalInterest2} F=${gFee} 合计=${fullPayTotal}`);

    const poolPreFull = await checkInvariants('①全额还款前');
    const aPreFull = await getUser(aId);
    const bPreFull = await getUser(bId);
    await post(userA, '/loan/repay', {
      userId: aId,
      transactionId: gTxId,
      creditProof: { id: proofA.id },
      verificationCode: proofA.verificationCode,
      signature: repaySig(userA, gTxId, proofA)
    });

    const contractFinal = await getContract(contractId);
    assert(contractFinal.status === 'COMPLETED', `【C】全额还款后合约应 COMPLETED，实为 ${contractFinal.status}`);
    assert(Number(contractFinal.fee_collected) === 1, `【C】全额还款后 fee_collected 应为 1`);
    assertNear(Number(contractFinal.released_amount), G_AMOUNT, 0.011, `合约完成时 released_amount 应累计至全额 ${G_AMOUNT}`);

    const aFinal = await getUser(aId);
    const bFinal = await getUser(bId);
    const aDelta = Number(aFinal.balance) - Number(aPreFull.balance);
    const bBalDelta = Number(bFinal.balance) - Number(bPreFull.balance);
    const bFrozenDelta = Number(bFinal.frozen_balance) - Number(bPreFull.frozen_balance || 0);
    assertNear(aDelta, -(P2 + finalInterest2 + gFee) + round2(gFee * 0.10), 0.011,
      `【C】借款人净变动应为 −(P+I+F)+0.1F = ${round2(-(P2 + finalInterest2 + gFee) + gFee * 0.10)}`);
    assertNear(bBalDelta, round2(gFee * 0.70) + gLoyalty + round2(G_AMOUNT - Number(contractAfterPartial.released_amount)), 0.011,
      `【C/G】担保人 balance 增量应为 0.7F+loyalty+剩余解冻额度`);
    assertNear(bFrozenDelta, -(G_AMOUNT - Number(contractAfterPartial.released_amount)), 0.011, `【G】担保人 frozen 应解冻剩余额度`);

    const poolAfterFull = await checkInvariants('①全额还款后');
    const pcDelta = poolAfterFull.PC - poolPreFull.PC;
    const laDelta = poolAfterFull.LA - poolPreFull.LA;
    assertNear(laDelta, -P2, 0.011, `【G】全额还款后 LA 减量应为剩余本金 ${P2}`);
    // PC 增量 = 归还两池的本息 + 费净留存(0.2F−loyalty)。借款比例从 transactions 读取
    const [ratioRows] = await db.query('SELECT borrow_platform_ratio FROM transactions WHERE id = ?', [gTxId]);
    const platformRatio = Number(ratioRows[0].borrow_platform_ratio);
    const expectPcDelta = round2(P2 * platformRatio + finalInterest2 * platformRatio + (round2(gFee * 0.20) - gLoyalty));
    assertNear(pcDelta, expectPcDelta, 0.02,
      `【C】PC 净增量应为 本息×平台比例 + (0.2F−loyalty) = ${expectPcDelta}（其中费净留存 ${round2(gFee * 0.20) - gLoyalty}）`);
    console.log(`  借款人 Δ=${round2(aDelta)} 担保人 Δbal=${round2(bBalDelta)} Δfrozen=${round2(bFrozenDelta)} PC Δ=${round2(pcDelta)} LA Δ=${round2(laDelta)}`);
  });

  // ═══════════════ 场景② 押金借款（D/I） ═══════════════
  await runScenario('场景② 押金模式：低押金拒绝(I)→正常借款(margin_rate)→还款释放利息有源(D)', async () => {
    const M_AMOUNT = 1000;
    const mRate = marginRateOf(700, 30);
    const mMargin = round2(M_AMOUNT * mRate);
    const mInterestAgreed = poolCalcInterest(M_AMOUNT, 30, 700, 1); // 押金模式无85折
    console.log(`  费率=${mRate} 押金=${mMargin} 借款利息=${mInterestAgreed}`);

    // ②-a 低于计算值的押金 → 400（I）
    const lowMargin = round2(mMargin - 10);
    const lowBody = {
      userId: aId, amount: M_AMOUNT, term: 30, risk_mode: 1, margin_amount: lowMargin,
      creditProof: { id: proofA.id, proof: proofA.proof, publicSignals: proofA.publicSignals },
      verificationCode: proofA.verificationCode,
      signature: borrowSig(userA, M_AMOUNT, proofA)
    };
    const lowResp = await axios.post(`${API}/loan/borrow`, lowBody, {
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${userA.jwt}`, ...financialHeaders(userA, lowBody) },
      validateStatus: () => true, timeout: 30000
    });
    if (lowResp.status !== 400) {
      fail(`【I】押金 ${lowMargin} 低于要求 ${mMargin} 应返回 400，实得 ${lowResp.status}：${JSON.stringify(lowResp.data).slice(0, 200)}`);
    }
    assert(String(lowResp.data.message || '').includes('押金金额不足'), `【I】400 消息应说明押金金额不足：${lowResp.data.message}`);
    console.log(`  低押金 ${lowMargin} 被拒（I 通过）：${lowResp.data.message}`);

    // ②-b 正常借款
    const poolPreMarginBorrow = await checkInvariants('②借款前');
    const aPreMarginBorrow = await getUser(aId);
    const mBorrowBody = {
      userId: aId, amount: M_AMOUNT, term: 30, risk_mode: 1, margin_amount: mMargin,
      creditProof: { id: proofA.id, proof: proofA.proof, publicSignals: proofA.publicSignals },
      verificationCode: proofA.verificationCode,
      signature: borrowSig(userA, M_AMOUNT, proofA)
    };
    const mBorrow = await post(userA, '/loan/borrow', mBorrowBody);
    assert(mBorrow.success && mBorrow.marginOrderId, `押金借款失败：${JSON.stringify(mBorrow).slice(0, 300)}`);
    const mTxId = mBorrow.transaction.id;
    const marginOrderId = mBorrow.marginOrderId;
    const mOrder = await getMarginOrder(marginOrderId);
    assert(mOrder && mOrder.status === 'FROZEN', '押金订单应 FROZEN');
    assertNear(Number(mOrder.margin_rate), mRate, 0.0001, `【I】订单 margin_rate 应为计算费率 ${mRate}（实为 ${mOrder.margin_rate}）`);
    assert(Number(mOrder.loan_id) === mTxId, '押金订单应关联借款');
    const aAfterMarginBorrow = await getUser(aId);
    // 借款入账（+M_AMOUNT）与押金冻结（−mMargin）同时发生：净变动 = 入账 − 押金
    assertNear(Number(aAfterMarginBorrow.balance), Number(aPreMarginBorrow.balance) + M_AMOUNT - mMargin, 0.011, '押金冻结后余额应 = 借款入账 − 押金');
    assertNear(Number(aAfterMarginBorrow.frozen_balance), Number(aPreMarginBorrow.frozen_balance || 0) + mMargin, 0.011, '押金冻结后 frozen 应增加');
    const poolAfterMarginBorrow = await checkInvariants('②借款后');

    // ②-c 把押金订单 created_at 拨回 1000 天，制造非平凡冻结期利息
    await db.execute('UPDATE risk_margin_orders SET created_at = NOW() - INTERVAL 1000 DAY WHERE id = ?', [marginOrderId]);
    const [orderRows] = await db.query('SELECT created_at FROM risk_margin_orders WHERE id = ?', [marginOrderId]);
    const freezeDays = daysBetween(new Date(orderRows[0].created_at).getTime(), Date.now());
    const freezeInterest = round2(mMargin * (parseFloat(process.env.MARGIN_INTEREST_RATE) || 0.0035) * freezeDays / 365);
    console.log(`  冻结期拨回 ${freezeDays} 天，预期冻结期利息=${freezeInterest}`);

    // ②-d 全额还款（验 D：利息从 PC 支付）
    const poolPreMarginRepay = await checkInvariants('②还款前');
    const aPreMarginRepay = await getUser(aId);
    const mFinalInterest = Math.min(loanCalcInterest(M_AMOUNT, daysBetween(new Date(mBorrow.transaction.created_at).getTime(), Date.now()), 700), mInterestAgreed);
    await post(userA, '/loan/repay', {
      userId: aId, transactionId: mTxId,
      creditProof: { id: proofA.id },
      verificationCode: proofA.verificationCode,
      signature: repaySig(userA, mTxId, proofA)
    });

    const mOrderAfter = await getMarginOrder(marginOrderId);
    assert(mOrderAfter.status === 'RELEASED', `押金订单应 RELEASED，实为 ${mOrderAfter.status}`);
    assertNear(Number(mOrderAfter.frozen_interest), freezeInterest, 0.02,
      `【D】frozen_interest 应等于冻结期利息 ${freezeInterest}（实为 ${mOrderAfter.frozen_interest}）`);
    const poolAfterMarginRepay = await checkInvariants('②还款后');
    // 【D】PC 净变 = 归还本息的平台份额 − 支付冻结期利息（利息由 PC 支付，有源）
    const [mRatioRows] = await db.query('SELECT borrow_platform_ratio FROM transactions WHERE id = ?', [mTxId]);
    const mPlatformRatio = Number(mRatioRows[0].borrow_platform_ratio);
    const expectPcNet = round2(round2(M_AMOUNT * mPlatformRatio) + round2(mFinalInterest * mPlatformRatio) - freezeInterest);
    assertNear(poolAfterMarginRepay.PC, poolPreMarginRepay.PC + expectPcNet, 0.02,
      `【D】PC 净变应为 本息×平台比例−冻结期利息 = ${expectPcNet}（实变 ${round2(poolAfterMarginRepay.PC - poolPreMarginRepay.PC)}）`);
    const aAfterMarginRepay = await getUser(aId);
    const mFinalTotal = round2(M_AMOUNT + mFinalInterest);
    assertNear(Number(aAfterMarginRepay.balance), Number(aPreMarginRepay.balance) - mFinalTotal + mMargin + Number(mOrderAfter.frozen_interest), 0.02,
      `押金借款人净变动应为 −(P+I)+押金+利息`);
    // 押金释放后 frozen 应复原到借款前水平（本笔押金已解冻；①场景遗留的担保冻结不受影响）
    assertNear(Number(aAfterMarginRepay.frozen_balance), Number(aPreMarginBorrow.frozen_balance || 0), 0.011, '押金释放后 frozen 应复原到借款前水平');
    console.log(`  押金订单 RELEASED，frozen_interest=${mOrderAfter.frozen_interest}，PC 支付一致（D 通过）`);
  });

  // ═══════════════ 场景③ 普通借款逾期→罚息还款（A） ═══════════════
  await runScenario('场景③ 普通借款：due_date 改过去→标记逾期(A)→罚息还款', async () => {
    const O_AMOUNT = 500;
    const oBorrow = await post(userA, '/loan/borrow', {
      userId: aId, amount: O_AMOUNT, term: 30, risk_mode: 0,
      creditProof: { id: proofA.id, proof: proofA.proof, publicSignals: proofA.publicSignals },
      verificationCode: proofA.verificationCode,
      signature: borrowSig(userA, O_AMOUNT, proofA)
    });
    assert(oBorrow.success, `普通借款失败：${JSON.stringify(oBorrow).slice(0, 200)}`);
    const oTxId = oBorrow.transaction.id;
    const oInterestAgreed = poolCalcInterest(O_AMOUNT, 30, 700, 0);
    await db.execute('UPDATE transactions SET due_date = NOW() - INTERVAL 1 DAY WHERE id = ?', [oTxId]);

    // 直调 checkOverdueLoans（独立进程内 require）
    const { checkOverdueLoans } = require('../services/overdueService');
    const overdueResult = await checkOverdueLoans();
    console.log(`  checkOverdueLoans: ${JSON.stringify(overdueResult)}`);
    assert(await getTxStatus(oTxId) === 'overdue', `【A】checkOverdueLoans 后借款应为 overdue，实为 ${await getTxStatus(oTxId)}`);

    // 逾期还款（A：修复前 loan.js 状态闸门拒绝 status!=='pending'；修复后允许 overdue 走全额路径收罚息）
    const poolPreOverdueRepay = await checkInvariants('③还款前');
    const aPreOverdueRepay = await getUser(aId);
    const oDaysLate = Math.max(0, Math.floor((Date.now() - (Date.now() - 86400000)) / 86400000)); // 1
    const oPenalty = loanCalcInterest(O_AMOUNT, oDaysLate, 700, true, oDaysLate);
    const oFinalInterest = round2(oInterestAgreed + oPenalty);
    const penaltyMultiplier = dynamicConfig.getOverduePenaltyRate(oDaysLate);
    console.log(`  逾期${oDaysLate}天 罚息倍数=${penaltyMultiplier} 罚息=${oPenalty} 总利息=${oFinalInterest}`);
    await post(userA, '/loan/repay', {
      userId: aId, transactionId: oTxId,
      creditProof: { id: proofA.id },
      verificationCode: proofA.verificationCode,
      signature: repaySig(userA, oTxId, proofA)
    });
    assert(await getTxStatus(oTxId) === 'completed', `逾期还款后状态应 completed，实为 ${await getTxStatus(oTxId)}`);
    const aAfterOverdueRepay = await getUser(aId);
    const expectOverduePay = round2(O_AMOUNT + oFinalInterest);
    assertNear(Number(aAfterOverdueRepay.balance), Number(aPreOverdueRepay.balance) - expectOverduePay, 0.02,
      `【A】逾期还款扣款应含罚息 ${expectOverduePay}`);
    // 罚息公式与 dynamicConfig 倍数一致性
    const manualPenalty = round2(O_AMOUNT * ((6.0 / 100) / 365) * oDaysLate * penaltyMultiplier);
    assertNear(oPenalty, manualPenalty, 0.011, `罚息应等于 本金×日利率×逾期天数×${penaltyMultiplier}`);
    const poolAfterOverdueRepay = await checkInvariants('③还款后');
    assertNear(poolAfterOverdueRepay.LA, poolPreOverdueRepay.LA - O_AMOUNT, 0.011, '逾期还款后 LA 减量不符');
    console.log(`  逾期还款成功：扣款 ${expectOverduePay}（A 通过）`);
  });

  // ═══════════════ 场景④ 违约清算（B） ═══════════════
  await runScenario('场景④ 逾期16天：担保代偿+押金没收→liquidateOverdueLoans 核销', async () => {
    // ④-a 新担保邀约 + 借款 800
    const L_AMOUNT = 800;
    const req2 = await post(userA, '/guarantee/request', {
      guarantorId: bId,
      loanAmount: L_AMOUNT,
      borrowerSignature: signWithSM2(
        buildSignatureData({ borrowerId: String(aId), guarantorId: String(bId), loanAmount: String(L_AMOUNT) }, ['borrowerId', 'guarantorId', 'loanAmount']),
        userA.privKey
      ),
      creditProof: { id: proofA.id },
      verificationCode: proofA.verificationCode
    });
    let requestId2 = req2.requestId;
    if (requestId2 === undefined) {
      // RED 诊断兜底：L bug 导致响应缺 requestId 时，从库取本借款人最新邀约继续，
      // 使本场景后续【B】断言可达（GREEN 时 L 已修复，永远走不到这里）。
      const [gr] = await db.query('SELECT id FROM guarantee_requests WHERE borrower_id = ? ORDER BY id DESC LIMIT 1', [aId]);
      requestId2 = gr[0] ? gr[0].id : undefined;
      console.log(`  [RED 诊断] 响应缺 requestId（L bug），DB 兜底邀约 id=${requestId2}`);
    }
    assert(requestId2 !== undefined, '【L】邀约 requestId 缺失且 DB 兜底失败');
    // accept 签名原文按服务端现实口径（DECIMAL 两位小数，缺陷 M）构造，见场景①注释
    await post(userB, `/guarantee/accept/${requestId2}`, {
      guarantorSignature: signWithSM2(
        buildSignatureData({ requestId: String(requestId2), guarantorId: String(bId), loanAmount: Number(L_AMOUNT).toFixed(2) }, ['guarantorId', 'loanAmount', 'requestId']),
        userB.privKey
      )
    });
    const lBorrow = await post(userA, '/loan/borrow', {
      userId: aId, amount: L_AMOUNT, term: 30, risk_mode: 2, guarantee_request_id: requestId2,
      creditProof: { id: proofA.id, proof: proofA.proof, publicSignals: proofA.publicSignals },
      verificationCode: proofA.verificationCode,
      signature: borrowSig(userA, L_AMOUNT, proofA)
    });
    assert(lBorrow.success, `担保借款(800)失败：${JSON.stringify(lBorrow).slice(0, 200)}`);
    const lTxId = lBorrow.transaction.id;
    const lContractId = lBorrow.guaranteeContractId;
    const lInterestAgreed = poolCalcInterest(L_AMOUNT, 30, 700, 2);

    // ④-b 押金借款 600
    const N_AMOUNT = 600;
    const nMargin = round2(N_AMOUNT * marginRateOf(700, 30));
    const nBorrow = await post(userA, '/loan/borrow', {
      userId: aId, amount: N_AMOUNT, term: 30, risk_mode: 1, margin_amount: nMargin,
      creditProof: { id: proofA.id, proof: proofA.proof, publicSignals: proofA.publicSignals },
      verificationCode: proofA.verificationCode,
      signature: borrowSig(userA, N_AMOUNT, proofA)
    });
    assert(nBorrow.success, `押金借款(600)失败：${JSON.stringify(nBorrow).slice(0, 200)}`);
    const nTxId = nBorrow.transaction.id;
    const nOrderId = nBorrow.marginOrderId;
    const nInterestAgreed = poolCalcInterest(N_AMOUNT, 30, 700, 1);

    // ④-c due_date 拨回 16 天 → 标记逾期 → 清算
    await db.execute('UPDATE transactions SET due_date = NOW() - INTERVAL 16 DAY WHERE id IN (?, ?)', [lTxId, nTxId]);
    const { checkOverdueLoans } = require('../services/overdueService');
    await checkOverdueLoans();
    assert(await getTxStatus(lTxId) === 'overdue' && await getTxStatus(nTxId) === 'overdue', '两笔借款应已标记 overdue');

    const overdueService = require('../services/overdueService');
    assert(typeof overdueService.liquidateOverdueLoans === 'function', `【B】overdueService 未导出 liquidateOverdueLoans`);
    const poolPreLiquidate = await checkInvariants('④清算前');
    const aPreLiq = await getUser(aId);
    const bPreLiq = await getUser(bId);

    // 清算数学预期：outstanding = P + agreed + 罚息(16天, 倍数按 dynamicConfig)
    const lPenalty = loanCalcInterest(L_AMOUNT, 16, 700, true, 16);
    const lOutstanding = round2(L_AMOUNT + lInterestAgreed + lPenalty);
    const nPenalty = loanCalcInterest(N_AMOUNT, 16, 700, true, 16);
    const nOutstanding = round2(N_AMOUNT + nInterestAgreed + nPenalty);
    console.log(`  担保贷款 outstanding=${lOutstanding}（押金没收另计 ${nMargin}），押金贷款 outstanding=${nOutstanding}、没收=${nMargin}`);

    const liqResult = await overdueService.liquidateOverdueLoans();
    console.log(`  liquidateOverdueLoans: ${JSON.stringify(liqResult)}`);
    assert(liqResult.liquidated >= 2, `【B】应至少清算 2 笔，实为 ${JSON.stringify(liqResult)}`);

    assert(await getTxStatus(lTxId) === 'liquidated', `【B】担保贷款应 liquidated，实为 ${await getTxStatus(lTxId)}`);
    assert(await getTxStatus(nTxId) === 'liquidated', `【B】押金贷款应 liquidated，实为 ${await getTxStatus(nTxId)}`);
    const lContractAfter = await getContract(lContractId);
    assert(lContractAfter.status === 'LIQUIDATED', `【B】担保合约应 LIQUIDATED，实为 ${lContractAfter.status}`);
    const nOrderAfter = await getMarginOrder(nOrderId);
    assert(nOrderAfter.status === 'LIQUIDATED', `【B】押金订单应 LIQUIDATED，实为 ${nOrderAfter.status}`);

    const aAfterLiq = await getUser(aId);
    const bAfterLiq = await getUser(bId);
    assertNear(Number(bAfterLiq.frozen_balance), Number(bPreLiq.frozen_balance || 0) - L_AMOUNT, 0.011, `【B】担保人 frozen 应扣减担保额度 ${L_AMOUNT}`);
    // 担保人 balance 扣减 = outstanding − 冻结承担部分；冻结只承担担保额度 G（利息从余额补足）
    const bFrozenBefore = Number(bPreLiq.frozen_balance || 0);
    const fromFrozen = Math.min(bFrozenBefore, L_AMOUNT);
    const fromBalance = round2(lOutstanding - fromFrozen);
    assertNear(Number(bAfterLiq.balance), Number(bPreLiq.balance) - fromBalance, 0.011,
      `【B】担保人 balance 应补足代偿差额 ${fromBalance}`);
    assertNear(Number(aAfterLiq.frozen_balance), Number(aPreLiq.frozen_balance || 0) - nMargin, 0.011, `【B】押金人 frozen 应被没收 ${nMargin}`);
    // 押金借款人 balance 不变（没收的是冻结额）
    assertNear(Number(aAfterLiq.balance), Number(aPreLiq.balance), 0.011, `【B】清算不应动押金人可用余额`);

    const poolAfterLiq = await checkInvariants('④清算后');
    // 资本口径：核销本金本已计入资本，回收现金（代偿+没收押金）替代债权 → PC 净变 = 回收 − 核销本金（平台承担违约净损失）
    const expectPcLiq = round2(poolPreLiquidate.PC + lOutstanding + nMargin - L_AMOUNT - N_AMOUNT);
    assertNear(poolAfterLiq.PC, expectPcLiq, 0.02,
      `【B】PC 净变应为 担保代偿${lOutstanding}+押金没收${nMargin}−核销本金${L_AMOUNT + N_AMOUNT}（实变 ${round2(poolAfterLiq.PC - poolPreLiquidate.PC)}）`);
    const expectLaLiq = round2(poolPreLiquidate.LA - L_AMOUNT - N_AMOUNT);
    assertNear(poolAfterLiq.LA, expectLaLiq, 0.02, `【B】LA 应核销两笔剩余本金 ${L_AMOUNT + N_AMOUNT}`);
    // 担保人信用分：700 基础 +2 担保成功奖励（场景①全额还清触发） −10 担保代偿惩戒（本场景）= 692
    const bScoreAfter = Number((await getUser(bId)).credit_score);
    assertNear(bScoreAfter, 692, 0.001, `【B】担保人信用分应 700+2(①担保成功)−10(代偿惩戒)=692，实为 ${bScoreAfter}`);
    console.log(`  清算完成：PC Δ=+${round2(poolAfterLiq.PC - poolPreLiquidate.PC)} LA Δ=${round2(poolAfterLiq.LA - poolPreLiquidate.LA)}（B 通过）`);
  });

  // ═══════════════ 场景⑤ 出资/赎回（E/K） ═══════════════
  await runScenario('场景⑤-a userB 出资1000→借款200→还款（利息计入 UC/UIE）', async () => {
    const poolPreInvest = await checkInvariants('⑤出资前');
    await post(userB, '/invest', {
      userId: bId, amount: 1000, term: 30,
      creditProof: { id: proofB.id },
      verificationCode: proofB.verificationCode,
      signature: signWithSM2(
        buildSignatureData({ userId: String(bId), amount: 1000, term: 30, creditProofId: proofB.id }, ['amount', 'creditProofId', 'term', 'userId']),
        userB.privKey
      )
    });
    const poolAfterInvest = await checkInvariants('⑤出资后');
    assertNear(poolAfterInvest.UC, poolPreInvest.UC + 1000, 0.011, '出资后 UC 应 +1000');

    // userB 借 200（从 UC 出），还款后利息计入 UC（E 的前提：还款时把利息记入 UC）
    const ubBorrow = await post(userB, '/loan/borrow', {
      userId: bId, amount: 200, term: 30, risk_mode: 0,
      creditProof: { id: proofB.id, proof: proofB.proof, publicSignals: proofB.publicSignals },
      verificationCode: proofB.verificationCode,
      signature: borrowSig(userB, 200, proofB)
    });
    assert(ubBorrow.success, `userB 借款失败：${JSON.stringify(ubBorrow).slice(0, 200)}`);
    const ubTxId = ubBorrow.transaction.id;
    const ubInterestAgreed = poolCalcInterest(200, 30, 700, 0);
    const [ubRatioRows] = await db.query('SELECT borrow_user_ratio FROM transactions WHERE id = ?', [ubTxId]);
    const ubUserRatio = Number(ubRatioRows[0].borrow_user_ratio);
    const poolPreUbRepay = await checkInvariants('⑤还款前');
    await post(userB, '/loan/repay', {
      userId: bId, transactionId: ubTxId,
      creditProof: { id: proofB.id },
      verificationCode: proofB.verificationCode,
      signature: repaySig(userB, ubTxId, proofB)
    });
    const poolAfterUbRepay = await checkInvariants('⑤还款后');
    const ubFinalInterest = Math.min(loanCalcInterest(200, daysBetween(new Date(ubBorrow.transaction.created_at).getTime(), Date.now()), 700), ubInterestAgreed);
    // 资本口径：还本只核减 LA（债权→现金，资本不变），UC 仅增加利息的用户池份额
    const expectUcGain = round2(ubFinalInterest * ubUserRatio);
    assertNear(poolAfterUbRepay.UC - poolPreUbRepay.UC, expectUcGain, 0.02,
      `【E】还款后 UC 增量应为利息 × 用户池比例 = ${expectUcGain}（本金不重复计入资本）`);
    const expectUieGain = round2(ubFinalInterest * ubUserRatio);
    assertNear(poolAfterUbRepay.UIE - poolPreUbRepay.UIE, expectUieGain, 0.02, `【E】user_interest_earned 应计入应付利息 ${expectUieGain}`);
  });

  await runScenario('场景⑤-b userB 赎回100（利息有源，UC 减 amount+actualInterest）', async () => {
    const poolPreRedeem = await checkInvariants('⑤赎回前');
    const uieBefore = poolPreRedeem.UIE;
    const bPreRedeem = await getUser(bId);
    const annualLending = await getCurrentLendingRate();
    const redeemInterestDynamic = round2(100 * (annualLending / 365) * 1);
    const redeemActualInterest = Math.min(redeemInterestDynamic, uieBefore);
    console.log(`  出资年利率=${annualLending} 动态利息=${redeemInterestDynamic} 实付=${redeemActualInterest}（有源上限 UIE=${uieBefore}）`);
    await post(userB, '/redeem', {
      userId: bId, amount: 100,
      creditProof: { id: proofB.id },
      verificationCode: proofB.verificationCode,
      signature: signWithSM2(
        buildSignatureData({ userId: String(bId), amount: 100, creditProofId: proofB.id }, ['amount', 'creditProofId', 'userId']),
        userB.privKey
      )
    });
    const poolAfterRedeem = await checkInvariants('⑤赎回后');
    assertNear(poolAfterRedeem.UC, poolPreRedeem.UC - (100 + redeemActualInterest), 0.02,
      `【E/K】赎回后 UC 减量应为 100+实付利息 ${round2(100 + redeemActualInterest)}（实减 ${round2(poolPreRedeem.UC - poolAfterRedeem.UC)}）`);
    assertNear(poolAfterRedeem.UIE, uieBefore - redeemActualInterest, 0.02, `【E/K】赎回后应付利息应扣减 ${redeemActualInterest}`);
    const bAfterRedeem = await getUser(bId);
    assertNear(Number(bAfterRedeem.balance) - Number(bPreRedeem.balance), 100 + redeemActualInterest, 0.02, `【E】赎回到账应为本金+有源利息`);
    console.log(`  赎回完成：UC Δ=${round2(poolAfterRedeem.UC - poolPreRedeem.UC)}（E/K 通过）`);
  });

  // ═══════════════ 场景⑥ 并发还款冒烟（F） ═══════════════
  await runScenario('场景⑥ 同一笔贷款并发两次全额还款（Promise.all）', async () => {
    const cBorrow = await post(userA, '/loan/borrow', {
      userId: aId, amount: 300, term: 30, risk_mode: 0,
      creditProof: { id: proofA.id, proof: proofA.proof, publicSignals: proofA.publicSignals },
      verificationCode: proofA.verificationCode,
      signature: borrowSig(userA, 300, proofA)
    });
    assert(cBorrow.success, `并发用例借款失败：${JSON.stringify(cBorrow).slice(0, 200)}`);
    const cTxId = cBorrow.transaction.id;
    const cInterestAgreed = poolCalcInterest(300, 30, 700, 0);
    const poolPreConcurrent = await checkInvariants('⑥并发前');
    const aPreConcurrent = await getUser(aId);

    const repayOnce = () => post(userA, '/loan/repay', {
      userId: aId, transactionId: cTxId,
      creditProof: { id: proofA.id },
      verificationCode: proofA.verificationCode,
      signature: repaySig(userA, cTxId, proofA)
    }, null).then(
      // expectStatus=null 时 4xx/5xx body 也会正常返回：按业务 success 字段判失败
      (data) => (data && data.success === false
        ? { __failed: true, status: data.code || 'biz-fail', message: data.message }
        : data),
      (e) => ({ __failed: true, status: e.response ? e.response.status : 'network', message: e.response ? e.response.data : e.message })
    );

    // 允许任意状态码：post 传 expectStatus=null 不做断言
    const [r1, r2] = await Promise.all([repayOnce(), repayOnce()]);
    const okCount = [r1, r2].filter(r => !r.__failed).length;
    const failCount = [r1, r2].filter(r => r.__failed).length;
    if (okCount !== 1 || failCount !== 1) {
      fail(`【F】并发两笔全额还款应恰一成功（成功=${okCount} 失败=${failCount}，r1.status=${r1.status} r2.status=${r2.status}）`);
    }
    const poolAfterConcurrent = await checkInvariants('⑥并发后');
    const cFinalInterest = Math.min(loanCalcInterest(300, daysBetween(new Date(cBorrow.transaction.created_at).getTime(), Date.now()), 700), cInterestAgreed);
    assertNear(poolAfterConcurrent.LA, poolPreConcurrent.LA - 300, 0.011, `【F】LA 只应扣减一次本金`);
    const aAfterConcurrent = await getUser(aId);
    assertNear(Number(aAfterConcurrent.balance), Number(aPreConcurrent.balance) - (300 + cFinalInterest), 0.02,
      `【F】余额只应扣款一次（应扣 ${round2(300 + cFinalInterest)}）`);
    console.log(`  并发结果：1 成功 / 1 拒绝（r.status=[${r1.status || 200},${r2.status || 200}]），资金单次入账（F 通过）`);
  });

  // ═══════════════ 场景⑦ 孤儿押金订单清理（J） ═══════════════
  await runScenario('场景⑦ 孤儿押金订单清理（J：FROZEN+无主+超10分钟→RELEASED 不计息）', async () => {
    const overdueService = require('../services/overdueService');
    assert(typeof overdueService.cleanupOrphanMarginOrders === 'function',
      '【J】overdueService 未导出 cleanupOrphanMarginOrders()（计划步骤9 约定的直调入口；实现若用其它名字，同步改本行）');

    // 夹具：userA frozen_balance +200（模拟孤儿冻结在途），插入无主 FROZEN 订单（loan_id NULL、created_at 提前 11 分钟）
    const orphanAmount = 200;
    const aPreOrphan = await getUser(aId);
    const frozenBefore = Number(aPreOrphan.frozen_balance || 0);
    const balanceBefore = Number(aPreOrphan.balance);
    const [ins] = await db.execute(
      `INSERT INTO risk_margin_orders (user_id, margin_amount, margin_rate, frozen_interest, status, loan_id, created_at)
       VALUES (?, ?, 0.2000, 0, 'FROZEN', NULL, NOW() - INTERVAL 11 MINUTE)`,
      [aId, orphanAmount]
    );
    const orphanOrderId = ins.insertId;
    const frozenData = { frozen_balance: frozenBefore + orphanAmount };
    await encryptFields('users', frozenData, aId, db);
    await db.execute('UPDATE users SET frozen_balance = ? WHERE id = ?', [frozenData.frozen_balance, aId]);
    console.log(`  夹具：孤儿订单#${orphanOrderId}（${orphanAmount} 元，11 分钟前），A frozen=${frozenBefore + orphanAmount}`);

    // 直调清理（计划步骤9：超 10 分钟的 FROZEN+loan_id IS NULL → 解冻 RELEASED、不计息）
    const cleanRes = await overdueService.cleanupOrphanMarginOrders();
    console.log(`  cleanupOrphanMarginOrders: ${JSON.stringify(cleanRes)}`);

    const orphanAfter = await getMarginOrder(orphanOrderId);
    assert(orphanAfter && orphanAfter.status === 'RELEASED', `【J】孤儿订单应 RELEASED，实为 ${orphanAfter && orphanAfter.status}`);
    const aAfterOrphan = await getUser(aId);
    assertNear(Number(aAfterOrphan.frozen_balance), frozenBefore, 0.011, `【J】孤儿解冻后 frozen 应复原为 ${frozenBefore}`);
    assertNear(Number(aAfterOrphan.balance), balanceBefore + orphanAmount, 0.011, `【J】孤儿解冻应退回余额 +${orphanAmount}（不计息）`);
    await checkInvariants('⑦孤儿清理后');

    // 清现场：还原 userA 余额/冻结，删除夹具订单
    const restore = { frozen_balance: frozenBefore, balance: balanceBefore };
    await encryptFields('users', restore, aId, db);
    await db.execute('UPDATE users SET frozen_balance = ?, balance = ? WHERE id = ?', [restore.frozen_balance, restore.balance, aId]);
    await db.execute('DELETE FROM risk_margin_orders WHERE id = ?', [orphanOrderId]);
    console.log('  夹具已清理（订单删除、用户余额/冻结复原）');
  });

  // ───────────────────────────── 收尾 ─────────────────────────────
  await runScenario('终态恒等式校验', async () => {
    await checkInvariants('终态');
    const finalPool = await getPool();
    console.log(`终态池：PC=${finalPool.PC} UC=${finalPool.UC} LA=${finalPool.LA} total=${finalPool.total} avail=${finalPool.available}`);
  });

  await db.end();
  if (failures.length > 0) {
    console.error(`\n══════════ 失败清单（${failures.length} 项）══════════`);
    failures.forEach((f, i) => console.error(`${i + 1}. ${f.name}\n   └─ ${f.message}`));
    writeFailuresFile();
    console.error(`\n[FATAL] e2e 共 ${failures.length} 个场景失败，退出码 1`);
    process.exit(1);
  }
  console.log(`\n══════════ 全部场景通过 ══════════`);
  console.log(`耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log(`全程恒等式校验通过：total==PC+UC，available==total−LA，各分量非负`);
  process.exit(0);
})().catch((e) => {
  // 走到这里 = 测试基建失败（预检/注册/夹具/连接），属于环境错误而非契约红，不写清单文件
  console.error(`\n[FATAL] e2e 环境异常终止（非契约红）：${e.stack || e.message}`);
  if (db) db.end().catch(() => {});
  process.exit(1);
});
