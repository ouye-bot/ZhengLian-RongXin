/**
 * 阶段2 步骤12 补充验证（ad-hoc）
 * ─────────────────────────────────────────────────────────
 * H-1  担保贷款：partialAmount 恰 = P+I+F（totalDue）→ 走全额路径，
 *      同事务代收担保费（fee_collected=1）+ 担保结算（0.7F/0.1F）+ released_amount=G
 * H-2  押金贷款：partialAmount 恰 = P+I（实算利息口径）→ 走全额路径，押金 RELEASED + PC 付息
 * H-3  守卫：partialAmount ∈ (P+I, P+I+F) 开区间 → 400 "一次性还清需付清"
 * J    孤儿订单清理已由 finance-e2e 场景⑦覆盖（插单→直调 cleanupOrphanMarginOrders→断言解冻→清现场），
 *      本文件不重复构造。
 * 每步后校验资金池恒等式 total=PC+UC / available=total−LA / 各分量非负。
 * 运行：node backend/test/phase2-adhoc.js（后端须在线）
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });

const path = require('path');
const crypto = require('crypto');
const axios = require('axios');
const mysql = require('mysql2/promise');
const sm2 = require('sm-crypto').sm2;

const { canonicalStringify, signWithSM2, buildSignatureData } = require('../utils/cryptoUtils');
const { encryptFields } = require('../utils/sm4Crypto');
const zkService = require('../services/zkService');
const guaranteeEngine = require('../services/riskPlugins/guaranteeEngine');
const { getInterestRate: getBaseInterestRate } = require('../utils/interestRate');

const BASE = 'http://127.0.0.1:3003';
const API = `${BASE}/api/v1`;
const round2 = (x) => Math.round(x * 100) / 100;

function fail(msg) { throw new Error(`断言失败：${msg}`); }
function assert(cond, msg) { if (!cond) fail(msg); }
function assertNear(actual, expected, tolerance, msg) {
  if (Math.abs(Number(actual) - Number(expected)) > tolerance) {
    fail(`${msg}：actual=${actual}，expected=${expected}，diff=${round2(Number(actual) - Number(expected))}`);
  }
}
function poolCalcInterest(principal, days, creditScore, riskMode = 0) {
  const rates = { 750: 4.0, 700: 6.0, 650: 8.0, 600: 10.0, 300: 13.8 };
  let annual = 13.8;
  for (const s of Object.keys(rates).map(Number).sort((a, b) => b - a)) { if (creditScore >= s) { annual = rates[s]; break; } }
  const guaranteeDiscount = riskMode === 2 ? 0.85 : 1.0;
  return round2(principal * (annual / 100) * guaranteeDiscount / 365 * days);
}
function loanCalcInterest(principal, days, creditScore) {
  const rates = { 750: 4.0, 700: 6.0, 650: 8.0, 600: 10.0, 300: 13.8 };
  let annual = 13.8;
  for (const s of Object.keys(rates).map(Number).sort((a, b) => b - a)) { if (creditScore >= s) { annual = rates[s]; break; } }
  return round2(principal * (annual / 100) / 365 * days);
}
const daysBetween = (from, to) => Math.max(1, Math.ceil((to - from) / 86400000));

function financialHeaders(user, body) {
  const timestamp = String(Date.now());
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
  const resp = await axios.post(`${API}${urlPath}`, body, { headers, validateStatus: () => true, timeout: 30000 });
  if (expectStatus !== null && resp.status !== expectStatus) {
    const err = new Error(`POST ${urlPath} 期望 ${expectStatus} 实得 ${resp.status}：${JSON.stringify(resp.data).slice(0, 300)}`);
    err.response = { status: resp.status, data: resp.data };
    throw err;
  }
  return resp.data;
}

let db;
async function getPool() {
  const [rows] = await db.query('SELECT * FROM fund_pool WHERE id = 1');
  const p = rows[0];
  return { PC: parseFloat(p.platform_capital), UC: parseFloat(p.user_capital), LA: parseFloat(p.loaned_amount), total: parseFloat(p.total_amount), available: parseFloat(p.available_amount) };
}
async function checkInvariants(tag) {
  const p = await getPool();
  console.log(`  [池·${tag}] PC=${p.PC} UC=${p.UC} LA=${p.LA} total=${p.total} avail=${p.available} | Δ1=${round2(p.total - p.PC - p.UC)} Δ2=${round2(p.available - (p.total - p.LA))}`);
  if (Math.abs(p.total - p.PC - p.UC) >= 0.01) fail(`恒等式1违反（${tag}）`);
  if (Math.abs(p.available - (p.total - p.LA)) >= 0.01) fail(`恒等式2违反（${tag}）`);
  for (const [k, v] of Object.entries({ PC: p.PC, UC: p.UC, LA: p.LA, available: p.available })) {
    if (v < -0.005) fail(`资金池字段为负（${tag}）：${k}=${v}`);
  }
  return p;
}
async function getUser(userId) { return require('../dao/userDao').findById(String(userId)); }
async function getContract(id) { const [r] = await db.query('SELECT * FROM risk_guarantee_contracts WHERE id = ?', [id]); return r[0] || null; }
async function getMarginOrder(id) { const [r] = await db.query('SELECT * FROM risk_margin_orders WHERE id = ?', [id]); return r[0] || null; }

(async () => {
  const t0 = Date.now();
  const failures = [];
  const run = async (name, fn) => {
    console.log(`\n== ${name}`);
    try { await fn(); console.log(`  ✅ ${name} —— 通过`); }
    catch (e) { failures.push(`${name} :: ${(e && e.message) || e}`); console.error(`  ❌ [FAIL] ${name}\n     ${(e && e.message) || e}`); }
  };

  // 预检
  const health = await axios.get(`${BASE}/health`, { timeout: 5000 });
  assert(health.data && health.data.status === 'ok', '后端不在线');
  db = await mysql.createConnection({ host: '127.0.0.1', port: 3307, user: process.env.DB_USER || 'finzktrust', password: process.env.DB_PASSWORD || process.env.DB_PASS, database: process.env.DB_NAME || 'finzktrust' });
  console.log('预检：后端在线、数据库可达');

  // 用户与夹具
  const ts = Date.now();
  const kpA = sm2.generateKeyPairHex();
  const kpB = sm2.generateKeyPairHex();
  async function register(kp, tag) {
    const resp = await axios.post(`${API}/auth/register`, { username: `adhoc_${tag}_${ts}`, password: 'E2ePassw0rd', sm2PublicKey: kp.publicKey }, { validateStatus: () => true, timeout: 15000 });
    if (resp.status !== 200 || !resp.data.success) throw new Error(`注册失败：${JSON.stringify(resp.data).slice(0, 200)}`);
    const id = resp.data.user.id;
    const login = await axios.post(`${API}/auth/login`, { username: `adhoc_${tag}_${ts}`, password: 'E2ePassw0rd' }, { validateStatus: () => true, timeout: 15000 });
    const user = { id, jwt: login.data.token, privKey: kp.privateKey };
    const data = { balance: 5000, credit_score: 700 };
    await encryptFields('users', data, id, db);
    await db.execute('UPDATE users SET balance=?, credit_score=?, created_at = NOW() - INTERVAL 30 DAY WHERE id=?', [data.balance, data.credit_score, id]);
    return user;
  }
  const userA = await register(kpA, 'a');
  const userB = await register(kpB, 'b');
  console.log(`借款人 A#${userA.id} 担保人 B#${userB.id}（夹具 5000/700）`);

  async function makeProof(user) {
    // 阈值 600 = 服务端强核的借款准入阈值（credit.js PROOF_REQUIRED_THRESHOLD），非 600 会被 /credit/generate-proof 拒绝
    const zk = await zkService.generateProof(700, 600, 1);
    const body = { userId: user.id, proof: zk.proof, publicSignals: zk.publicSignals, signature: signWithSM2(JSON.stringify({ userId: String(user.id), creditScore: 700 }), user.privKey) };
    const data = await post(user, '/credit/generate-proof', body);
    const p = data.data && data.data.proof ? data.data.proof : data;
    return { id: p.proofId, verificationCode: p.verificationCode, proof: zk.proof, publicSignals: zk.publicSignals };
  }
  const proofA = await makeProof(userA);
  const proofB = await makeProof(userB);
  const borrowSig = (user, amount, proof) => signWithSM2(buildSignatureData({ userId: String(user.id), amount: parseInt(amount), creditProofId: proof.id }, ['amount', 'creditProofId', 'userId']), user.privKey);
  const repaySig = (user, txId, proof) => signWithSM2(buildSignatureData({ userId: String(user.id), transactionId: txId, creditProofId: proof.id }, ['creditProofId', 'transactionId', 'userId']), user.privKey);

  // ── 公共步骤：担保邀约→接受→借款 ──
  async function guaranteeBorrow(amount) {
    const reqBody = {
      guarantorId: userB.id, loanAmount: amount,
      borrowerSignature: signWithSM2(buildSignatureData({ borrowerId: String(userA.id), guarantorId: String(userB.id), loanAmount: String(amount) }, ['borrowerId', 'guarantorId', 'loanAmount']), userA.privKey),
      creditProof: { id: proofA.id }, verificationCode: proofA.verificationCode
    };
    const reqData = await post(userA, '/guarantee/request', reqBody);
    assert(reqData.requestId !== undefined, '邀约 requestId 缺失');
    await post(userB, `/guarantee/accept/${reqData.requestId}`, {
      guarantorSignature: signWithSM2(buildSignatureData({ requestId: String(reqData.requestId), guarantorId: String(userB.id), loanAmount: Number(amount).toFixed(2) }, ['guarantorId', 'loanAmount', 'requestId']), userB.privKey)
    });
    const borrowData = await post(userA, '/loan/borrow', {
      userId: userA.id, amount, term: 30, risk_mode: 2, guarantee_request_id: reqData.requestId,
      creditProof: { id: proofA.id, proof: proofA.proof, publicSignals: proofA.publicSignals },
      verificationCode: proofA.verificationCode, signature: borrowSig(userA, amount, proofA)
    });
    assert(borrowData.success && borrowData.transaction, `担保借款失败：${JSON.stringify(borrowData).slice(0, 200)}`);
    return { txId: borrowData.transaction.id, contractId: borrowData.guaranteeContractId, transaction: borrowData.transaction };
  }

  const G_AMOUNT = 1000;
  const gFeeInfo = guaranteeEngine.calculateGuaranteeFee(G_AMOUNT, getBaseInterestRate(700) / 100, 0);
  const gFee = round2(gFeeInfo.feeAmount);
  const gLoyalty = round2(gFeeInfo.loyaltyBonus);

  // ══ H-1：担保贷款 partialAmount 恰 = P+I+F ══
  await run('H-1 担保贷款部分还款额恰=应还总额（P+I+F）→ 全额路径收 F + 结算', async () => {
    const { txId, contractId, transaction } = await guaranteeBorrow(G_AMOUNT);
    const gInterestAgreed = poolCalcInterest(G_AMOUNT, 30, 700, 2);
    // 借款侧 total_amount = P + 约定利息（30 天口径）+ F
    assert(round2(transaction.total_amount) === round2(G_AMOUNT + gInterestAgreed + gFee),
      `借款 total_amount 应含 F（${round2(G_AMOUNT + gInterestAgreed + gFee)}），实为 ${transaction.total_amount}`);
    const finalInterest = Math.min(loanCalcInterest(G_AMOUNT, daysBetween(new Date(transaction.created_at).getTime(), Date.now()), 700), gInterestAgreed);
    const totalRepayment = round2(G_AMOUNT + finalInterest);
    const totalDue = round2(totalRepayment + gFee);

    // H-3（借用本笔）：区间 (P+I, P+I+F) 应 400
    await run('H-3 守卫：partialAmount 落在 (P+I, P+I+F) 开区间 → 400', async () => {
      const r = await post(userA, '/loan/repay', {
        userId: userA.id, transactionId: txId, partialAmount: round2(totalRepayment + 1),
        creditProof: { id: proofA.id }, verificationCode: proofA.verificationCode, signature: repaySig(userA, txId, proofA)
      }, null);
      assert(r && r.success === false, `应拒绝，实得 ${JSON.stringify(r).slice(0, 150)}`);
      assert(String(r.message || '').includes('一次性还清需付清'), `应提示付清全部应还：${r.message}`);
    });

    // 余额拨为恰 = totalDue
    const balData = { balance: totalDue };
    await encryptFields('users', balData, userA.id, db);
    await db.execute('UPDATE users SET balance=? WHERE id=?', [balData.balance, userA.id]);

    const prePool = await checkInvariants('H-1 还款前');
    const preA = await getUser(userA.id);
    const preB = await getUser(userB.id);
    const preBContract = await getContract(contractId);
    const releasedBeforeFull = Number(preBContract.released_amount || 0);
    await post(userA, '/loan/repay', {
      userId: userA.id, transactionId: txId, partialAmount: totalDue,
      creditProof: { id: proofA.id }, verificationCode: proofA.verificationCode, signature: repaySig(userA, txId, proofA)
    });

    const contract = await getContract(contractId);
    assert(contract.status === 'COMPLETED', `合约应 COMPLETED，实为 ${contract.status}`);
    assert(Number(contract.fee_collected) === 1, '【C/H】部分还款额恰等总额也应收 F（fee_collected=1）');
    assertNear(Number(contract.released_amount), G_AMOUNT, 0.011, 'released_amount 应收口至 G');
    const afterA = await getUser(userA.id);
    const afterB = await getUser(userB.id);
    assertNear(Number(afterA.balance), totalDue - totalDue + round2(gFee * 0.10), 0.02, '【C】借款人余额应≈0.1F（恰付清 P+I+F 后返还借款人奖励）');
    assertNear(Number(afterB.balance) - Number(preB.balance), round2(gFee * 0.70) + gLoyalty + round2(G_AMOUNT - releasedBeforeFull), 0.02, '【C/G】担保人应得 0.7F+loyalty+残余解冻');
    assertNear(Number(afterB.frozen_balance), Math.max(0, Number(preB.frozen_balance || 0) - G_AMOUNT), 0.011, '【G】担保人 frozen 应解除本合约额度');
    const postPool = await checkInvariants('H-1 还款后');
    const pcDelta = round2(postPool.PC - prePool.PC);
    const [ratioRows] = await db.query('SELECT borrow_platform_ratio FROM transactions WHERE id = ?', [txId]);
    const pr = Number(ratioRows[0].borrow_platform_ratio);
    assertNear(pcDelta, round2(round2(G_AMOUNT * pr) + round2(finalInterest * pr) + round2(round2(gFee * 0.20) - gLoyalty)), 0.02, '【C】PC 净增 = 本息×平台比例 + (0.2F−loyalty)');
  });

  // ══ H-2：押金贷款 partialAmount 恰 = P+I（实算利息）══
  await run('H-2 押金贷款部分还款额恰=本息 → 全额路径，押金 RELEASED + PC 付息', async () => {
    const M_AMOUNT = 600;
    const mRate = 0.20;
    const mMargin = round2(M_AMOUNT * mRate);
    // H-1 恰好花清了余额，先拨款保证押金冻结可用（冻结仅需 mMargin）
    const topUp = { balance: 1000 };
    await encryptFields('users', topUp, userA.id, db);
    await db.execute('UPDATE users SET balance=? WHERE id=?', [topUp.balance, userA.id]);
    const mBorrow = await post(userA, '/loan/borrow', {
      userId: userA.id, amount: M_AMOUNT, term: 30, risk_mode: 1, margin_amount: mMargin,
      creditProof: { id: proofA.id, proof: proofA.proof, publicSignals: proofA.publicSignals },
      verificationCode: proofA.verificationCode, signature: borrowSig(userA, M_AMOUNT, proofA)
    });
    assert(mBorrow.success && mBorrow.marginOrderId, `押金借款失败：${JSON.stringify(mBorrow).slice(0, 200)}`);
    const mTxId = mBorrow.transaction.id;
    const mOrderId = mBorrow.marginOrderId;
    const mOrder = await getMarginOrder(mOrderId);
    assertNear(Number(mOrder.margin_rate), mRate, 0.0001, '【I】margin_rate 应落真实费率');
    await db.execute('UPDATE risk_margin_orders SET created_at = NOW() - INTERVAL 400 DAY WHERE id = ?', [mOrderId]);
    const [oRows] = await db.query('SELECT created_at FROM risk_margin_orders WHERE id = ?', [mOrderId]);
    const freezeDays = daysBetween(new Date(oRows[0].created_at).getTime(), Date.now());
    const freezeInterest = round2(mMargin * (parseFloat(process.env.MARGIN_INTEREST_RATE) || 0.0035) * freezeDays / 365);

    const agreed = poolCalcInterest(M_AMOUNT, 30, 700, 1);
    const finalInterest = Math.min(loanCalcInterest(M_AMOUNT, daysBetween(new Date(mBorrow.transaction.created_at).getTime(), Date.now()), 700), agreed);
    const totalRepayment = round2(M_AMOUNT + finalInterest);
    // 余额拨为恰 = P+I（partialAmount 与余额同值，验证"钱恰好够"的还清路径）
    const balData = { balance: totalRepayment };
    await encryptFields('users', balData, userA.id, db);
    await db.execute('UPDATE users SET balance=? WHERE id=?', [balData.balance, userA.id]);

    const prePool = await checkInvariants('H-2 还款前');
    const preFrozen = Number((await getUser(userA.id)).frozen_balance || 0);
    await post(userA, '/loan/repay', {
      userId: userA.id, transactionId: mTxId, partialAmount: totalRepayment,
      creditProof: { id: proofA.id }, verificationCode: proofA.verificationCode, signature: repaySig(userA, mTxId, proofA)
    });

    const order = await getMarginOrder(mOrderId);
    assert(order.status === 'RELEASED', `押金订单应 RELEASED，实为 ${order.status}`);
    assertNear(Number(order.frozen_interest), freezeInterest, 0.02, '【D】frozen_interest 应为冻结期利息');
    const afterA = await getUser(userA.id);
    assertNear(Number(afterA.frozen_balance), preFrozen - mMargin, 0.011, '押金冻结应解除');
    assertNear(Number(afterA.balance), totalRepayment - totalRepayment + mMargin + freezeInterest, 0.02, '押金借款人净剩 = 押金+冻结期利息');
    const postPool = await checkInvariants('H-2 还款后');
    const [ratioRows] = await db.query('SELECT borrow_platform_ratio FROM transactions WHERE id = ?', [mTxId]);
    const pr = Number(ratioRows[0].borrow_platform_ratio);
    assertNear(round2(postPool.PC - prePool.PC), round2(round2(M_AMOUNT * pr) + round2(finalInterest * pr) - freezeInterest), 0.02, '【D】PC 净变 = 本息×平台比例 − 冻结期利息');
  });

  await checkInvariants('ad-hoc 终态');
  await db.end();
  if (failures.length > 0) {
    console.error(`\n════ ad-hoc 失败（${failures.length}）════`);
    failures.forEach((f, i) => console.error(`${i + 1}. ${f}`));
    process.exit(1);
  }
  console.log(`\n════ 步骤12 ad-hoc 全部通过（耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s）════`);
  process.exit(0);
})().catch((e) => {
  console.error(`\n[FATAL] ad-hoc 异常终止：${e.stack || e.message}`);
  process.exit(1);
});
