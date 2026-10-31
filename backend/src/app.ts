import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import compression from 'compression';
import { env } from './config/env.js';
import { authenticateToken, requireRoles } from './middleware/auth.js';
import { errorHandler } from './middleware/errorHandler.js';
import { apiLimiter, exportLimiter, loginLimiter, otpRequestLimiter, otpVerifyLimiter, refreshLimiter } from './middleware/rateLimit.js';

import * as authController from './modules/auth/auth.controller.js';
import * as subscriberController from './modules/subscribers/subscriber.controller.js';
import * as chitGroupController from './modules/chit-groups/chitGroup.controller.js';
import * as collectionController from './modules/collections/collection.controller.js';
import * as auctionController from './modules/auctions/auction.controller.js';
import * as payoutController from './modules/payouts/payout.controller.js';
import * as reconciliationController from './modules/reconciliation/reconciliation.controller.js';
import * as reportController from './modules/reports/report.controller.js';
import * as superAdminController from './modules/super-admin/superAdmin.controller.js';
import * as accountingController from './modules/accounting/accounting.controller.js';
import * as notificationController from './modules/notifications/notification.controller.js';
import * as khataController from './modules/khata/khata.controller.js';
import * as policyController from './modules/financial-policies/policy.controller.js';
import { registerEngineRoutes } from './engine/routes.js';

const app = express();

// Correct client IPs (rate limiting, audit logs) behind Vercel / Render proxies.
app.set('trust proxy', env.trustProxy);
app.disable('x-powered-by');

app.use(helmet({ contentSecurityPolicy: false, crossOriginResourcePolicy: { policy: 'cross-origin' } }));
app.use(compression());

// CORS: only origins listed in CORS_ORIGINS may call the API from a browser.
// Requests without an Origin header (native mobile app, curl, server-to-server) are allowed;
// they are still subject to Bearer token authentication.
app.use(cors({
  origin: (origin, callback) => {
    if (!origin || env.corsOrigins.includes('*') || env.corsOrigins.includes(origin)) return callback(null, true);
    return callback(new Error('Not allowed by CORS'));
  },
  credentials: true,
}));
app.use(cookieParser());
// Receipt / bill photos are sent inline as base64 data URLs (validated per-field against MAX_UPLOAD_BYTES).
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));
// In-memory buffer of recent API requests for Super Admin observability
export interface ApiLogEntry {
  id: string;
  timestamp: string;
  method: string;
  path: string;
  status: number;
  durationMs: number;
  ip: string;
  userAgent?: string;
}

const MAX_API_LOGS = 250;
export const apiLogsBuffer: ApiLogEntry[] = [];

