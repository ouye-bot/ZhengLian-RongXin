import React from 'react';
import { IconButton, Badge, Tooltip } from '@mui/material';
import NotificationsIcon from '@mui/icons-material/Notifications';

/**
 * Notification Badge Component
 * Shows unread notification count with icon button
 */
const NotificationBadge = ({
  unreadCount,
  onClick,
  onLoadNotifications,
}) => {
  if (!process.env.REACT_APP_RISK_ENHANCEMENT_ENABLED) {
    return null;
  }

  return (
    <Tooltip title={`通知 (${unreadCount || 0} 条未读)`}>
      <IconButton
        color="inherit"
        onClick={() => {
          if (onLoadNotifications) {
            onLoadNotifications();
          }
          if (onClick) {
            onClick();
          }
        }}
      >
        <Badge badgeContent={unreadCount || 0} color="error">
          <NotificationsIcon />
        </Badge>
      </IconButton>
    </Tooltip>
  );
};

export default NotificationBadge;
