// 一次性迁移：现金口径 → 资本口径。把在贷（pending/overdue）剩余本金按借款时比例加回 PC/UC，使 available=total−LA 不再双重扣减。
require('dotenv').config();
const { execute } = require('../config/database');
const transactionDao = require('../dao/transactionDao');
(async () => {
  const [pool] = await execute('SELECT * FROM fund_pool WHERE id=1');
  const loans = [...await transactionDao.findByStatus('pending'), ...await transactionDao.findByStatus('overdue')].filter(t => t.type === 'loan');
  let addUC = 0, addPC = 0, sumLA = 0;
  for (const t of loans) {
    const p = Number(t.amount) || 0; sumLA += p;
    const ur = t.borrow_user_ratio != null ? Number(t.borrow_user_ratio) : 0.8;
    addUC += p * ur; addPC += p * (1 - ur);
  }
  const r2 = x => Math.round(x * 100) / 100;
  const PC = r2(Number(pool.platform_capital) + addPC), UC = r2(Number(pool.user_capital) + addUC), LA = Number(pool.loaned_amount);
  console.log('在贷笔数', loans.length, '在贷本金合计', r2(sumLA), '库中LA', LA, '| PC', pool.platform_capital, '→', PC, '| UC', pool.user_capital, '→', UC);
  const LA2 = r2(sumLA);
  if (Math.abs(sumLA - LA) > 0.05) console.log('⚠ 库中 LA 与在贷本金合计不一致（历史测试污染），以交易表剩余本金为准修正 LA:', LA, '→', LA2);
  await execute('UPDATE fund_pool SET platform_capital=?, user_capital=?, loaned_amount=?, reserved_amount=?, total_amount=?, available_amount=? WHERE id=1', [PC, UC, LA2, LA2, r2(PC + UC), r2(PC + UC - LA2)]);
  console.log('迁移完成: PC', PC, 'UC', UC, 'LA', LA2, 'total', r2(PC + UC), 'available', r2(PC + UC - LA2));
  process.exit(0);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
