import React from 'react';
import {
  Card,
  CardContent,
  CardActionArea,
  Typography,
  Grid,
  Chip,
  Box,
} from '@mui/material';
import SecurityIcon from '@mui/icons-material/Security';
import AccountBalanceIcon from '@mui/icons-material/AccountBalance';
import GroupIcon from '@mui/icons-material/Group';
import { calculateMarginRate, calculateMarginAmount } from '../../utils/riskEnhancementUtils';

/**
 * Risk Enhancement Mode Selector
 * Displays 3 cards for selecting risk mode: pure credit, deposit, or guarantee
 */
const RiskEnhanceSelector = ({
  loanAmount,
  creditScore,
  term,
  riskMode,
  onSelectMode,
  disabled,
}) => {
  if (!process.env.REACT_APP_RISK_ENHANCEMENT_ENABLED) {
    return null;
  }

  const loanAmountNum = Number(loanAmount) || 0;
  const creditScoreNum = Number(creditScore) || 0;
  const termNum = Number(term) || 30;

  const marginRate = calculateMarginRate(creditScoreNum, termNum);
  const marginAmount = calculateMarginAmount(loanAmountNum, creditScoreNum, termNum);

  const modes = [
    {
      id: 0,
      label: '纯信用',
      description: '无需额外押金或担保',
      icon: <SecurityIcon sx={{ fontSize: 40 }} />,
      color: '#1976d2',
    },
    {
      id: 1,
      label: '押金借款',
      description: '缴纳押金降低风险',
      icon: <AccountBalanceIcon sx={{ fontSize: 40 }} />,
      color: '#388e3c',
      badge: '推荐',
      showMargin: loanAmountNum > 0,
    },
    {
      id: 2,
      label: '担保借款',
      description: '由担保人提供担保',
      icon: <GroupIcon sx={{ fontSize: 40 }} />,
      color: '#7b1fa2',
    },
  ];

  return (
    <Box sx={{ mb: 2 }}>
      <Typography variant="subtitle1" gutterBottom sx={{ fontWeight: 'bold' }}>
        借款模式
      </Typography>
      <Grid container spacing={2}>
        {modes.map((mode) => (
          <Grid item xs={12} sm={4} key={mode.id}>
            <Card
              sx={{
                border: riskMode === mode.id ? `2px solid ${mode.color}` : '1px solid #e0e0e0',
                boxShadow: riskMode === mode.id ? 3 : 1,
                transition: 'all 0.2s ease-in-out',
                position: 'relative',
              }}
            >
              {mode.badge && (
                <Chip
                  label={mode.badge}
                  color="success"
                  size="small"
                  sx={{
                    position: 'absolute',
                    top: 8,
                    right: 8,
                    zIndex: 1,
                  }}
                />
              )}
              <CardActionArea
                onClick={() => onSelectMode(mode.id)}
                disabled={disabled}
                sx={{ p: 2 }}
              >
                <CardContent sx={{ textAlign: 'center' }}>
                  <Box sx={{ color: mode.color, mb: 1 }}>
                    {mode.icon}
                  </Box>
                  <Typography variant="h6" gutterBottom>
                    {mode.label}
                  </Typography>
                  <Typography variant="body2" color="text.secondary">
                    {mode.description}
                  </Typography>
                  {mode.showMargin && riskMode === mode.id && (
                    <Box sx={{ mt: 1 }}>
                      <Typography variant="caption" color="text.secondary">
                        押金费率: {(marginRate * 100).toFixed(1)}%
                      </Typography>
                      <Typography variant="body2" color="primary" sx={{ fontWeight: 'bold' }}>
                        押金金额: ¥{marginAmount.toFixed(2)}
                      </Typography>
                    </Box>
                  )}
                </CardContent>
              </CardActionArea>
            </Card>
          </Grid>
        ))}
      </Grid>
    </Box>
  );
};

export default RiskEnhanceSelector;
