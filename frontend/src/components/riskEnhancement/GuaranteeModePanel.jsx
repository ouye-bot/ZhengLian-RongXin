import React from 'react';
import {
  Alert,
  AlertTitle,
  List,
  ListItem,
  ListItemText,
  ListItemSecondaryAction,
  Button,
  Chip,
  Box,
  Typography,
  CircularProgress,
  Tooltip,
} from '@mui/material';
import GroupIcon from '@mui/icons-material/Group';
import WorkspacePremiumIcon from '@mui/icons-material/WorkspacePremium';

/**
 * Guarantee Mode Panel
 * Displays list of eligible guarantors with invite buttons
 */
const GuaranteeModePanel = ({
  eligibleGuarantors,
  loading,
  onSelectGuarantor,
  loanAmount,
}) => {
  if (!process.env.REACT_APP_RISK_ENHANCEMENT_ENABLED) {
    return null;
  }

  const guarantors = eligibleGuarantors || [];
  const loanAmountNum = Number(loanAmount) || 0;

  return (
    <Alert severity="info" icon={<GroupIcon />} sx={{ mb: 2 }}>
      <AlertTitle>担保借款</AlertTitle>
      <Typography variant="body2" sx={{ mb: 1 }}>
        以下用户可为您的借款提供担保（借款金额: ¥{loanAmountNum.toFixed(2)}）
      </Typography>

      {loading ? (
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 2 }}>
          <CircularProgress size={24} />
        </Box>
      ) : guarantors.length === 0 ? (
        <Typography variant="body2" color="text.secondary" sx={{ py: 1 }}>
          暂无可用担保人
        </Typography>
      ) : (
        <List dense>
          {guarantors.map((guarantor) => (
            <ListItem
              key={guarantor.id}
              sx={{
                border: '1px solid #e0e0e0',
                borderRadius: 1,
                mb: 1,
              }}
            >
              <ListItemText
                primary={
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                    <Typography variant="body1" sx={{ fontWeight: 'bold' }}>
                      {guarantor.username || guarantor.name || '用户'}
                    </Typography>
                    <Chip
                      label={`信用分: ${guarantor.credit_score || guarantor.creditScore || 0}`}
                      size="small"
                      color={
                        (guarantor.credit_score || guarantor.creditScore || 0) >= 800
                          ? 'success'
                          : (guarantor.credit_score || guarantor.creditScore || 0) >= 600
                          ? 'primary'
                          : 'default'
                      }
                    />
                  </Box>
                }
                secondary={
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                    <Typography variant="caption" color="text.secondary">
                      担保次数: {guarantor.guaranteeCount || 0}
                    </Typography>
                    {guarantor.guaranteeCount >= 3 && (
                      <Tooltip title={`忠诚度奖励: ${guarantor.guaranteeCount >= 20 ? '20%' : guarantor.guaranteeCount >= 10 ? '15%' : guarantor.guaranteeCount >= 5 ? '10%' : '5%'}`}>
                        <Chip
                          icon={<WorkspacePremiumIcon sx={{ fontSize: 14 }} />}
                          label={`忠诚${guarantor.guaranteeCount >= 20 ? '钻石' : guarantor.guaranteeCount >= 10 ? '金牌' : guarantor.guaranteeCount >= 5 ? '银牌' : '铜牌'}`}
                          size="small"
                          color="warning"
                          sx={{ height: 20, fontSize: 11 }}
                        />
                      </Tooltip>
                    )}
                  </Box>
                }
              />
              <ListItemSecondaryAction>
                <Button
                  variant="contained"
                  color="primary"
                  size="small"
                  onClick={() => onSelectGuarantor(guarantor)}
                >
                  邀请
                </Button>
              </ListItemSecondaryAction>
            </ListItem>
          ))}
        </List>
      )}
    </Alert>
  );
};

export default GuaranteeModePanel;
