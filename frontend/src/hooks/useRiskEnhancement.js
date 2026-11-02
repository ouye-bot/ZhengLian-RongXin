import { useState, useEffect, useCallback } from 'react';
import { get, post } from '../utils/apiUtils';

/**
 * Hook for managing risk enhancement feature state and API calls
 */
const useRiskEnhancement = () => {
  const [riskMode, setRiskMode] = useState(0);
  const [marginRate, setMarginRate] = useState(0);
  const [marginAmount, setMarginAmount] = useState(0);
  const [eligibleGuarantors, setEligibleGuarantors] = useState([]);
  const [pendingRequests, setPendingRequests] = useState([]);
  const [acceptedRequests, setAcceptedRequests] = useState([]);
  const [notifications, setNotifications] = useState([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const [isEnabled, setIsEnabled] = useState(false);

  // Check if feature is enabled
  useEffect(() => {
    const checkEnabled = async () => {
      try {
        const response = await get('/api/v1/notifications/unread-count');
        if (response.ok) {
          const data = await response.json();
          if (data.success) {
            setIsEnabled(true);
            setUnreadCount(data.unreadCount || 0);
          }
        }
      } catch (err) {
        // Feature not available
        console.log('Risk enhancement feature not available');
      }
    };

    checkEnabled();
  }, []);

  /**
   * Load eligible guarantors for a given loan amount
   */
  const loadEligibleGuarantors = useCallback(async (loanAmount) => {
    try {
      setLoading(true);
      const response = await get(`/api/v1/guarantee/eligible-guarantors?loanAmount=${loanAmount}`);
      const data = await response.json();
      if (data.success) {
        setEligibleGuarantors(data.guarantors || []);
      }
    } catch (err) {
      console.error('Failed to load eligible guarantors:', err);
      setEligibleGuarantors([]);
    } finally {
      setLoading(false);
    }
  }, []);

  /**
   * Load pending guarantee requests for the current user
   */
  const loadPendingRequests = useCallback(async () => {
    try {
      setLoading(true);
      const response = await get('/api/v1/guarantee/pending-requests');
      const data = await response.json();
      if (data.success) {
        setPendingRequests(data.requests || []);
      }
    } catch (err) {
      console.error('Failed to load pending requests:', err);
      setPendingRequests([]);
    } finally {
      setLoading(false);
    }
  }, []);

  /**
   * Load accepted guarantee requests for the current borrower
   */
  const loadAcceptedRequests = useCallback(async () => {
    try {
      const response = await get('/api/v1/guarantee/accepted-requests');
      const data = await response.json();
      if (data.success) {
        setAcceptedRequests(data.requests || []);
      }
    } catch (err) {
      console.error('Failed to load accepted requests:', err);
      setAcceptedRequests([]);
    }
  }, []);

  /**
   * Load notifications and unread count
   */
  const loadNotifications = useCallback(async () => {
    try {
      setLoading(true);
      const [notifResponse, countResponse] = await Promise.all([
        get('/api/v1/notifications'),
        get('/api/v1/notifications/unread-count'),
      ]);

      const notifData = await notifResponse.json();
      if (notifData.success) {
        setNotifications(notifData.notifications || []);
      }

      const countData = await countResponse.json();
      if (countData.success) {
        setUnreadCount(countData.unreadCount || 0);
      }
    } catch (err) {
      console.error('Failed to load notifications:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  /**
   * Calculate margin amount via backend
   */
  const calculateMargin = useCallback(async (loanAmount, creditScore, term) => {
    try {
      const response = await post('/api/v1/margin/calculate', {
        loanAmount,
        creditScore,
        term,
      });
      const data = await response.json();
      if (data.success) {
        setMarginRate(data.marginRate);
        setMarginAmount(data.marginAmount);
        return data;
      }
    } catch (err) {
      console.error('Failed to calculate margin:', err);
    }
    return null;
  }, []);

  /**
   * Create a guarantee request
   */
  const createGuaranteeRequest = useCallback(async (guarantorId, loanAmount, borrowerSignature, creditProof, verificationCode) => {
    try {
      setLoading(true);
      const response = await post('/api/v1/guarantee/request', {
        guarantorId,
        loanAmount,
        borrowerSignature,
        creditProof,
        verificationCode,
      });
      const data = await response.json();
      return data;
    } catch (err) {
      console.error('Failed to create guarantee request:', err);
      return { success: false, message: err.message };
    } finally {
      setLoading(false);
    }
  }, []);

  /**
   * Accept a guarantee request (as guarantor)
   */
  const acceptGuaranteeRequest = useCallback(async (requestId, guarantorSignature) => {
    try {
      setLoading(true);
      const response = await post(`/api/v1/guarantee/accept/${requestId}`, {
        guarantorSignature,
      });
      const data = await response.json();
      return data;
    } catch (err) {
      console.error('Failed to accept guarantee request:', err);
      return { success: false, message: err.message };
    } finally {
      setLoading(false);
    }
  }, []);

  /**
   * Reject a guarantee request (as guarantor)
   */
  const rejectGuaranteeRequest = useCallback(async (requestId) => {
    try {
      setLoading(true);
      const response = await post(`/api/v1/guarantee/reject/${requestId}`, {});
      const data = await response.json();
      return data;
    } catch (err) {
      console.error('Failed to reject guarantee request:', err);
      return { success: false, message: err.message };
    } finally {
      setLoading(false);
    }
  }, []);

  /**
   * Mark a notification as read
   */
  const markNotificationRead = useCallback(async (notificationId) => {
    try {
      const response = await post(`/api/v1/notifications/${notificationId}/read`, {});
      const data = await response.json();
      if (data.success) {
        setUnreadCount((prev) => Math.max(0, prev - 1));
        setNotifications((prev) =>
          prev.map((n) => (n.id === notificationId ? { ...n, read: true } : n))
        );
      }
      return data;
    } catch (err) {
      console.error('Failed to mark notification read:', err);
      return { success: false, message: err.message };
    }
  }, []);

  return {
    riskMode,
    setRiskMode,
    marginRate,
    setMarginRate,
    marginAmount,
    setMarginAmount,
    eligibleGuarantors,
    setEligibleGuarantors,
    pendingRequests,
    acceptedRequests,
    notifications,
    unreadCount,
    loading,
    isEnabled,
    loadEligibleGuarantors,
    loadPendingRequests,
    loadAcceptedRequests,
    loadNotifications,
    calculateMargin,
    createGuaranteeRequest,
    acceptGuaranteeRequest,
    rejectGuaranteeRequest,
    markNotificationRead,
  };
};

export default useRiskEnhancement;
