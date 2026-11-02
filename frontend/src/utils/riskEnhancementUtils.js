/**
 * Risk Enhancement Utility Functions
 * Pure utility functions for risk mode calculations (no React dependency)
 */

/**
 * Calculate margin rate based on credit score and term
 * Base rate 0.20, with term premium and credit discount, clamped [0.15, 0.25]
 * @param {number} creditScore - User's credit score
 * @param {number} term - Loan term in days
 * @returns {number} Margin rate between 0.15 and 0.25
 */
export const calculateMarginRate = (creditScore, term) => {
  let rate = 0.20;

  // Term premium
  if (term >= 90) {
    rate += 0.05;
  } else if (term >= 30) {
    rate += 0.03;
  }

  // Credit discount
  if (creditScore >= 800) {
    rate -= 0.05;
  } else if (creditScore >= 700) {
    rate -= 0.03;
  }

  // Clamp to [0.15, 0.25]
  return Math.max(0.15, Math.min(0.25, rate));
};

/**
 * Calculate margin amount
 * @param {number} loanAmount - Loan amount
 * @param {number} creditScore - User's credit score
 * @param {number} term - Loan term in days
 * @returns {number} Margin amount
 */
export const calculateMarginAmount = (loanAmount, creditScore, term) => {
  return loanAmount * calculateMarginRate(creditScore, term);
};

/**
 * Calculate guarantee fee rate
 * @param {number} baseAnnualRate - Base annual interest rate (as percentage, e.g. 12 for 12%)
 * @returns {number} Guarantee fee rate
 */
export const calculateGuaranteeFeeRate = (baseAnnualRate) => {
  return baseAnnualRate * 0.15;
};

/**
 * Calculate detailed guarantee fee information
 * @param {number} loanAmount - Loan amount
 * @param {number} baseAnnualRate - Base annual interest rate (as percentage)
 * @returns {Object} Fee details including rate, amount, and distribution
 */
export const calculateGuaranteeFeeDetail = (loanAmount, baseAnnualRate) => {
  const feeRate = calculateGuaranteeFeeRate(baseAnnualRate);
  const feeAmount = loanAmount * (feeRate / 100);

  return {
    feeRate,
    feeAmount: Math.round(feeAmount * 100) / 100,
    distribution: {
      guarantor: 0.70,
      insuranceFund: 0.20,
      borrowerReward: 0.10,
    },
  };
};

/**
 * Get human-readable label for risk mode
 * @param {number} mode - Risk mode (0, 1, 2)
 * @returns {string} Mode label
 */
export const getRiskModeLabel = (mode) => {
  const labels = {
    0: '纯信用借款',
    1: '押金借款',
    2: '担保借款',
  };
  return labels[mode] || '未知模式';
};

/**
 * Get descriptive text for risk mode
 * @param {number} mode - Risk mode (0, 1, 2)
 * @param {Object} params - Additional parameters for description
 * @param {number} params.marginRate - Margin rate (for mode 1)
 * @param {number} params.marginAmount - Margin amount (for mode 1)
 * @param {number} params.feeRate - Fee rate (for mode 2)
 * @returns {string} Descriptive text
 */
export const getRiskModeDescription = (mode, params = {}) => {
  switch (mode) {
    case 0:
      return '纯信用借款无需额外押金或担保，基于您的信用评分直接放款。信用评分越高，可借额度越大。';
    case 1:
      return `押金借款需要缴纳借款金额 ${(params.marginRate * 100).toFixed(1)}% 的押金（¥${(params.marginAmount || 0).toFixed(2)}），按时还款后押金全额退还。`;
    case 2:
      return `担保借款需要由担保人为您提供担保，担保费率为借款金额的 ${(params.feeRate || 0).toFixed(2)}%。担保人将获得相应的担保收益。`;
    default:
      return '';
  }
};
