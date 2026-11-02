/**
 * 根据信用分获取年利率（百分比）
 * @param {number} creditScore - 信用分
 * @returns {number} 年利率（如 6.0 表示 6%）
 */
const getInterestRate = (creditScore) => {
  const rates = { 750: 4.0, 700: 6.0, 650: 8.0, 600: 10.0, 300: 13.8 };
  const scores = Object.keys(rates).map(Number).sort((a, b) => b - a);
  for (const s of scores) {
    if (creditScore >= s) return rates[s];
  }
  return 13.8;
};

module.exports = { getInterestRate };
