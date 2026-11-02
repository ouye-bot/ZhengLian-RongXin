/**
 * 进程内 TTL 缓存（Map 实现，无新依赖）
 *
 * 定位：高频只读查询的短 TTL 缓存。写路径在数据变更**提交后**调用失效函数主动 erase，
 * TTL 仅作为兜底过期（含多实例部署时跨实例失效窗口的上界——当前运维为单进程 3003）。
 *
 * poolCache：资金池相关读缓存的共享实例（key: 'poolInfo' | 'poolHealth' | 'lendingRate'）。
 * 读点：
 *   - services/poolService.getPoolInfo
 *   - services/dynamicConfigService.getPoolHealth
 *   - services/interestRateService.getCurrentLendingRate
 *
 * 写失效点（invalidatePoolReadCaches，放本模块以免 dao/service/riskPlugins 互相引用成环）——
 * fund_pool 的运行时写入**不止** poolDao 一处，各业务事务内直接 UPDATE fund_pool，
 * 因此每个写路径都必须在其事务提交之后显式调用（提交前失效会被并发读者用未提交前的旧值回填）：
 *   - dao/poolDao.updatePool / updatePoolV2
 *   - services/poolService.invest / redeem / borrowFromPool / repay
 *   - services/riskPlugins/marginEngine.releaseMargin / liquidateMargin（自有事务分支）
 *   - services/riskPlugins/guaranteeEngine.settleGuaranteeRevenue / executeGuaranteeCompensation（自有事务分支）
 *   - services/overdueService.liquidateOverdueLoans（上两类插件以外层 connection 嵌套调用时，由此处在外层提交后失效）
 *   - services/autoRedeemService.autoRedeemMaturedInvestments
 * 新增 fund_pool 写点时必须同步挂接；test/zkp-threshold-check.js 组4d 以真实业务写（invest）校验即时反映。
 */
class TtlCache {
  /**
   * @param {number} ttlMs 条目存活毫秒数
   */
  constructor(ttlMs) {
    this.ttlMs = ttlMs;
    this.store = new Map(); // key -> { value, expireAt }
  }

  /** 命中且未过期返回值；过期条目顺手清除并返回 undefined */
  get(key) {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (Date.now() >= entry.expireAt) {
      this.store.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key, value) {
    this.store.set(key, { value, expireAt: Date.now() + this.ttlMs });
  }

  erase(key) {
    this.store.delete(key);
  }

  /**
   * 读取缓存；未命中/已过期则调用 loadFn 取数并写缓存。
   * loadFn 抛错时不缓存、异常原样上抛（调用方按无缓存时的错误路径处理）。
   */
  async getOrLoad(key, loadFn) {
    const hit = this.get(key);
    if (hit !== undefined) return hit;
    const value = await loadFn();
    this.set(key, value);
    return value;
  }

  /** 清理全部过期条目（供周期任务顺带调用，防 Map 无界增长） */
  sweepExpired() {
    const now = Date.now();
    for (const [key, entry] of this.store.entries()) {
      if (now >= entry.expireAt) this.store.delete(key);
    }
  }
}

const POOL_TTL_MS = 5000;

const poolCache = new TtlCache(POOL_TTL_MS);

/**
 * 资金池数据变更提交后统一失效所有池相关读缓存（见文件头"写失效点"清单）。
 * 必须在事务 commit 之后调用；同步、幂等、无副作用，可在任意写路径尾部安全重复调用。
 */
const invalidatePoolReadCaches = () => {
  poolCache.erase('poolInfo');
  poolCache.erase('poolHealth');
  poolCache.erase('lendingRate'); // 池写多伴随借贷流水落库，出资利率按 loans 全表计算，一并失效
};

module.exports = { TtlCache, poolCache, invalidatePoolReadCaches };
