import React, { useState } from 'react';
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
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Snackbar,
} from '@mui/material';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import CancelIcon from '@mui/icons-material/Cancel';
import { signWithSM2, getSM2KeyPairWithAesKey } from '../../utils/sm2Utils';

/**
 * Guarantee Pending List
 * Displays pending guarantee requests for the current user (as guarantor)
 * with accept/reject actions
 */
const GuaranteePendingList = ({
  pendingRequests,
  loading,
  onAccept,
  onReject,
  aesKey,
  onRefresh,
}) => {
  const [actionLoading, setActionLoading] = useState(null);
  const [confirmDialog, setConfirmDialog] = useState(null);
  const [actionType, setActionType] = useState(null);
  const [snackbar, setSnackbar] = useState({ open: false, message: '', severity: 'success' });

  if (!process.env.REACT_APP_RISK_ENHANCEMENT_ENABLED) {
    return null;
  }

  const requests = pendingRequests || [];

  const handleAction = (request, type) => {
    setConfirmDialog(request);
    setActionType(type);
  };

  const confirmAction = async () => {
    if (!confirmDialog || !actionType) return;

    setActionLoading(confirmDialog.id);
    try {
      if (actionType === 'accept') {
        if (!aesKey) {
          setSnackbar({ open: true, message: 'AES密钥不存在，请重新登录', severity: 'error' });
          return;
        }
        const keyPair = await getSM2KeyPairWithAesKey(aesKey);
        if (!keyPair?.privateKey) {
          setSnackbar({ open: true, message: '无法获取SM2密钥对', severity: 'error' });
          return;
        }

        const signatureData = JSON.stringify({
          guarantorId: String(confirmDialog.guarantor_id),
          loanAmount: String(confirmDialog.loan_amount),
          requestId: String(confirmDialog.id),
        });
        const signature = signWithSM2(signatureData, keyPair.privateKey);
        keyPair.privateKey = null;

        const result = await onAccept(confirmDialog.id, signature);
        if (result?.success === false) {
          setSnackbar({ open: true, message: result.message || '接受失败', severity: 'error' });
        } else {
          setSnackbar({ open: true, message: '担保邀约已接受', severity: 'success' });
          if (onRefresh) onRefresh();
        }
      } else {
        const result = await onReject(confirmDialog.id);
        if (result?.success === false) {
          setSnackbar({ open: true, message: result.message || '拒绝失败', severity: 'error' });
        } else {
          setSnackbar({ open: true, message: '担保邀约已拒绝', severity: 'success' });
          if (onRefresh) onRefresh();
        }
      }
    } catch (err) {
      console.error('操作失败:', err);
      setSnackbar({ open: true, message: err.message || '操作失败', severity: 'error' });
    } finally {
      setActionLoading(null);
      setConfirmDialog(null);
      setActionType(null);
    }
  };

  return (
    <Alert severity="warning" sx={{ mb: 2 }}>
      <AlertTitle>待处理担保邀约</AlertTitle>
      <Typography variant="body2" sx={{ mb: 1 }}>
        以下用户邀请您为其借款提供担保
      </Typography>

      {loading ? (
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 2 }}>
          <CircularProgress size={24} />
        </Box>
      ) : requests.length === 0 ? (
        <Typography variant="body2" color="text.secondary" sx={{ py: 1 }}>
          暂无待处理的担保邀约
        </Typography>
      ) : (
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
                        {req.borrower?.username || '用户'}
                      </Typography>
                      <Chip
                        label={`信用分: ${req.borrower?.creditScore || 0}`}
                        size="small"
                        color={(req.borrower?.creditScore || 0) >= 700 ? 'success' : 'default'}
                      />
                    </Box>
                  }
                  secondary={
                    <Typography variant="caption" color="text.secondary">
                      借款金额: ¥{Number(req.loan_amount || 0).toFixed(2)} |
                      担保费率: {(Number(req.proposed_fee_rate || 0) * 100).toFixed(2)}%
                    </Typography>
                  }
                />
              </Box>
              <Box sx={{ display: 'flex', gap: 1, alignSelf: 'flex-end' }}>
                <Button
                  variant="contained"
                  color="success"
                  size="small"
                  startIcon={<CheckCircleIcon />}
                  onClick={() => handleAction(req, 'accept')}
                  disabled={actionLoading === req.id}
                >
                  {actionLoading === req.id ? <CircularProgress size={16} /> : '接受'}
                </Button>
                <Button
                  variant="outlined"
                  color="error"
                  size="small"
                  startIcon={<CancelIcon />}
                  onClick={() => handleAction(req, 'reject')}
                  disabled={actionLoading === req.id}
                >
                  拒绝
                </Button>
              </Box>
            </ListItem>
          ))}
        </List>
      )}

      {/* Confirmation Dialog */}
      <Dialog open={!!confirmDialog} onClose={() => setConfirmDialog(null)}>
        <DialogTitle>
          {actionType === 'accept' ? '确认接受担保邀约' : '确认拒绝担保邀约'}
        </DialogTitle>
        <DialogContent>
          <Typography>
            {actionType === 'accept'
              ? `您确定要为 ${confirmDialog?.borrower?.username || '该用户'} 提供担保吗？借款金额: ¥${Number(confirmDialog?.loan_amount || 0).toFixed(2)}`
              : `您确定要拒绝 ${confirmDialog?.borrower?.username || '该用户'} 的担保邀请吗？`}
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirmDialog(null)}>取消</Button>
          <Button
            onClick={confirmAction}
            variant="contained"
            color={actionType === 'accept' ? 'success' : 'error'}
            disabled={actionLoading !== null}
          >
            {actionLoading ? <CircularProgress size={20} /> : '确认'}
          </Button>
        </DialogActions>
      </Dialog>

      {/* Feedback Snackbar */}
      <Snackbar
        open={snackbar.open}
        autoHideDuration={4000}
        onClose={() => setSnackbar(prev => ({ ...prev, open: false }))}
        anchorOrigin={{ vertical: 'top', horizontal: 'center' }}
      >
        <Alert
          severity={snackbar.severity}
          onClose={() => setSnackbar(prev => ({ ...prev, open: false }))}
          variant="filled"
        >
          {snackbar.message}
        </Alert>
      </Snackbar>
    </Alert>
  );
};

export default GuaranteePendingList;
