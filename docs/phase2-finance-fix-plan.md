# 阶段2：资金账务修复 — 施工计划（规划员·阶段2 产出）

日期：2026-11-01 ｜ 仓库：paper-version/FIN-ZK-TRUST-master ｜ 骨架：预检 → E2E红 → 修复 → 转绿 → 提交

## 0. 已核实事实（本次亲自读码/执行，全部可复查）

| 项 | 证据 |
|---|---|
| 后端健康 | `curl http://localhost:3003/health` → `{"status":"ok"}`；进程 PID 22760（`node app.js`），监听 3003 |
| 资金池基线 | MySQL 3307 finzktrust.fund_pool id=1：PC=30000.00, UC=0, LA=0, TIE=0, UIE=0（node+mysql2 只读查询） |
| 14 表齐全 | SHOW TABLES 列出 blockchain_queue…zk_queue 共 14 张 |
| 风控开启 | backend/.env：`FEATURE_RISK_ENHANCE=ON`、`MARGIN_BASE_RATE=0.20`、`GUARANTEE_MIN_REGISTRATION_DAYS=0`（新人可担保，e2e 无需回拨 created_at）、`GUARANTEE_COMPENSATION_THRESHOLD_DAYS=15` |
| schema 缺口 | risk_guarantee_contracts 无 `fee_collected`/`released_amount` 列；risk_margin_orders 已有 margin_rate/frozen_interest；transactions 已有 risk_mode/margin_order_id/guarantee_contract_id/borrow_user_ratio/due_date；fund_pool 已有 user_interest_earned |
| 迁移机制 | scripts/create-tables.js:68-79 `addColumnIfNotExists` 幂等，app.js:287 每次启动自动执行 |
| 逾期任务 | app.js:294-314 每小时 + :330-342 启动 10s 后执行 `checkOverdueLoans`；overdueService.js:33-36 标记 pending→overdue（UPDATE 无 status 守卫） |
| 依赖齐备 | package.json：mysql2 ^3.22.2、axios ^1.13.6、sm-crypto ^0.4.0、joi ^18.1.2 |
| 两套利率表一致 | routes/credit.js:46（INTEREST_RATES）与 utils/interestRate.js:7 完全相同 {750:4.0,700:6.0,650:8.0,600:10.0,300:13.8}；罚息倍数 dynamicConfigService.js:248（≤7→1.5, ≤15→2.0, ≤30→2.5, else 3.0）——e2e 进程内复算与服务端一致 |

## 1. 逐条核码结论（A–M，行号为当前代码实况）

