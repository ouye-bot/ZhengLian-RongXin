import React, { useState } from 'react';
import {
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Button,
  Typography,
  Box,
  CircularProgress,
  Alert,
  TextField,
} from '@mui/material';
import { signWithSM2, getSM2KeyPairWithAesKey } from '../../utils/sm2Utils';

/**
 * Guarantee Request Dialog
 * Collects the credit-proof verification code, signs the request with SM2 and hands both back to the caller
 * (backend /guarantee/request requires creditProof + verificationCode + borrowerSignature together)
 */
const GuaranteeRequestDialog = ({
  open,
  onClose,
  guarantor,
  loanAmount,
  feeInfo,
  aesKey,
  borrowerId,
  onConfirm,
}) => {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [code, setCode] = useState('');

  if (!process.env.REACT_APP_RISK_ENHANCEMENT_ENABLED) {
    return null;
  }

  const handleClose = () => {
    setCode('');
    setError('');
    onClose();
  };

  const handleConfirm = async () => {
    if (!aesKey) {
      setError('AES密钥不存在，请重新登录');
      return;
    }
    if (!code.trim()) {
      setError('请输入信用证明页生成的验证口令');
      return;
    }

    setLoading(true);
    setError('');

    try {
      // Get SM2 key pair
      let keyPair = await getSM2KeyPairWithAesKey(aesKey);
      if (!keyPair?.privateKey) {
        throw new Error('无法获取SM2密钥对');
      }

      // Sign the guarantee request data (must match backend buildSignatureData format)
      const signatureData = JSON.stringify({
        borrowerId: String(borrowerId),
        guarantorId: String(guarantor.id),
        loanAmount: String(Number(loanAmount)),
      });

      const signature = signWithSM2(signatureData, keyPair.privateKey);
      keyPair.privateKey = null; // Burn after use

      await onConfirm(signature, code.trim());
      setCode('');
    } catch (err) {
      setError(err.message || '签名失败');
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onClose={handleClose} maxWidth="sm" fullWidth>
      <DialogTitle>确认担保邀请</DialogTitle>
      <DialogContent>
        {error && (
          <Alert severity="error" sx={{ mb: 2 }}>
            {error}
          </Alert>
        )}

        <Box sx={{ mb: 2 }}>
          <Typography variant="body1" gutterBottom>
            您确定要邀请 <strong>{guarantor?.username || guarantor?.name || '该用户'}</strong> 为您担保吗？
          </Typography>

          <Typography variant="body2" color="text.secondary" gutterBottom>
            借款金额: ¥{Number(loanAmount || 0).toFixed(2)}
          </Typography>

          {feeInfo && (
            <>
              <Typography variant="body2" color="text.secondary" gutterBottom>
                担保费率: {Number(feeInfo.feeRate || 0).toFixed(2)}%
              </Typography>
              <Typography variant="body2" color="text.secondary" gutterBottom>
                担保费用: ¥{Number(feeInfo.feeAmount || 0).toFixed(2)}
              </Typography>
            </>
          )}

          <TextField
            fullWidth
            size="small"
            label="信用证明验证口令"
            placeholder="在「信用证明」页生成，24小时内有效"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            sx={{ mt: 2 }}
            autoComplete="off"
          />

          <Alert severity="info" sx={{ mt: 2 }}>
            发送邀请需校验您的信用证明口令，并使用SM2密钥签名确认；担保人将收到通知并决定是否接受。
          </Alert>
        </Box>
      </DialogContent>
      <DialogActions>
        <Button onClick={handleClose} disabled={loading}>
          取消
        </Button>
        <Button
          onClick={handleConfirm}
          variant="contained"
          color="primary"
          disabled={loading || !code.trim()}
        >
          {loading ? <CircularProgress size={24} /> : '签名并发送邀请'}
        </Button>
      </DialogActions>
    </Dialog>
  );
};

export default GuaranteeRequestDialog;
