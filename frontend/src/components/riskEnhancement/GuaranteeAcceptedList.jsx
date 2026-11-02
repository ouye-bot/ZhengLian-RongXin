import React from 'react';
import {
  Alert,
  AlertTitle,
  List,
  ListItem,
  ListItemText,
  Button,
  Box,
  Typography,
  Chip,
  CircularProgress,
  Divider,
} from '@mui/material';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import WorkspacePremiumIcon from '@mui/icons-material/WorkspacePremium';

/**
 * Guarantee Accepted List
 * Shows accepted guarantee requests for the borrower,
 * allowing them to proceed with loan creation (Phase 2)
 */
const GuaranteeAcceptedList = ({
  acceptedRequests,
  loading,
  onSelect,
  onRefresh,
}) => {
  if (!process.env.REACT_APP_RISK_ENHANCEMENT_ENABLED) {
    return null;
  }

  const requests = acceptedRequests || [];

  if (loading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', py: 2 }}>
        <CircularProgress size={24} />
      </Box>
    );
  }

  if (requests.length === 0) {
    return null;
  }

  return (
    <Alert severity="success" sx={{ mb: 2 }}>
      <AlertTitle>已接受的担保邀约</AlertTitle>
      <Typography variant="body2" sx={{ mb: 1 }}>
        以下担保人已接受您的邀请，点击"继续借款"完成借款申请
      </Typography>

      <List dense>
        {requests.map((req) => (
          <ListItem
            key={req.id}
            sx={{
              border: '1px solid #e0e0e0',
              borderRadius: 1,
              mb: 1,
              flexDirection: 'column',
              alignItems: 'flex-start',
            }}
          >
            <Box sx={{ display: 'flex', justifyContent: 'space-between', width: '100%', mb: 1 }}>
              <ListItemText
                primary={
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                    <Typography variant="body1" sx={{ fontWeight: 'bold' }}>
                      {req.guarantor?.username || '担保人'}
                    </Typography>
                    <Chip
                      label={`信用分: ${req.guarantor?.creditScore || 0}`}
                      size="small"
                      color={(req.guarantor?.creditScore || 0) >= 700 ? 'success' : 'default'}
                    />
                    {req.guarantor?.guaranteeCount >= 3 && (
                      <Chip
                        icon={<WorkspacePremiumIcon sx={{ fontSize: 14 }} />}
                        label={`忠诚${req.guarantor?.guaranteeCount >= 20 ? '钻石' : req.guarantor?.guaranteeCount >= 10 ? '金牌' : req.guarantor?.guaranteeCount >= 5 ? '银牌' : '铜牌'}`}
                        size="small"
                        color="warning"
                        sx={{ height: 20, fontSize: 11 }}
                      />
                    )}
                  </Box>
                }
                secondary={
                  <Box sx={{ mt: 0.5 }}>
                    <Typography variant="caption" color="text.secondary" display="block">
                      借款金额: ¥{Number(req.loan_amount || 0).toFixed(2)} |
                      担保费率: {(Number(req.proposed_fee_rate || 0) * 100).toFixed(2)}%
                    </Typography>
                    <Typography variant="caption" color="text.secondary" display="block">
                      担保次数: {req.guarantor?.guaranteeCount || 0} 次
                      {req.guarantor?.guaranteeCount >= 3 && (
                        <span style={{ color: '#ed6c02', marginLeft: 4 }}>
                          (享忠诚度奖励)
                        </span>
                      )}
                    </Typography>
                  </Box>
                }
              />
            </Box>
            <Box sx={{ display: 'flex', gap: 1, alignSelf: 'flex-end' }}>
              <Button
                variant="contained"
                color="primary"
                size="small"
                startIcon={<PlayArrowIcon />}
                onClick={() => onSelect(req)}
              >
                继续借款
              </Button>
            </Box>
          </ListItem>
        ))}
      </List>
    </Alert>
  );
};

export default GuaranteeAcceptedList;