- **A 逾期死锁（属实）**：routes/loan.js:612 `transaction.status !== 'pending'` 拒绝 overdue；罚息已有（loan.js:630-642 按逾期天数×倍数）；overdueService.js 把过期贷款改成 overdue 后无任何出路。
- **B 代偿挂错位（属实）**：services/riskPlugins/index.js:100-129 清算分支挂在 `afterRepay`（只有还款成功才触发，借款人不还则永不清算）；outstanding=tx.amount（index.js:116）不含罚息；`liquidateMargin`（marginEngine.js:235）没收款直接蒸发、`executeGuaranteeCompensation`（guaranteeEngine.js:518-524）代偿款蒸发——都不入池、不核减 LA。
- **C 担保费凭空发放（属实）**：guaranteeEngine.js:433-453 担保人+借款人余额直接增加，:456-471 PC 增加 platformIncome−loyaltyBonus，全程无人支付 fee → 凭空铸币。
- **D 押金利息无源（属实）**：marginEngine.js:150,172 归还押金+利息，利息无出处。
- **E 赎回付息无源（属实，两处）**：poolService.js:641-642 还款时利息的用户份额既不进 PC 也不进 UC（只记 user_interest_earned 负债，现金蒸发）；poolService.js:401,420 赎回 UC 只减本金却支付本金+利息（利息凭空）；**autoRedeemService.js:76-97 是同一 bug 的独立实现**（newUC−principal 而 payout=principal+actualInterest），必须一并修。
- **F 并发双重还款（属实）**：loan.js:612 状态检查在事务外；poolService.js:684 状态 UPDATE 无 WHERE status 守卫，两个并发还款都能扣款（LA 双减）。
- **G 部分还款超额解冻（属实，机制比预想隐蔽）**：loan.js:703-709 传 `repaidPrincipal: paidPrincipal, totalPrincipal: principal`，而 `principal` 取自 transaction.amount——首次部分还款后 loanUpdateFields.amount 已把 amount 改成剩余本金（loan.js:685），故第二笔部分还款释放比例 = p2/(P−p1) 而非 p2/P → 超额解冻。另 releaseGuarantorQuota（guaranteeEngine.js:280-281）结清时无条件全额解冻 guarantee_amount，若此前已按比例释放过，会凭空补足差额（铸币）。
- **H 部分还清缺收尾（属实）**：loan.js:654-736 部分还款分支把贷款标 completed 后直接 return（:722-735），走不到 ：778-795 的 afterRepay → 押金不释放、担保不结算。
- **I 押金金额不核（属实）**：riskPlugins/index.js:31 用户自报 margin_amount 直通 freezeMargin；freezeMargin 硬编码 margin_rate:0（marginEngine.js:114）→ 恒 0。margin.js:16-30 /calculate 端点可提供计算值。
- **J 两阶段窗口（属实）**：beforeBorrow 冻结押金 loanId=null（index.js:31）→ 借款 → loan.js:422 回填 loan_id，非事务；进程崩溃留下 loan_id NULL 的 FROZEN 孤儿（用户资金永久冻结）。handleBorrow catch 的补偿回滚（loan.js:472-507）只覆盖 API 报错，不覆盖进程崩溃。
- **K redeem 锁序 ABBA（属实）**：poolService.redeem 先锁 pool(:311) 后锁 user(:414)；repay/invest 先 user 后 pool。
- **L requestId 恒 undefined（属实）**：routes/guarantee.js:69 `requestId: result.id`，而 createRequest 返回 `{request, feeInfo}`（guaranteeRequestService.js:103）→ 应为 `result.request.id`。（accept/reject 两处的 result.requestId 是函数入参，有值，不用改。）
- **M**：M-1 罚息未享担保85折——loan.js:89-104 无 riskMode 参数（属实）；但 e2e 草稿场景④已按"无折扣罚息"固定预期（finance-e2e.js:624），改动需连带改测试口径 → **入 risks 不并入**。M-2 逾期后部分还款剩余利息近 0——loan.js:667-674 `daysRemaining=max(1, ceil((due-now)/day))`，逾期后恒 1（属实）；"未来计息天数"需要产品口径 → **入 risks 不并入**。

### e2e 草稿自身缺陷（本次审出，需先修脚本）
1. finance-e2e.js:120-132 `post()` 不支持 `expectStatus=null`：场景⑥ ：747 传 null，:128 `resp.status !== null` 恒真 → fail() 直接退出。修：`if (expectStatus !== null && resp.status !== expectStatus)`。
2. 该脚本从未运行过（untracked、今日生成），RED 阶段可能再暴露脚本级小错——处理原则：**凡属"目标契约"的断言不动，凡属脚本自身 bug（payload/取值/时序）就地修**。

## 2. 修复设计（关键口径决策，含 C 收取时机）

**恒等式铁律**：每条路径只允许三类操作，且在同一事务内成对发生：
- 现金进出池 ⇒ PC/UC 与 total 同增同减；
- 本金出/入 ⇒ LA 增/减；
- 每次写 fund_pool 后 `total=PC+UC、available=total−LA` 重算式落库（沿用现有模式）。

**C 担保费收取时机（拍板）**：**贷款结清时与末期本息一同代扣**（"结清"= 状态翻 completed 的那次还款，含全额还款与"部分还款恰好还清"两条路径）；部分还款（未结清）不收费；清算代偿（liquidated）不向借款人收费。fee_amount 用借款时合约固定值，不按时间折算。资金流（单一事务内）：
1. 代收：借款人余额 −F，PC += F，total += F，`fee_collected=1`（与还款同事务，防崩损重收）；
2. 分配：担保人 +0.7F+loyaltyBonus、借款人 +0.1F、PC −=(0.8F+loyaltyBonus)；净 PC=+0.2F−loyaltyBonus（e2e ：438-439 断言值）。loyaltyBonus≤0.14F<0.2F 恒不透支。

