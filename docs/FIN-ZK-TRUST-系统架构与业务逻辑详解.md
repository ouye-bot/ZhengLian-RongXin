# FIN-ZK-TRUST 三模式隐私借贷系统 — 架构与业务逻辑详解

> **版本：** v2.0 | **日期：** 2026-06-28 | **状态：** 生产就绪
>
> 本文档面向首次接触本系统的开发者，详尽描述系统架构、三种借款模式的金融机制、风控引擎、资金池模型及完整业务流程。

---

## 目录

1. [系统总体架构](#1-系统总体架构)
2. [核心技术栈](#2-核心技术栈)
3. [8层安全验证链](#3-8层安全验证链)
4. [资金池模型](#4-资金池模型)
5. [三种借款模式全链路详解](#5-三种借款模式全链路详解)
   - [5.1 模式0：纯信用借款](#51-模式0纯信用借款)
   - [5.2 模式1：押金借款](#52-模式1押金借款)
   - [5.3 模式2：担保借款](#53-模式2担保借款)
6. [动态风控引擎](#6-动态风控引擎)
7. [新用户冷静期机制](#7-新用户冷静期机制)
8. [担保人激励与惩罚机制](#8-担保人激励与惩罚机制)
9. [还款全流程](#9-还款全流程)
10. [出资与赎回流程](#10-出资与赎回流程)
11. [密码学与安全体系](#11-密码学与安全体系)
12. [数据库架构](#12-数据库架构)
13. [环境变量与特性开关](#13-环境变量与特性开关)

---

## 1. 系统总体架构

```
┌─────────────────────────────────────────────────────────────┐
│                      前端 (React)                            │
│  Borrow.js / Account.js / Invest.js / BlockchainExplorer.js  │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  风控增强组件                                          │   │
│  │  GuaranteeModePanel  GuaranteePendingList             │   │
│  │  GuaranteeAcceptedList  GuaranteeRequestDialog        │   │
│  └──────────────────────────────────────────────────────┘   │
└──────────────────────┬──────────────────────────────────────┘
                       │ HTTPS + SM2签名
                       ▼
┌─────────────────────────────────────────────────────────────┐
│                    后端 (Express.js)                          │
│                                                              │
│  ┌─────────────────────────────────────────────────────┐    │
│  │              8层安全验证链                            │    │
│  └─────────────────────────────────────────────────────┘    │
│                                                              │
│  ┌──────────┐  ┌──────────┐  ┌────────────────────────┐    │
│  │ loan.js   │  │invest.js │  │   riskPlugins/         │    │
│  │ borrow    │  │ invest   │  │   ├─ index.js (Hook)   │    │
│  │ repay     │  │ redeem   │  │   ├─ marginEngine.js   │    │
│  │ config    │  │          │  │   ├─ guaranteeEngine.js│    │
│  └─────┬─────┘  └────┬─────┘  │   ├─ guaranteeRequest  │    │
│        │              │        │   │   Service.js       │    │
│        ▼              ▼        │   └─ notification      │    │
│  ┌──────────────────────────┐  │       Service.js       │    │
│  │     poolService.js       │  └────────────────────────┘    │
│  │  borrowFromPool          │                                │
│  │  repay                   │  ┌────────────────────────┐    │
│  │  investFromUser          │  │  dynamicConfigService  │    │
│  │  redeemFromPool          │  │  ├─ getLoanRate        │    │
│  └──────────┬───────────────┘  │  ├─ getLoanLimit       │    │
│             │                  │  ├─ getCoolingOff      │    │
│             ▼                  │  ├─ updateCreditScore  │    │
│  ┌──────────────────────┐     │  └─ getOverduePenalty  │    │
│  │    MySQL (SM4加密)    │     └────────────────────────┘    │
│  │  fund_pool (单行)     │                                    │
│  │  users (字段加密)     │  ┌────────────────────────┐       │
│  │  transactions         │  │  blockchainService     │       │
│  │  guarantee_requests   │  │  ├─ AuditStorage (上链)│       │
│  │  risk_guarantee_      │  │  ├─ ZKPVerifier        │       │
│  │    contracts          │  │  └─ Hardhat (本地链)   │       │
│  │  risk_margin_orders   │  └────────────────────────┘       │
│  └──────────────────────┘                                    │
└──────────────────────────────────────────────────────────────┘
```

**关键设计原则：**
- **环境变量开关** `FEATURE_RISK_ENHANCE=ON` 控制押金/担保模块加载，关闭后系统无缝回退至纯信用模式
- **SM4-CBC字段级加密**：`balance`、`frozen_balance`、`credit_score` 等敏感字段入库前加密
- **悲观行锁** `SELECT ... FOR UPDATE` 保障并发资金安全
- **按ID升序锁定** 避免ABBA死锁（如 `settleGuaranteeRevenue` 中对担保人和借款人按ID排序后锁定）

---

## 2. 核心技术栈

| 层级 | 技术 | 用途 |
|------|------|------|
| 前端 | React 18 + MUI 5 | SPA + Material Design |
| 后端 | Express.js 4.x | RESTful API |
| 数据库 | MySQL 8.x + mysql2/promise | 持久化 + 连接池(10连接/进程) |
| 加密 | SM2/SM3/SM4 国密套件 | 签名、哈希、字段加密 |
| ZKP | Groth16 SNARK (snarkjs) | 零知识信用分范围证明 |
| 区块链 | Hardhat 本地链 + ethers.js | AuditStorage + ZKPVerifier 存证 |
| KMS | 自定义密钥管理服务 | DEK加密/解密 |
| 认证 | JWT + SM2签名 + 防重放 | 三层鉴权 |

---

## 3. 8层安全验证链

每个借款请求依次通过以下8层验证，任何一层失败即返回400错误：

```
POST /api/v1/loan/borrow

Layer 1: 参数校验 (loan.js:118)
  ├─ userId, amount, creditProof, verificationCode, signature 必填
  ├─ term ∈ {7, 14, 30, 60, 90}
  ├─ risk_mode ∈ {0, 1, 2}
  └─ 模式特定参数：margin_amount (mode=1) / guarantee_request_id (mode=2)

Layer 2: SM2签名验证 (loan.js:174-186)
  ├─ signatureData = buildSignatureData({ userId, amount, creditProofId },
  │                                        ['amount', 'creditProofId', 'userId'])
  └─ verifySM2Signature(signatureData, signature, user.sm2_public_key)

Layer 3: 信用证明+口令验证 (loan.js:197-215)
  ├─ proofDao.findByProofId(creditProof.id)
  ├─ expires_at > now (30天有效期)
  └─ timingSafeEqual(verificationCode, matchingProof.verification_code)

Layer 4: 挑战响应（大额二次签名）(loan.js:226-254)
  ├─ threshold = getChallengeThreshold('borrow', userRisk)
  ├─ 区间: 2000 ~ 7500 (风险越低阈值越高)
  └─ 金额 ≥ threshold 时需 challengeSignature

Layer 5: 风控评估 (loan.js:218-223, 369-382)
  ├─ assessLoanRisk(userId, amount, term, creditProof)
  ├─ 返回 riskScore, riskLevel, loanRiskLevel, loanSuggestion
  └─ success=false 时拒绝放款

Layer 6: 借款额度+冷静期检查 (loan.js:256-337)
  ├─ getLoanLimit(creditScore, userRisk) → 基础限额
  ├─ actualLoanLimit = loanLimit - 已借未还金额
  ├─ 冷静期：按比例缩减
  └─ 纯信用冷静期内额外缩减50%

Layer 7: 零知识证明验证 (loan.js:340-366)
  ├─ verifyProof(creditProof.proof, creditProof.publicSignals)
  └─ 支持 Groth16 SNARK 证明验证

Layer 8: 风控增强Hook (loan.js:392-413)
  ├─ risk_mode=1 → beforeBorrow → freezeMargin
  ├─ risk_mode=2 → beforeBorrow → 验证邀约+创建合约+lockGuarantorQuota
  └─ risk_mode=0 → 跳过

通过全部8层 → poolService.borrowFromPool() → 放款成功
```

---

## 4. 资金池模型

### 4.1 表结构 (`fund_pool`)

`fund_pool` 为单行表（id=1），所有操作在同一行上进行：

```
fund_pool (id=1):
┌─────────────────────────────────────────────────┐
│  platform_capital (PC)  — 平台自有资金            │
│  user_capital (UC)      — 用户出资总额            │
│  loaned_amount (LA)     — 已借出本金              │
│                                                   │
│  total_amount     = PC + UC                       │
│  available_amount = total - LA                    │
│  reserved_amount  = LA                            │
└─────────────────────────────────────────────────┘
```

**会计恒等式：** `total_amount = platform_capital + user_capital`，`available_amount = total_amount - loaned_amount`

### 4.2 分层借款机制 (`borrowFromPool`)

```
借款金额 = amount

1. 优先从用户池 (UC) 出借：fromUserPool = min(amount, UC)
2. 不足从系统池 (PC) 补：fromSystemPool = amount - fromUserPool
3. 系统池最低保留20%：systemReserve = PC × 0.20
   若 fromSystemPool > PC - systemReserve → 部分放贷或拒绝
```

### 4.3 分层还款机制 (`repay`)

```
还款金额按借出比例归还：
  用户池归还 = 还款本金 × borrowUserRatio
  系统池归还 = 还款本金 × borrowPlatformRatio

borrowUserRatio = fromUserPool / totalBorrowed (借款时记录)
borrowPlatformRatio = fromSystemPool / totalBorrowed (借款时记录)
```

---

## 5. 三种借款模式全链路详解

### 5.1 模式0：纯信用借款

**适用场景：** 高信用分老用户，无需额外风控手段

**触发条件：** `risk_mode = 0`（默认值）

#### 5.1.1 前端流程

```
Borrow.js → 输入金额/期限 → 生成ZKP信用证明
  → 选择"纯信用借款"（默认选中）
  → 点击借款 → 输入SM2签名 + 验证口令
  → POST /api/v1/loan/borrow { risk_mode: 0 }
```

#### 5.1.2 后端执行流程

```
1-7. 通过8层安全链（Layer 1-7）
8。  risk_mode=0 → beforeBorrow 返回 { success: true, skipped: true }
9。  borrowFromPool(userId, amount, term, loanLimit, 0)
     ├─ 信用分校验：credit_score ≥ 600
     ├─ calculateInterest(amount, term, creditScore, false, 0, 0)
     │   └─ rate = getInterestRate(creditScore) / 100 / 365
     │   └─ interest = principal × rate × days (无折扣)
     ├─ 分层借款：先从user_capital出，再从platform_capital补
     ├─ 用户余额：balance += amount (到账)
     ├─ 创建交易记录：type='loan', status='pending'
     └─ 更新资金池：PC↓/UC↓, LA↑
10。 关联风控字段（如果有marginOrder/guaranteeContract）
11。 SM3哈希 + 异步区块链存证
```

#### 5.1.3 金融机制

| 参数 | 计算方式 |
|------|---------|
| **利率** | `getInterestRate(creditScore)`：300→13.8%, 600→10%, 650→8%, 700→6%, 750→4% |
| **限额** | `getLoanLimit(creditScore, userRisk)`：基础阶梯 × 风险乘数 × 资金池乘数 |
| **费用** | 无额外费用，纯利率 |

---

### 5.2 模式1：押金借款

**适用场景：** 信用分中等用户，用自有资金冻结作为增信手段

**触发条件：** `risk_mode = 1`，需传入 `margin_amount`（前端`calculateMarginAmount()`计算）

#### 5.2.1 保证金费率计算 (`calculateMarginRate`)

```
基础费率: 20% (MARGIN_BASE_RATE)
期限溢价: term ≥ 90 → +5%, term ≥ 30 → +3%
信用折扣: creditScore ≥ 800 → -5%, ≥ 700 → -3%
钳位范围: [15%, 25%]

marginAmount = loanAmount × marginRate
```

#### 5.2.2 后端执行流程

```
8。  beforeBorrow (risk_mode=1):
     └─ marginEngine.freezeMargin(userId, marginAmount, null)
        ├─ SELECT balance, frozen_balance FOR UPDATE (行锁)
        ├─ balance -= marginAmount
        ├─ frozen_balance += marginAmount        ← 押金冻结，非扣除
        ├─ 创建 risk_margin_orders (status=FROZEN)
        └─ 返回 marginOrder

9。  borrowFromPool: 正常放款流程（无利率折扣）

还款后：
   正常还款 → afterRepay → marginEngine.releaseMargin(loanId)
     ├─ frozen_balance -= marginAmount
     ├─ balance += marginAmount                   ← 押金全额退还
     └─ 订单状态 → RELEASED

   逾期>15天 → afterRepay → marginEngine.liquidateMargin(loanId)
     ├─ frozen_balance -= marginAmount            ← 押金没收
     └─ 订单状态 → LIQUIDATED
```

#### 5.2.3 资金安全

- 押金在 `frozen_balance` 中独立存放，不计入资金池可用余额
- 借款人无法动用冻结金额
- 正常还款后全额返还；违约时没收作为风险补偿

---

### 5.3 模式2：担保借款

**适用场景：** 新用户或低信用分用户，借助高信用担保人的信用增信借款

**触发条件：** `risk_mode = 2`，需传入 `guarantee_request_id`

担保借款是系统中最复杂的流程，分为**两阶段**。

#### 5.3.1 阶段1：担保邀约流程

```
借款人 (Borrow.js)                 后端                           担保人
     │                              │                              │
     │  先生成ZKP信用证明              │                              │
     │  (creditProof + verificationCode)                            │
     │                              │                              │
     │  选择"担保借款" → 输入金额      │                              │
     │  → 系统加载可选担保人列表        │                              │
     │                              │                              │
     │    GET /eligible-guarantors  │                              │
     │  ──────────────────────────→│                              │
     │                              │  checkGuarantorEligibility()  │
     │                              │  ├─ 信用分 ≥ 650              │
     │                              │  ├─ 注册满180天               │
     │                              │  ├─ 无逾期贷款                │
     │                              │  ├─ balance ≥ loanAmount      │
     │                              │  ├─ 担保总额 ≤ balance × 2.0  │
     │                              │  ├─ 活跃合约 < 5笔            │
     │                              │  └─ 返回 guaranteeCount       │
     │   ← 可选担保人列表              │                              │
     │                              │                              │
     │  点击"邀请" → 弹出签名对话框      │                              │
     │  → SM2签名                    │                              │
     │                              │                              │
     │    POST /request             │                              │
     │  ──────────────────────────→│                              │
     │   { guarantorId, loanAmount, │  createRequest()             │
     │     borrowerSignature,       │  ├─ 验证 creditProof          │
     │     creditProof,             │  │  ├─ 查询 proof 记录         │
     │     verificationCode }       │  │  ├─ 检查过期时间            │
     │                              │  │  ├─ timingSafeEqual 口令    │
     │                              │  │  └─ 提取 verifiedCreditScore│
     │                              │  ├─ 检查担保人资格             │
     │                              │  ├─ 验证SM2签名               │
     │                              │  ├─ 使用验证后信用分计算费率    │
     │                              │  ├─ 创建 guarantee_requests    │
     │                              │  │   status=PENDING            │
     │                              │  │   expire_time=now+24h       │
     │                              │  └─ 发通知给担保人             │
     │   ← { requestId, feeInfo }   │                              │
     │                              │         ┌─ 担保人看到通知      │
     │                              │         │  (GuaranteePendingList)
     │                              │         │                      │
     │                              │    POST /accept/:requestId    │
     │                              │  ←───────────────────────────│
     │                              │   { guarantorSignature }      │
     │                              │  acceptRequest()              │
     │                              │  ├─ 身份校验(必须是担保人本人)   │
     │                              │  ├─ 验证担保人SM2签名          │
     │                              │  │   keyOrder: ['guarantorId', │
     │                              │  │     'loanAmount','requestId']│
     │                              │  ├─ PENDING → ACCEPTED        │
     │                              │  └─ 发通知给借款人              │
     │                              │                              │
     │   ← 借款人看到"已接受的邀约"     │                              │
     │   (GuaranteeAcceptedList)     │                              │
```

**担保人资格门槛 (`checkGuarantorEligibility`)：**

| 检查项 | 条件 | 拒绝原因 |
|--------|------|---------|
| 用户存在 | `userDao.findById` 非空 | 用户不存在 |
| 信用分 | `credit_score ≥ 650` | 信用分不足 |
| 注册时长 | `注册天数 ≥ 180` | 注册时长不足 |
| 逾期检查 | 无 overdue 贷款 | 存在逾期贷款 |
| 余额检查 | `balance ≥ loanAmount` | 余额不足以冻结 |
| 总额度 | `已担保+本次 ≤ balance×2.0` | 担保总额超限 |
| 合约数 | `活跃合约 < 5` | 合约数达上限 |

#### 5.3.2 阶段2：借款执行

```
8。  beforeBorrow (risk_mode=2):
     ├─ 查询 guarantee_requests WHERE id=? AND status='ACCEPTED'
     ├─ 校验 amount ≤ request.loan_amount
     ├─ 创建 risk_guarantee_contracts (status=PENDING)
     │   ├─ borrower_id, guarantor_id
     │   ├─ guarantee_amount = amount
     │   ├─ fee_rate (含忠诚度折扣)
     │   └─ fee_amount
     ├─ 担保邀约状态 ACCEPTED → USED（防重复借款）
     └─ guaranteeEngine.lockGuarantorQuota(contract.id)
        ├─ SELECT balance, frozen_balance FOR UPDATE
        ├─ balance -= guaranteeAmount        ← 冻结担保金
        ├─ frozen_balance += guaranteeAmount  ← 转入冻结余额
        └─ 合约状态 PENDING → ACTIVE

9。  borrowFromPool(userId, amount, term, loanLimit, 2)
     └─ calculateInterest: baseRate × 0.85  ← 担保85折利率优惠

还款后 (afterRepay):

   正常还款:
   ├─ settleGuaranteeRevenue(contract.id)
   │   ├─ guarantorIncome = feeAmount × 0.70
   │   ├─ loyaltyBonus = guarantorIncome × 忠诚度比例
   │   ├─ 担保人 balance += guarantorIncome + loyaltyBonus  ← 纯收益
   │   ├─ 借款人 balance += feeAmount × 0.10
   │   └─ 平台 fund_pool += feeAmount × 0.20 - loyaltyBonus
   ├─ releaseGuarantorQuota(contract.id)
   │   ├─ frozen_balance -= guaranteeAmount
   │   └─ balance += guaranteeAmount           ← 担保金全额解冻
   └─ updateCreditScore(guarantorId, +2, '担保成功奖励')

   逾期>15天 (代偿):
   ├─ executeGuaranteeCompensation(contract.id, outstandingAmount)
   │   ├─ fromFrozen = min(frozen_balance, outstandingAmount)
   │   ├─ fromBalance = min(balance, 剩余)
   │   └─ 扣减 frozen_balance + balance
   └─ updateCreditScore(guarantorId, -10, '担保代偿惩戒')

   部分还款:
   └─ releasePartialGuarantee(contract.id, repaidPrincipal, totalPrincipal)
      ├─ releaseAmount = guaranteeAmount × (repaidPrincipal / totalPrincipal)
      ├─ frozen_balance -= releaseAmount
      └─ balance += releaseAmount               ← 按比例解冻
```

#### 5.3.3 担保费分配模型

```
担保费率: baseRate × 0.15 × (1 - 忠诚度费率折扣)
担保费金额: loanAmount × feeRate

分配:
  担保人: feeAmount × 70%  (风险补偿)
  平台:   feeAmount × 20%  (平台运营)
  借款人: feeAmount × 10%  (守信奖励返还)

忠诚度奖励(额外，从平台份额出):
  loyaltyBonus = guarantorShare × loyaltyBonusRatio
```

#### 5.3.4 三模式资金流对比（借款100元/30天/信用分650为例）

| 维度 | 纯信用 | 押金借款 | 担保借款 |
|------|--------|---------|---------|
| **年化利率** | 8.0% | 8.0% | 8.0%×0.85=6.8% |
| **利息/30天** | ¥0.66 | ¥0.66 | ¥0.56 |
| **额外成本** | 无 | 冻结20元押金 | 担保费0.12元 |
| **到账金额** | 100元 | 100元 | 100元 |
| **可用余额** | +100 | +100 (20冻结) | +100 |
| **担保人资金变动** | 无 | 无 | balance-100, frozen+100 |
| **还款总额** | 100.66 | 100.66 (押金退还) | 100.56 (返0.01) |
| **担保人收益** | 无 | 无 | 解冻100+赚0.084 |

---

## 6. 动态风控引擎

### 6.1 信用分阶梯

| 信用分 | 基础利率 | 基础限额 | 风险等级映射 |
|--------|---------|---------|------------|
| 300 | 13.8% | — | riskScore<40 |
| 600 | 10.0% | 1,000 | riskScore≥40 |
| 650 | 8.0% | 2,000 | riskScore≥60 |
| 700 | 6.0% | 5,000 | riskScore≥70 |
| 750 | 4.0% | 10,000 | riskScore≥80 |
| 800 | 4.0% | 20,000 | riskScore≥80 |
| 850 | 4.0% | 50,000 | riskScore≥80 |

### 6.2 动态利率调整 (`getLoanRate`)

```
finalRate = baseRate × (1 + (1 - 资金池可用率) × 0.5)
钳位上限: baseRate × 2.0

示例: 信用分650 → baseRate=8%, 资金池可用率=30%
  finalRate = 8% × (1 + 0.7 × 0.5) = 8% × 1.35 = 10.8%
```

资金池越紧张 → 利率越高 → 抑制借款需求、吸引出资

### 6.3 动态借款限额 (`getLoanLimit`)

```
baseLimit = 信用分阶梯值
riskMultiplier: ≥80→1.2, ≥60→1.0, ≥40→0.7, <40→0.5

若 creditScore ≥ 700: finalLimit = baseLimit × riskMultiplier
若 creditScore < 700:
  poolMultiplier: 可用率≥0.6→1.0, ≥0.4→0.8, <0.4→0.5
  finalLimit = baseLimit × riskMultiplier × poolMultiplier
```

高信用分用户（≥700）不受资金池可用率影响，保障优质用户借款权。

### 6.4 动态挑战阈值 (`getChallengeThreshold`)

```
操作类型: borrow=5000, redeem=10000 (基础阈值)
riskMultiplier: ≥80→1.5, ≥60→1.0, ≥40→0.7, <40→0.5
下限: 2000

示例: 风险分70 → 阈值=5000×1.0=5000
      风险分30 → 阈值=max(5000×0.5, 2000)=2500
```

高风险用户触发大额挑战的门槛更低，增加额外验证层。

### 6.5 罚息阶梯 (`getOverduePenaltyRate`)

| 逾期天数 | 罚息倍率 | 说明 |
|---------|---------|------|
| ≤7 | 1.5× | 轻度逾期 |
| ≤15 | 2.0× | 中度逾期（触发代偿阈值） |
| ≤30 | 2.5× | 重度逾期 |
| >30 | 3.0× | 严重逾期 |

### 6.6 信用分变动规则 (`CREDIT_RULES.SCORE_CHANGES`)

| 事件 | 变动 | 原因码 |
|------|------|--------|
| 按时还款 | +10 | `ON_TIME_REPAYMENT` |
| 提前还款 | +5 | `EARLY_REPAYMENT` |
| 出资奖励 | +2 | `INVEST_REWARD` |
| 频繁借款惩罚 | -5 | `FREQUENCY_PENALTY` |
| 逾期1-7天 | -5 | `LATE_REPAYMENT_1` |
| 逾期8-15天 | -15 | `LATE_REPAYMENT_2` |
| 逾期16天+ | -30 | `LATE_REPAYMENT_3` |
| 担保成功 | +2 | `担保成功奖励` |
| 担保代偿 | -10 | `担保代偿惩戒` |

信用分钳位到 [300, 850]，通过 `updateCreditScore(userId, delta, reason, transactionId)` 更新，内部使用 `FOR UPDATE` 行锁+SM4加密。

---

## 7. 新用户冷静期机制

### 7.1 冷静期参数 (`getCoolingOff`)

| 用户风险分 | 冷静期天数 | 限额比例 |
|-----------|-----------|---------|
| ≥60 (中低风险) | 7天 | 50% |
| ≥40 (中风险) | 14天 | 30% |
| <40 (较高风险) | 21天 | 20% |

### 7.2 三种模式在冷静期内的差异处理

```javascript
// loan.js:274-308

if (注册天数 < 冷静期天数) {
    actualLoanLimit = loanLimit × 冷静期比例 - 已借金额

    if (risk_mode === 0) {        // 纯信用借款
        actualLoanLimit *= 0.5     // ← 额外缩减50%
    }
    // risk_mode === 1 (押金)     // 无额外缩减，自有资金已增信
    // risk_mode === 2 (担保)     // 无额外缩减，担保人已分担风险
}
```

**设计意图：**
- 纯信用模式的额外缩减从"注册<7天且非担保"改为"冷静期内且纯信用"，更精确地针对无任何风控增强的新用户
- 押金和担保模式本身已提供了风险缓释（资金冻结或第三方担保），因此不叠加额外缩减
- 这种差异化处理**倒逼新用户采用风控增强模式**，降低平台整体风险敞口

### 7.3 冷静期完整计算示例

```
场景: 新用户注册0天, 信用分650, 无逾期, 申请借款500
基础限额: 2000 (信用分650)
风险乘数: 1.0 (riskScore≥60)
最终限额: 2000
已借金额: 0

冷静期 (riskScore≥60 → 7天 50%):
  actualLoanLimit = 2000 × 0.5 - 0 = 1000

纯信用 (risk_mode=0):
  actualLoanLimit = 1000 × 0.5 = 500  ← 可借500

押金/担保 (risk_mode=1/2):
  actualLoanLimit = 1000             ← 可借1000
```

---

## 8. 担保人激励与惩罚机制

### 8.1 忠诚度等级

| 完成担保次数 | 额外奖励比例 | 费率折扣 | 等级称号 |
|------------|------------|---------|---------|
| ≥3 | +5% | -5% | 铜牌担保人 |
| ≥5 | +10% | -10% | 银牌担保人 |
| ≥10 | +15% | -15% | 金牌担保人 |
| ≥20 | +20% | — | 钻石担保人 |

### 8.2 收益计算

```
担保费率: baseRate × 0.15 × (1 - 费率折扣)
担保费金额: loanAmount × feeRate
担保人基础收益: feeAmount × 0.70
忠诚度额外奖励: 担保人基础收益 × 额外奖励比例

担保人实际到手: 担保人基础收益 + 忠诚度额外奖励
```

### 8.3 信用分双向联动

| 场景 | 担保人信用分 | 借款人信用分 |
|------|------------|------------|
| 正常还款完成 | **+2** | +10 (按时还款) |
| 提前还款 | **+2** | +5 (提前还款) |
| 部分还款 | 不变 | 不变 |
| 逾期≤15天 | 不变 | -5/-15 (按逾期天数) |
| 逾期>15天（代偿执行） | **-10** | -30 (严重逾期) |

### 8.4 担保人权益展示

- **可选担保人列表：** 显示担保次数 + 忠诚度等级徽章（铜/银/金/钻）
- **已接受邀约列表：** 显示担保次数 + "(享忠诚度奖励)" 标签
- **费率折扣：** 在 `calculateGuaranteeFee` 中自动计算，担保次数越高费率越低

---

## 9. 还款全流程

### 9.1 全额还款流程

```
POST /api/v1/loan/repay { userId, transactionId, creditProof, verificationCode, signature }

1. 参数校验 + 数据隔离检查
2. 验证交易归属 (transaction.user_id === userId)
3. SM2签名验证 (keyOrder: ['creditProofId', 'transactionId', 'userId'])
4. 信用证明+口令验证
5. 检查交易状态 (type='loan' AND status='pending')
6. 计算实际利息:
   ├─ actualDays = 借款日到今日天数
   ├─ 未逾期: finalInterest = min(实际利息, 约定利息)
   └─ 已逾期: finalInterest = 约定利息 + 逾期罚息(penaltyMultiplier×dailyRate)
7. poolService.repay(userId, principal, finalInterest, { transactionId, newStatus: 'completed' })
   ├─ 扣减用户余额: balance -= totalRepayment
   ├─ 更新资金池: PC↑/UC↑ (按借款比例归还), LA↓
   └─ 更新交易状态: status='completed'
8. 更新信用分 (按时/提前/逾期)
9. afterRepay hook (释放保证金/结算担保/信用分联动)
10. 异步区块链存证
```

### 9.2 部分还款流程

```
POST /api/v1/loan/repay { partialAmount: 50 }

1-6. 同全额还款验证流程
7. 利息优先扣除:
   ├─ if actualRepayAmount ≥ finalInterest: paidInterest=finalInterest, paidPrincipal=实际-利息
   └─ else: paidInterest=实际还款额, paidPrincipal=0
8. 计算剩余:
   ├─ remainingPrincipal = principal - paidPrincipal
   ├─ 使用原始利率重新计算剩余利息
   └─ newStatus = remainingPrincipal≤0 ? 'completed' : 'pending'
9. poolService.repay(userId, paidPrincipal, paidInterest, { loanUpdateFields })
10。 onPartialRepay hook (按比例释放担保额度)
    └─ releaseAmount = guaranteeAmount × (paidPrincipal / totalPrincipal)
    └─ frozen_balance -= releaseAmount → balance += releaseAmount
11。 返回部分还款结果（不更新信用分）
```

---

## 10. 出资与赎回流程

### 10.1 出资流程 (`investFromUser`)

```
POST /api/v1/invest

1. 信用分验证: credit_score ≥ 600
2. 计算出资利率: getCurrentLendingRate()
   ├─ 加权平均: Σ(每笔完成贷款的 年化利率 × 本金) / 总本金
   ├─ 减去平台利差: getPlatformSpread()
   │   └─ 基础2% + 利用率溢价 + 逾期溢价
   └─ 钳位到 [2%, 15%]
3. 锁定资金池: SELECT * FROM fund_pool FOR UPDATE
4. 扣减用户余额: balance -= amount
5. 增加用户池: user_capital += amount
6. 创建出资记录: type='invest', status='pending'
7. 异步区块链存证
```

### 10.2 赎回流程 (`redeemFromPool`)

```
POST /api/v1/redeem

1-4. 同借款安全验证流程
5. 流动性检查:
   ├─ availableRatio≥60%: 全额赎回
   ├─ availableRatio≥40%: 部分赎回
   └─ availableRatio<40%: 排队赎回
6. 计算收益: actualInterest = amount × dailyRate × 实际天数
7. poolService.redeemFromPool(userId, amount, actualInterest, transactionId)
   ├─ 扣资金池: user_capital -= amount
   ├─ 加用户余额: balance += amount + actualInterest
   └─ 创建赎回记录
8. 更新信用分: +2 (出资奖励)
9. 异步区块链存证
```

---

## 11. 密码学与安全体系

### 11.1 国密算法套件

| 算法 | 用途 | 实现 |
|------|------|------|
| **SM2** | 非对称签名 | 借款/还款/担保邀约签发；verifySM2Signature |
| **SM3** | 哈希摘要 | 区块链存证 (SM3 Hash)；PBKDF2密码哈希 |
| **SM4-CBC** | 对称字段加密 | balance, frozen_balance, credit_score, amount, interest 加密存储 |

### 11.2 零知识证明 (Groth16 SNARK)

```
信用分范围证明: "我的信用分 ≥ 600, 但不泄露具体数值"

生成 (前端/后端):
  ├─ snarkjs groth16 prove
  ├─ input: { creditScore, threshold }
  └─ output: { proof (pi_a, pi_b, pi_c), publicSignals }

验证 (后端):
  ├─ verifyProof(proof, publicSignals)
  ├─ 支持后端本地验证 + 链上存证
  └─ proof 有效期 30 天
```

### 11.3 KMS密钥管理

```
DKMS (Decentralized Key Management):
  ├─ 多节点分片 (SSS秘密共享)
  ├─ DEK (数据加密密钥) 加密存储
  ├─ SM4 加密/解密通过 getDEK(userId) 获取密钥
  └─ AAD (附加认证数据): {table}:{field}:{userId}
```

### 11.4 防重放机制

```
POST 请求签名流程:
  1. 前端构建请求体
  2. dispatchEvent('finzktrust:sign-request') → App.js 响应
  3. 使用 AES 解密私钥 → SM2 签名
  4. 附加 antiReplay 签名头
  5. 后端 antiReplayMiddleware 验证
```

---

## 12. 数据库架构

### 12.1 核心表

```sql
-- 资金池 (单行表)
fund_pool: id, total_amount, available_amount, reserved_amount,
           platform_capital, user_capital, loaned_amount,
           total_interest_earned, user_interest_earned

-- 用户 (SM4字段加密: balance, frozen_balance, credit_score)
users: id, username, password_hash, balance, frozen_balance,
       credit_score, sm2_public_key, sm2_private_key_encrypted, ...

-- 交易流水
transactions: id, user_id, type, amount, interest, total_amount,
              status, due_date, term, borrow_user_ratio,
              borrow_platform_ratio, risk_mode,
              margin_order_id, guarantee_contract_id

-- 信用证明
credit_proofs: id, user_id, proof_id, proof_data, verification_code,
               expires_at, sm3_hash, chain_verified

-- 保证金订单
risk_margin_orders: id, loan_id, user_id, margin_amount, margin_rate,
                    frozen_interest, status

-- 担保请求
guarantee_requests: id, borrower_id, guarantor_id, loan_amount,
                    proposed_fee_rate, status, expire_time,
                    borrower_signature, guarantor_signature

-- 担保合约
risk_guarantee_contracts: id, loan_id, borrower_id, guarantor_id,
                          guarantee_amount, fee_rate, fee_amount,
                          status, guarantor_signature, signature_data,
                          expire_time
```

### 12.2 状态机

```
guarantee_requests:
  PENDING → ACCEPTED → USED     (正常路径)
  PENDING → REJECTED            (担保人拒绝)
  PENDING → EXPIRED             (24小时超时)

risk_guarantee_contracts:
  PENDING → ACTIVE → COMPLETED  (正常路径)
  PENDING → ACTIVE → LIQUIDATED (代偿路径)

risk_margin_orders:
  FROZEN → RELEASED              (正常还款)
  FROZEN → LIQUIDATED            (逾期没收)

transactions:
  pending → completed            (正常还款)
  pending → overdue              (逾期标记)
  pending → completed (部分还款，remainingPrincipal=0)
```

---

## 13. 环境变量与特性开关

| 变量 | 默认值 | 作用 |
|------|--------|------|
| `FEATURE_RISK_ENHANCE` | `ON` | 风控增强总开关（押金+担保模式） |
| `GUARANTEE_FEE_RATE_MULTIPLIER` | `0.15` | 担保费率 = 基础利率 × 此值 |
| `GUARANTEE_INSURANCE_FUND_RATIO` | `0.20` | 平台拨备比例（担保费分配） |
| `GUARANTEE_BORROWER_REWARD_RATIO` | `0.10` | 借款人奖励返还比例 |
| `GUARANTEE_COMPENSATION_THRESHOLD_DAYS` | `15` | 逾期多少天后触发代偿 |
| `GUARANTEE_MAX_RATIO_TO_NET_ASSET` | `2.0` | 担保总额/余额上限 |
| `GUARANTEE_MAX_ACTIVE_CONTRACTS` | `5` | 最多同时担保笔数 |
| `GUARANTEE_MIN_CREDIT_SCORE` | `650` | 担保人最低信用分 |
| `GUARANTEE_MIN_REGISTRATION_DAYS` | `180` | 担保人最低注册天数 |
| `MARGIN_BASE_RATE` | `0.20` | 保证金基准费率 |
| `MARGIN_MIN_RATE` | `0.15` | 保证金最低费率 |
| `MARGIN_MAX_RATE` | `0.25` | 保证金最高费率 |
| `SYSTEM_POOL_RESERVE_RATIO` | `0.20` | 系统池最低保留比例 |
| `INITIAL_PLATFORM_CAPITAL` | `30000` | 平台初始资金 |
| `JWT_SECRET` | — | JWT签名密钥 |

---

## 附录A：API路由速查

| 方法 | 路径 | 安全级别 | 功能 |
|------|------|---------|------|
| POST | `/api/v1/loan/borrow` | financial | 借款（三模式统一入口） |
| POST | `/api/v1/loan/apply` | financial | 借款别名 |
| POST | `/api/v1/loan/repay` | financial | 还款（支持全额/部分） |
| GET | `/api/v1/loan/config/:userId` | authenticated | 动态借款配置+riskOptions |
| GET | `/api/v1/loan/transactions/:userId` | authenticated | 交易历史 |
| POST | `/api/v1/loan/verify-transaction` | authenticated | 区块链存证验证 |
| POST | `/api/v1/invest` | financial | 用户出资 |
| POST | `/api/v1/redeem` | financial | 赎回出资 |
| POST | `/api/v1/margin/calculate` | authenticated | 计算保证金参数 |
| GET | `/api/v1/margin/orders/:userId` | authenticated | 保证金订单列表 |
| GET | `/api/v1/margin/orders/detail/:orderId` | authenticated | 保证金订单详情 |
| GET | `/api/v1/guarantee/eligible-guarantors` | authenticated | 可选担保人列表 |
| POST | `/api/v1/guarantee/request` | financial | 创建担保邀约 |
| POST | `/api/v1/guarantee/accept/:requestId` | financial | 接受担保邀约 |
| POST | `/api/v1/guarantee/reject/:requestId` | authenticated | 拒绝担保邀约 |
| GET | `/api/v1/guarantee/accepted-requests` | authenticated | 已接受邀约（借款人） |
| GET | `/api/v1/guarantee/pending-requests` | authenticated | 待处理邀约（担保人） |
| GET | `/api/v1/guarantee/contract/:contractId` | authenticated | 担保合约详情 |
| POST | `/api/v1/zk/generate-proof` | authenticated | 降级后端生成ZKP |
| GET | `/api/v1/notifications` | authenticated | 通知列表 |
| GET | `/api/v1/notifications/unread-count` | authenticated | 未读通知数 |
| POST | `/api/v1/notifications/:id/read` | authenticated | 标记通知已读 |

---

## 附录B：担保邀约定时过期

系统每 **10分钟** 自动执行一次过期清理：

```javascript
// app.js — 服务启动时注册
setInterval(async () => {
  const guaranteeRequestDao = require('./dao/guaranteeRequestDao');
  const affected = await guaranteeRequestDao.cleanExpired();
  // UPDATE guarantee_requests SET status='EXPIRED'
  // WHERE status='PENDING' AND expire_time < NOW()
}, 10 * 60 * 1000);
```

---

## 附录C：担保额度按比例逐期释放

部分还款时自动按比例解冻担保金额：

```
releaseAmount = guaranteeAmount × (本次还本金 / 借款总本金)

→ frozen_balance -= releaseAmount  (担保人冻结额减少)
→ balance += releaseAmount          (担保人可用余额增加)
```

该机制确保担保人的风险敞口随借款人还款进度同步递减，全额还清时 `releaseGuarantorQuota` 释放剩余冻结金额并结算担保收益。

---
