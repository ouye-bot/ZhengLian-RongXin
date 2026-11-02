/**
 * 风控增强功能单元测试
 * 运行方式: cd backend && node test/risk-enhancement.test.js
 */

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

// 设置功能开关
process.env.FEATURE_RISK_ENHANCE = 'ON';

const marginEngine = require('../services/riskPlugins/marginEngine');
const guaranteeEngine = require('../services/riskPlugins/guaranteeEngine');
const notificationService = require('../services/riskPlugins/notificationService');

let passed = 0;
let failed = 0;

function assert(condition, testName) {
  if (condition) {
    console.log(`  ✓ ${testName}`);
    passed++;
  } else {
    console.log(`  ✗ ${testName}`);
    failed++;
  }
}

async function testMarginEngine() {
  console.log('\n=== 保证金引擎测试 ===');

  // 测试保证金比例计算
  const rate1 = marginEngine.calculateMarginRate(650, 30);
  assert(rate1 === 0.23, `信用650+期限30天: 保证金比例=${rate1} (期望0.23)`);

  const rate2 = marginEngine.calculateMarginRate(700, 30);
  assert(rate2 === 0.20, `信用700+期限30天: 保证金比例=${rate2} (期望0.20)`);

  const rate3 = marginEngine.calculateMarginRate(800, 90);
  assert(rate3 === 0.20, `信用800+期限90天: 保证金比例=${rate3} (期望0.20)`);

  const rate4 = marginEngine.calculateMarginRate(600, 7);
  assert(rate4 === 0.20, `信用600+期限7天: 保证金比例=${rate4} (期望0.20)`);

  const rate5 = marginEngine.calculateMarginRate(600, 90);
  assert(rate5 === 0.25, `信用600+期限90天: 保证金比例=${rate5} (期望0.25)`);

  // 测试保证金金额计算
  const margin1 = marginEngine.calculateMargin(10000, 650, 30);
  assert(margin1.marginAmount === 2300, `借款10000+信用650+期限30天: 保证金=${margin1.marginAmount} (期望2300)`);

  const margin2 = marginEngine.calculateMargin(5000, 750, 14);
  assert(margin2.marginAmount === 850, `借款5000+信用750+期限14天: 保证金=${margin2.marginAmount} (期望850)`);
}

async function testGuaranteeEngine() {
  console.log('\n=== 担保引擎测试 ===');

  // 测试担保费用计算
  const fee1 = guaranteeEngine.calculateGuaranteeFee(10000, 0.08);
  assert(fee1.feeRate === 0.012, `基础利率8%: 担保费率=${fee1.feeRate} (期望0.012)`);
  assert(fee1.feeAmount === 120, `借款10000: 担保费=${fee1.feeAmount} (期望120)`);
  assert(Math.abs(fee1.distribution.guarantor - 84) < 0.01, `担保人份额=${fee1.distribution.guarantor} (期望84)`);
  assert(fee1.distribution.insuranceFund === 24, `风险拨备=${fee1.distribution.insuranceFund} (期望24)`);
  assert(fee1.distribution.borrowerReward === 12, `借款人奖励=${fee1.distribution.borrowerReward} (期望12)`);

  const fee2 = guaranteeEngine.calculateGuaranteeFee(50000, 0.10);
  assert(fee2.feeAmount === 750, `借款50000+基础利率10%: 担保费=${fee2.feeAmount} (期望750)`);
}

async function testNotificationService() {
  console.log('\n=== 通知服务测试 ===');
  // 通知服务需要数据库连接，这里仅测试模块加载
  assert(typeof notificationService.sendGuaranteeRequestNotification === 'function', 'sendGuaranteeRequestNotification是函数');
  assert(typeof notificationService.getUnreadCount === 'function', 'getUnreadCount是函数');
  assert(typeof notificationService.getNotifications === 'function', 'getNotifications是函数');
}

async function runTests() {
  console.log('风控增强功能单元测试');
  console.log('====================');

  await testMarginEngine();
  await testGuaranteeEngine();
  await testNotificationService();

  console.log('\n====================');
  console.log(`结果: ${passed} 通过, ${failed} 失败`);

  if (failed > 0) {
    process.exit(1);
  }
}

runTests().catch(err => {
  console.error('测试执行失败:', err);
  process.exit(1);
});