**B 清算资金口径（对齐 e2e ：658-661）**：代偿/没收现金 ⇒ PC += 实收（担保：outstanding=剩余本金+应计利息+罚息；押金：margin_amount）；LA −= 剩余本金全额（贷款 closed 即全额核销）；贷款/合约/押金单置 liquidated/LIQUIDATED；担保人 −10 分（从 index.js 迁入）；代偿后剩余冻结额度退回担保人。利息部分建议同步记 TIE（e2e 不断言，口径一致用）。

**E 修法（最小侵入）**：repay :642 `newUC = UC + principalToUser + interestToUser`（用户利息现金进池）；redeem :401 `newUC = UC − (amount + actualInterest)`；autoRedeemService.js:76 同改。UC 语义从"纯出资本金"扩为"出资本金+已归属用户利息现金"，UIE 与 UC 的利息分量始终 1:1（collect 时同增、pay 时同减），redeem 校验改为 `UC ≥ amount+actualInterest`（由 actualInterest≤UIE≤UC利息分量 保证可满足）。对外 API 字段不变。

**F 修法**：poolService.repay 事务内、锁用户行后立即 `UPDATE transactions SET status='repaying' WHERE id=? AND status IN('pending','overdue')`，affectedRows===0 则 throw（整个事务回滚，未扣款）；后续 final update 不带守卫（行已锁）。'repaying' 只存在于未提交事务，外部不可见。与清算的竞态由双方守卫互斥（清算侧 UPDATE ... WHERE status='overdue'）。

**J 修法**：保留两阶段提交流程，app.js 现有 10 分钟 cron（:317-327）追加孤儿清理：`risk_margin_orders WHERE status='FROZEN' AND loan_id IS NULL AND created_at < NOW()-INTERVAL 10 MINUTE` → 解冻退余额（不计息，frozen_interest=0）、状态 RELEASED。另加**结算对账兜底**：loan=completed 但合约仍 ACTIVE / 押金单仍 FROZEN 的记录由同一 cron 补收尾（幂等：以合约状态/fee_collected 为闸）。

**I 修法**：beforeBorrow riskMode===1 时 `marginEngine.calculateMargin(amount, creditScore, term)` 强核：`margin_amount < 计算值` → 抛错（400 消息含"押金金额不足"，e2e :465 断言）；freezeMargin 增加 marginRate 入参落库（marginEngine.js:114 去 0 硬编码）。/loan/config 的 getMarginParams 顺手补上（现恒 null，loan.js:982）。

**G 修法**：合约新增 `released_amount DECIMAL(15,2) DEFAULT 0`；releasePartialGuarantee 改为累计口径：目标=round2(G×min(1, 累计已还本金/原始本金))，本次释放=目标−released_amount（≥0 钳位），回写 released_amount；调用方（loan.js）传 累计已还=原始本金−当前amount、原始本金=contract.guarantee_amount；releaseGuarantorQuota 只解冻 `G−released_amount` 并置 released_amount=G（消铸币）。

**H 修法**：抽出共享收尾 `settleLoanRiskWrapup(loanId)`（= 现.afterRepay 正常分支：releaseMargin + 担保分配/解冻 + 信用分），全额路径（loan.js:778）与部分还清路径（:654 分支 newStatus==='completed' 时，含 C 的 fee 代收）统一调用。DAO 白名单扩展：guaranteeContractDao.updateStatus allowedFields += ['fee_collected','released_amount']。

**K 修法**：poolService.redeem 调整为先锁 user(:311 前)后锁 pool。

## 3. 施工步骤（执行序，每步带验证）