// API Traffic & Request Interceptor for Super Admin System Observability
app.use((req, res, next) => {
  const start = Date.now();
  const originalEnd = res.end;

  res.end = function (...args: any[]) {
    const durationMs = Date.now() - start;
    const url = req.originalUrl || req.url;

    // Filter out internal polling/health checks to prevent clutter
    if (!url.includes('/super-admin/api-logs') && !url.includes('/health')) {
      const entry: ApiLogEntry = {
        id: `req_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
        timestamp: new Date().toISOString(),
        method: req.method,
        path: url,
        status: res.statusCode,
        durationMs,
        ip: (req.headers['x-forwarded-for'] as string) || req.ip || req.socket.remoteAddress || 'unknown',
        userAgent: req.headers['user-agent'] ? String(req.headers['user-agent']).slice(0, 100) : undefined,
      };
      apiLogsBuffer.unshift(entry);
      if (apiLogsBuffer.length > MAX_API_LOGS) {
        apiLogsBuffer.pop();
      }
    }
    return (originalEnd as any).apply(res, args);
  };
  next();
});

// Core Router for ChitKart API
const router = express.Router();
router.use(apiLimiter);

// Healthcheck
router.get('/health', (req, res) => {
  res.json({ status: 'OK', service: 'ChitKart Management Platform API', timestamp: new Date() });
});

// Authentication Routes (JWT + Cookies + Sessions + OTP)
router.post('/auth/login', loginLimiter, authController.login);
router.post('/auth/logout', authenticateToken, authController.logout);
router.post('/auth/refresh-token', refreshLimiter, authController.refreshToken);
router.post('/auth/change-password', authenticateToken, authController.changePassword);
router.post('/auth/forgot-password', otpRequestLimiter, authController.forgotPassword);
router.post('/auth/verify-otp', otpVerifyLimiter, authController.verifyOtp);
router.post('/auth/reset-password', otpVerifyLimiter, authController.resetPassword);
router.get('/auth/me', authenticateToken, authController.me);
router.put('/auth/profile', authenticateToken, authController.updateProfile);

// User Account Administration (FR-AUTH-007, FR-AUTH-013, FR-AUTH-014, SA-04)
router.get('/auth/users', authenticateToken, requireRoles('SUPER_ADMIN', 'MANAGER', 'COLLECTION_STAFF'), authController.listUsers);
router.post('/auth/users', authenticateToken, requireRoles('SUPER_ADMIN', 'MANAGER'), authController.createUser);
router.put('/auth/users/:id', authenticateToken, requireRoles('SUPER_ADMIN', 'MANAGER'), authController.updateUser);
router.patch('/auth/users/:id/status', authenticateToken, requireRoles('SUPER_ADMIN', 'MANAGER'), authController.updateUserStatus);
router.delete('/auth/users/:id', authenticateToken, requireRoles('SUPER_ADMIN'), authController.deleteUser);
router.post('/auth/users/:id/revoke-sessions', authenticateToken, requireRoles('SUPER_ADMIN', 'MANAGER'), authController.revokeUserSessions);

// Super Admin User Credential Management Aliases (SA-04)
router.get('/super-admin/users', authenticateToken, requireRoles('SUPER_ADMIN'), authController.listUsers);
router.post('/super-admin/users', authenticateToken, requireRoles('SUPER_ADMIN'), authController.createUser);
router.put('/super-admin/users/:id', authenticateToken, requireRoles('SUPER_ADMIN'), authController.updateUser);
router.delete('/super-admin/users/:id', authenticateToken, requireRoles('SUPER_ADMIN'), authController.deleteUser);

// Dashboard Statistics Route
router.get('/reports/dashboard', authenticateToken, reportController.getDashboardStats);

// Subscriber Routes (AC-01, AC-02, AC-04, AC-29, AC-30)
router.get('/subscribers', authenticateToken, subscriberController.listSubscribers);
router.post('/subscribers', authenticateToken, requireRoles('SUPER_ADMIN', 'MANAGER', 'COLLECTION_STAFF'), subscriberController.createSubscriber);
router.put('/subscribers/:id', authenticateToken, requireRoles('SUPER_ADMIN', 'MANAGER', 'COLLECTION_STAFF'), subscriberController.updateSubscriber);
router.delete('/subscribers/:id', authenticateToken, requireRoles('SUPER_ADMIN', 'MANAGER'), subscriberController.deleteSubscriber);
router.get('/subscribers/outstanding', authenticateToken, requireRoles('SUPER_ADMIN', 'MANAGER'), subscriberController.getMemberOutstanding);
router.get('/subscribers/:id', authenticateToken, subscriberController.getSubscriberById);
router.patch('/subscribers/:id/kyc', authenticateToken, requireRoles('SUPER_ADMIN', 'MANAGER'), subscriberController.verifyKyc);
router.get('/subscribers/:id/ledger', authenticateToken, subscriberController.getMemberLedger);
router.get('/subscribers/:id/statement', authenticateToken, subscriberController.getMemberStatement);

// Chit Group Routes (AC-03, AC-05, AC-06, AC-07)
router.get('/chit-groups', authenticateToken, chitGroupController.listChitGroups);
router.post('/chit-groups', authenticateToken, requireRoles('SUPER_ADMIN', 'MANAGER'), chitGroupController.createChitGroup);
router.post('/chit-groups/enroll', authenticateToken, requireRoles('SUPER_ADMIN', 'MANAGER', 'COLLECTION_STAFF'), chitGroupController.enrollSubscriber);
router.get('/chit-groups/:id', authenticateToken, chitGroupController.getChitGroupDetails);
router.put('/chit-groups/:id', authenticateToken, requireRoles('SUPER_ADMIN', 'MANAGER'), chitGroupController.updateChitGroup);
router.post('/chit-groups/:id/assign-staff', authenticateToken, requireRoles('SUPER_ADMIN', 'MANAGER'), chitGroupController.assignStaffToGroup);
router.delete('/chit-groups/:id', authenticateToken, requireRoles('SUPER_ADMIN', 'MANAGER'), chitGroupController.deleteChitGroup);

// Collection & Payment Routes (AC-08, AC-09, AC-10, AC-11, AC-12, AC-13)
router.post('/collections/pay', authenticateToken, collectionController.recordPayment);
router.get('/collections/transactions', authenticateToken, collectionController.listTransactions);
router.get('/collections/receipts/:receiptNo', authenticateToken, collectionController.getReceiptDetails);
router.post('/collections/receipts/:receiptNo/reprint', authenticateToken, collectionController.reprintReceipt);
router.post('/collections/reconcile', authenticateToken, requireRoles('SUPER_ADMIN', 'MANAGER'), collectionController.reconcilePayments);
router.post('/collections/:id/reverse', authenticateToken, requireRoles('SUPER_ADMIN', 'MANAGER'), collectionController.reverseTransaction);
router.post('/collections/:id/approve', authenticateToken, requireRoles('SUPER_ADMIN', 'MANAGER'), collectionController.approveTransaction);
router.patch('/collections/:id/approve', authenticateToken, requireRoles('SUPER_ADMIN', 'MANAGER'), collectionController.approveTransaction);
router.post('/collections/:id/reject', authenticateToken, requireRoles('SUPER_ADMIN', 'MANAGER'), collectionController.rejectTransaction);
router.patch('/collections/:id/reject', authenticateToken, requireRoles('SUPER_ADMIN', 'MANAGER'), collectionController.rejectTransaction);
router.patch('/collections/:id/photo', authenticateToken, collectionController.updateReceiptPhoto);

// Auction Routes (AC-23, AC-24, AC-25)
router.post('/auctions/confirm', authenticateToken, requireRoles('SUPER_ADMIN', 'MANAGER'), auctionController.createAuctionResult);
router.post('/auctions/preview', authenticateToken, requireRoles('SUPER_ADMIN', 'MANAGER'), auctionController.previewAuctionResult);
router.get('/auctions/dividend-allocations/pending', authenticateToken, requireRoles('SUPER_ADMIN', 'MANAGER'), auctionController.listPendingDividendAllocations);
router.get('/auctions/group/:groupId/eligibility', authenticateToken, auctionController.getGroupEligibility);
router.get('/auctions/group/:groupId', authenticateToken, auctionController.getGroupAuctions);

// Configuration system (P2): policy versions, effective settings, snapshots
router.get('/financial-policies/templates', authenticateToken, requireRoles('SUPER_ADMIN', 'MANAGER'), policyController.listTemplates);
router.get('/financial-policies/effective', authenticateToken, requireRoles('SUPER_ADMIN', 'MANAGER', 'COLLECTION_STAFF'), policyController.getEffective);
router.get('/financial-policies/snapshots', authenticateToken, requireRoles('SUPER_ADMIN', 'MANAGER'), policyController.listSnapshots);
router.get('/financial-policies', authenticateToken, requireRoles('SUPER_ADMIN', 'MANAGER'), policyController.listVersions);
router.get('/financial-policies/:id', authenticateToken, requireRoles('SUPER_ADMIN', 'MANAGER'), policyController.getVersion);
router.post('/financial-policies', authenticateToken, requireRoles('SUPER_ADMIN', 'MANAGER'), policyController.createVersion);
router.post('/financial-policies/:id/validate', authenticateToken, requireRoles('SUPER_ADMIN', 'MANAGER'), policyController.validateVersion);
router.post('/financial-policies/:id/activate', authenticateToken, requireRoles('SUPER_ADMIN', 'MANAGER'), policyController.activateVersion);
router.post('/financial-policies/:id/reject', authenticateToken, requireRoles('SUPER_ADMIN', 'MANAGER'), policyController.rejectVersion);

// Auction & financial engine (P3–P10)
registerEngineRoutes(router);

// Payout & Refund Routes (AC-26, AC-27, AC-28)
router.get('/payouts', authenticateToken, requireRoles('SUPER_ADMIN', 'MANAGER'), payoutController.listPayouts);
router.patch('/payouts/:id/status', authenticateToken, requireRoles('SUPER_ADMIN', 'MANAGER'), payoutController.updatePayoutStatus);
router.get('/refunds', authenticateToken, requireRoles('SUPER_ADMIN', 'MANAGER', 'COLLECTION_STAFF'), payoutController.listRefunds);
router.post('/refunds', authenticateToken, requireRoles('SUPER_ADMIN', 'MANAGER', 'COLLECTION_STAFF'), payoutController.createRefundRequest);
router.patch('/refunds/:id/process', authenticateToken, requireRoles('SUPER_ADMIN', 'MANAGER', 'COLLECTION_STAFF'), payoutController.processRefund);

// Accounting & Finance Routes (AC-14, AC-15, AC-16, AC-17, AC-18, AC-19, AC-20, AC-21, AC-22, AC-31)
router.get('/accounting/accounts', authenticateToken, requireRoles('SUPER_ADMIN', 'MANAGER'), accountingController.listAccounts);
router.post('/accounting/accounts', authenticateToken, requireRoles('SUPER_ADMIN', 'MANAGER'), accountingController.createAccount);
router.get('/accounting/cashbook', authenticateToken, requireRoles('SUPER_ADMIN', 'MANAGER'), accountingController.getCashbook);
router.get('/accounting/bankbook', authenticateToken, requireRoles('SUPER_ADMIN', 'MANAGER'), accountingController.getBankbook);
router.get('/accounting/journal-entries', authenticateToken, requireRoles('SUPER_ADMIN', 'MANAGER'), accountingController.listJournalEntries);
router.post('/accounting/journal-entries', authenticateToken, requireRoles('SUPER_ADMIN', 'MANAGER'), accountingController.createJournalEntry);
router.get('/accounting/expenses', authenticateToken, requireRoles('SUPER_ADMIN', 'MANAGER'), accountingController.listExpenses);
router.post('/accounting/expenses', authenticateToken, requireRoles('SUPER_ADMIN', 'MANAGER'), accountingController.createExpense);
router.get('/accounting/general-ledger/:accountId', authenticateToken, requireRoles('SUPER_ADMIN', 'MANAGER'), accountingController.getGeneralLedger);
router.get('/accounting/trial-balance', authenticateToken, requireRoles('SUPER_ADMIN', 'MANAGER'), accountingController.getTrialBalance);
router.get('/accounting/financial-statements', authenticateToken, requireRoles('SUPER_ADMIN', 'MANAGER'), accountingController.getFinancialStatements);
router.post('/accounting/close-period', authenticateToken, requireRoles('SUPER_ADMIN', 'MANAGER'), accountingController.closeFinancialPeriod);
router.get('/accounting/reports', authenticateToken, requireRoles('SUPER_ADMIN', 'MANAGER'), accountingController.getComprehensiveReports);

// Reconciliation & Handover Routes
router.post('/reconciliation/handover', authenticateToken, reconciliationController.submitCashHandover);
router.get('/reconciliation/handovers', authenticateToken, reconciliationController.listHandovers);
router.patch('/reconciliation/handovers/:id/verify', authenticateToken, requireRoles('SUPER_ADMIN', 'MANAGER'), reconciliationController.verifyHandover);

// Super Admin Module Routes (FR-SA-001 through FR-SA-018)
router.get('/super-admin/dashboard', authenticateToken, requireRoles('SUPER_ADMIN'), superAdminController.getPlatformDashboard);
router.get('/super-admin/companies', authenticateToken, requireRoles('SUPER_ADMIN'), superAdminController.listCompanies);
router.post('/super-admin/companies', authenticateToken, requireRoles('SUPER_ADMIN'), superAdminController.createCompany);
router.get('/super-admin/companies/:id', authenticateToken, requireRoles('SUPER_ADMIN'), superAdminController.getCompanyDetails);
router.put('/super-admin/companies/:id', authenticateToken, requireRoles('SUPER_ADMIN'), superAdminController.updateCompany);
router.patch('/super-admin/companies/:id', authenticateToken, requireRoles('SUPER_ADMIN'), superAdminController.updateCompany);
router.patch('/super-admin/companies/:id/status', authenticateToken, requireRoles('SUPER_ADMIN'), superAdminController.updateCompanyStatus);
router.delete('/super-admin/companies/:id', authenticateToken, requireRoles('SUPER_ADMIN'), superAdminController.deleteCompany);
router.put('/super-admin/companies/:id/settings', authenticateToken, requireRoles('SUPER_ADMIN'), superAdminController.updateCompanySettings);
router.get('/super-admin/subscriptions', authenticateToken, requireRoles('SUPER_ADMIN'), superAdminController.listSubscriptionPlans);
router.get('/super-admin/audit-logs', authenticateToken, requireRoles('SUPER_ADMIN'), superAdminController.getAuditLogs);
router.get('/super-admin/api-logs', authenticateToken, requireRoles('SUPER_ADMIN'), (req, res) => {
  res.json({ success: true, count: apiLogsBuffer.length, data: apiLogsBuffer });
});
router.delete('/super-admin/api-logs', authenticateToken, requireRoles('SUPER_ADMIN'), (req, res) => {
  apiLogsBuffer.length = 0;
  res.json({ success: true, message: 'API request logs buffer cleared successfully' });
});
router.get('/super-admin/system-health', authenticateToken, requireRoles('SUPER_ADMIN'), superAdminController.getSystemHealth);
router.get('/super-admin/platform-settings', authenticateToken, requireRoles('SUPER_ADMIN'), superAdminController.getPlatformSettings);
router.post('/super-admin/support-access', authenticateToken, requireRoles('SUPER_ADMIN'), superAdminController.requestSupportAccess);

// Super Admin Credentials Management (SA-04, SA-05)
router.get('/super-admin/admins', authenticateToken, requireRoles('SUPER_ADMIN'), superAdminController.listSuperAdmins);
router.post('/super-admin/admins', authenticateToken, requireRoles('SUPER_ADMIN'), superAdminController.createSuperAdmin);


// SA-05, SA-06: Role & Permission Management
router.get('/super-admin/roles', authenticateToken, requireRoles('SUPER_ADMIN'), superAdminController.listRolesAndPermissions);
router.put('/super-admin/roles/:role/permissions', authenticateToken, requireRoles('SUPER_ADMIN'), superAdminController.updateRolePermissions);

// SA-12: Compliance Settings
router.get('/super-admin/compliance', authenticateToken, requireRoles('SUPER_ADMIN'), superAdminController.getComplianceRecords);
router.post('/super-admin/compliance', authenticateToken, requireRoles('SUPER_ADMIN'), superAdminController.createComplianceRecord);
router.get('/super-admin/compliance/reports', authenticateToken, requireRoles('SUPER_ADMIN'), superAdminController.getSuperAdminComplianceReports);

// SA-13: Integration Configuration
router.get('/super-admin/integrations', authenticateToken, requireRoles('SUPER_ADMIN'), superAdminController.getIntegrations);
router.put('/super-admin/integrations', authenticateToken, requireRoles('SUPER_ADMIN'), superAdminController.updateIntegrations);

// SA-15: Backup Management
router.get('/super-admin/backups', authenticateToken, requireRoles('SUPER_ADMIN'), superAdminController.getBackups);
router.post('/super-admin/backups/trigger', authenticateToken, requireRoles('SUPER_ADMIN'), superAdminController.triggerManualBackup);

// SA-17: Database Data Export & Dynamic Table Discovery
router.get('/super-admin/export/tables', authenticateToken, requireRoles('SUPER_ADMIN'), superAdminController.getDatabaseTables);
router.get('/super-admin/export', exportLimiter, authenticateToken, requireRoles('SUPER_ADMIN'), superAdminController.exportData);
router.get('/super-admin/export/:entity', exportLimiter, authenticateToken, requireRoles('SUPER_ADMIN'), superAdminController.exportData);

// SA-19, SA-20: Financial Periods & Archival Policy
router.get('/super-admin/financial-periods', authenticateToken, requireRoles('SUPER_ADMIN'), superAdminController.getFinancialPeriods);
router.post('/super-admin/financial-periods/close', authenticateToken, requireRoles('SUPER_ADMIN'), superAdminController.closeFinancialPeriod);
router.post('/super-admin/financial-periods/reopen', authenticateToken, requireRoles('SUPER_ADMIN'), superAdminController.reopenFinancialPeriod);
router.get('/super-admin/archival-policy', authenticateToken, requireRoles('SUPER_ADMIN'), superAdminController.getArchivalPolicy);

// SA-21, SA-22: System Oversight & Exception Management
router.get('/super-admin/exceptions', authenticateToken, requireRoles('SUPER_ADMIN'), superAdminController.getMultiBranchExceptions);

// Universal In-App Notification System (Super Admin, Manager, Staff)
router.get('/notifications/recipients', authenticateToken, notificationController.getRecipients);
router.get('/notifications', authenticateToken, notificationController.listNotifications);
router.post('/notifications/send', authenticateToken, requireRoles('SUPER_ADMIN', 'MANAGER'), notificationController.sendNotification);
router.delete('/notifications/:id', authenticateToken, requireRoles('SUPER_ADMIN', 'MANAGER'), notificationController.deleteNotification);

// Multi-Business & Khatabook Ledger Routes
router.get('/khata/businesses', authenticateToken, khataController.listBusinesses);
router.post('/khata/businesses', authenticateToken, requireRoles('SUPER_ADMIN', 'MANAGER'), khataController.createBusiness);
router.put('/khata/businesses/:id', authenticateToken, requireRoles('SUPER_ADMIN', 'MANAGER'), khataController.updateBusiness);
router.delete('/khata/businesses/:id', authenticateToken, requireRoles('SUPER_ADMIN', 'MANAGER'), khataController.deleteBusiness);
router.get('/khata/businesses/:id/staff', authenticateToken, requireRoles('SUPER_ADMIN', 'MANAGER'), khataController.getBusinessStaff);
router.post('/khata/businesses/:id/assign-staff', authenticateToken, requireRoles('SUPER_ADMIN', 'MANAGER'), khataController.assignStaffToBusiness);

router.get('/khata/businesses/:businessId/customers', authenticateToken, khataController.listCustomers);
router.post('/khata/businesses/:businessId/customers', authenticateToken, khataController.createCustomer);
router.get('/khata/businesses/:businessId/cashflow', authenticateToken, khataController.getBusinessCashflowAndStaffMonitoring);
router.get('/khata/customers/:customerId', authenticateToken, khataController.getCustomerDetails);
router.put('/khata/customers/:customerId', authenticateToken, khataController.updateCustomer);
router.delete('/khata/customers/:customerId', authenticateToken, requireRoles('SUPER_ADMIN', 'MANAGER'), khataController.deleteCustomer);

router.post('/khata/customers/:customerId/transactions', authenticateToken, khataController.addTransaction);
router.delete('/khata/transactions/:txId', authenticateToken, khataController.deleteTransaction);

// Legacy/Compatibility endpoints for Super Admin
router.get('/super-admin/notifications/recipients', authenticateToken, requireRoles('SUPER_ADMIN'), notificationController.getRecipients);
router.get('/super-admin/notifications', authenticateToken, requireRoles('SUPER_ADMIN'), notificationController.listNotifications);
router.post('/super-admin/notifications/send', authenticateToken, requireRoles('SUPER_ADMIN'), notificationController.sendNotification);
router.delete('/super-admin/notifications/:id', authenticateToken, requireRoles('SUPER_ADMIN'), notificationController.deleteNotification);

// Financial Record Immutability Enforcement (FR-SA-018)
router.delete('/collections/transactions/:id', authenticateToken, superAdminController.rejectFinancialRecordMutation);
router.put('/collections/transactions/:id', authenticateToken, superAdminController.rejectFinancialRecordMutation);
router.patch('/collections/transactions/:id', authenticateToken, superAdminController.rejectFinancialRecordMutation);

// Mount router on multiple common paths for seamless local and Vercel serverless routing
app.use('/api/v1', router);
app.use('/v1', router);
app.use('/api', router);
app.use('/', router);

// Unknown API routes
app.use((req, res) => {
  res.status(404).json({ success: false, message: 'Route not found' });
});

// Global Error Handler
app.use(errorHandler);

export default app;
