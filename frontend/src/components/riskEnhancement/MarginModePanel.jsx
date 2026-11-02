import React from 'react';
import { Alert, AlertTitle, Typography, Box } from '@mui/material';
import AccountBalanceWalletIcon from '@mui/icons-material/AccountBalanceWallet';

/**
 * Margin (Deposit) Mode Panel
 * Displays deposit details and warns if user balance is insufficient
 */
const MarginModePanel = ({
  loanAmount,
  marginRate,
  marginAmount,
  userBalance,
}) => {
  if (!process.env.REACT_APP_RISK_ENHANCEMENT_ENABLED) {
    return null;
  }

  const loanAmountNum = Number(loanAmount) || 0;
  const marginRateNum = Number(marginRate) || 0;
  const marginAmountNum = Number(marginAmount) || 0;
  const userBalanceNum = Number(userBalance) || 0;

  if (loanAmountNum <= 0) {
    return null;
  }

  const isInsufficient = userBalanceNum < marginAmountNum;

  return (
    <Alert
      severity={isInsufficient ? 'warning' : 'info'}
      icon={<AccountBalanceWalletIcon />}
      sx={{ mb: 2 }}
    >
      <AlertTitle>押金借款详情</AlertTitle>
      <Box sx={{ mb: 1 }}>
        <Typography variant="body2">
          借款金额: ¥{loanAmountNum.toFixed(2)}
        </Typography>
        <Typography variant="body2">
          押金费率: {(marginRateNum * 100).toFixed(1)}%
        </Typography>
        <Typography variant="body2" sx={{ fontWeight: 'bold' }}>
          需缴纳押金: ¥{marginAmountNum.toFixed(2)}
        </Typography>
        <Typography variant="body2">
          您的余额: ¥{userBalanceNum.toFixed(2)}
        </Typography>
      </Box>
      {isInsufficient && (
        <Typography variant="body2" color="error" sx={{ fontWeight: 'bold' }}>
          余额不足，请先充值 ¥{(marginAmountNum - userBalanceNum).toFixed(2)} 以满足押金要求
        </Typography>
      )}
      <Typography variant="caption" color="text.secondary">
        按时还款后押金全额退还
      </Typography>
    </Alert>
  );
};

export default MarginModePanel;