| # | 步骤 | 验证 |
|---|---|---|
| 0 | 预检：`curl -s http://localhost:3003/health`；node+mysql2 读池基线；确认 git 工作区仅 finance-e2e.js untracked | 输出与 §0 表一致 |
| 1 | 修 e2e post() null 守卫（§2 脚本缺陷1），跑 **RED**：`node backend/test/finance-e2e.js`，记录全量失败清单（期望：L/C/G/H/D/A/B/F/E/I 相关断言红） | RED 清单存 backend/test/results/phase2-red.txt |
| 2 | schema 迁移：create-tables.js 加 `addColumnIfNotExists('risk_guarantee_contracts','fee_collected',"TINYINT NOT NULL DEFAULT 0")`、`('risk_guarantee_contracts','released_amount',"DECIMAL(15,2) NOT NULL DEFAULT 0")` | 重启后 SHOW COLUMNS 见两列；重复重启不重复加 |
| 3 | F+A（loan.js:612 状态放行 overdue；poolService.repay 守卫认领；三处 active-loan 统计 pending→IN('pending','overdue')：loan.js:268、:972、poolService.js:465） | 编译通过；单笔还款回归 |
| 4 | E+K（poolService.js:642、:401、autoRedeemService.js:76、redeem 锁序） | 场景⑤断言转绿 |
| 5 | G+H+L（released_amount 累计释放、releaseGuarantorQuota 差额解冻、loan.js 共享收尾、guarantee.js:69 result.request.id） | 场景①断言转绿 |
| 6 | C（fee 代收进 poolService.repay 同事务+fee_collected；借款时 total_amount 含 F；settleGuaranteeRevenue 改纯分配；DAO 白名单扩展） | 场景① C 组断言转绿 |
| 7 | D（releaseMargin PC 付息+PC 充足性守卫） | 场景②断言转绿 |
| 8 | B（overdueService 新增导出 liquidateOverdueLoans；executeGuaranteeCompensation/liquidateMargin 入池+核减 LA+退残余冻结；index.js afterRepay 删 >15d 分支；app.js cron 挂载；担保人 −10） | 场景③④断言转绿 |
| 9 | I+J（押金强核+margin_rate 落库；孤儿清理+结算对账 cron） | 场景② I 组断言转绿；孤儿用例手工验证（插入 FROZEN+loan_id NULL+created_at 11 分钟前的订单→直调清理→断言解冻→清理现场） |
| 10 | 重启后端：`powershell "Stop-Process -Id 22760"` → `cd backend && node app.js > server.log 2>&1 &`（后台）；兜底：重启失败读 server.log 首错、回滚最后一步再试 | `/health` ok；server.log 有"数据库表初始化成功" |
| 11 | **GREEN**：`node backend/test/finance-e2e.js` 全绿（0 退出码，终态恒等式通过） | 全场景 + 终态 checkInvariants |
| 12 | 补充验证：H 路径 ad-hoc（部分还款额=恰好还清 → 断言收尾+fee+恒等式）；并发 F 已由场景⑥覆盖 | 脚本或手工 curl 序列，结果记 results/ |
| 13 | 提交：`git add -A && git commit -m "phase2: 资金账务修复（逾期死锁/代偿入池/担保费代收/利息有源/并发守卫/押金强核）"` | git log 一条 phase2 提交 |

注：e2e 会注册 e2e_* 用户并改变池绝对值；全部断言基于相对增量+恒等式，无需在 RED/GREEN 之间重置池。

## 4. 风险与不并入项

1. **M-1 罚息85折**：不并入。e2e 场景④已按无折扣口径固定预期；改动属利率政策口径（涉论文一致性），需单独拍板。
2. **M-2 逾期部分还款剩余利息≈0**：不并入。"未来计息天数"无自然口径（逾期无剩余期限），需产品定义；现行为不破坏恒等式，仅少估利息。
3. **e2e 草稿未运行过**：除已审出的 post(null) 外可能还有脚本级小错；兜底=RED 阶段全量暴露，脚本 bug 就地修、契约断言不动。
4. **H 边界**："部分还款恰好还清"需同步调整 loan.js:650 超额守卫（应还口径 +F）；已列入步骤 12 专项验证。
5. **D 的 PC 充足性**：PC<利息时 releaseMargin 抛错（不阻塞还款主流程，由 J 的对账 cron 重试兜底）；当前 PC=30000 远大于可能利息。
6. **部分代偿（担保人资不抵债）**：现金实收入池、LA 仍全额核销（e2e 口径）；残余冻结退还。e2e 未覆盖该子情形，作为已知口径记录。
7. **e2e 运行残留**：池绝对值变化、新增测试用户，不影响断言（相对增量）；如需复原可用 SQL 重置 fund_pool（非必需）。
