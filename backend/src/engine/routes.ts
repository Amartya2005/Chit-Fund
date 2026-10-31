import { Router } from 'express';
import { authenticateToken, requireRoles } from '../middleware/auth.js';
import * as dues from './dues/dues.controller.js';
import * as acct from './accounting/accounting.controller.js';
import * as ses from './sessions/sessions.controller.js';

const SA = 'SUPER_ADMIN';
const M = 'MANAGER';
const S = 'COLLECTION_STAFF';

/** Engine routes (P3+). Mounted on the main API router. */
export function registerEngineRoutes(router: Router) {
  const auth = (...roles: string[]) => [authenticateToken, requireRoles(...roles)];

  // P3 — engine enablement, conversion, dues, penalties, waivers
  router.patch('/engine/companies/:id/settings', ...auth(SA), dues.updateCompanyEngineSettings);
  router.get('/engine/groups/:id/status', ...auth(SA, M, S), dues.getGroupEngineStatus);
  router.post('/engine/groups/:id/convert', ...auth(SA, M), dues.convertGroup);
  router.get('/engine/groups/:id/dues', ...auth(SA, M, S), dues.getGroupDues);
  router.post('/engine/groups/:id/penalties/run', ...auth(SA, M), dues.runGroupPenalties);
  router.get('/engine/payments/:id/allocations', ...auth(SA, M, S), dues.getPaymentAllocations);
  router.post('/engine/adjustments', ...auth(SA, M), dues.createAdjustment);
  router.get('/engine/adjustments', ...auth(SA, M), dues.listAdjustments);
  router.post('/engine/adjustments/:id/approve', ...auth(SA, M), dues.decideAdjustmentHandler('APPROVE'));
  router.post('/engine/adjustments/:id/reject', ...auth(SA, M), dues.decideAdjustmentHandler('REJECT'));

  // P4 — accounting integration
  router.get('/engine/accounting/settings', ...auth(SA, M), acct.getSettings);
  router.put('/engine/accounting/cutover', ...auth(SA, M), acct.setCutover);
  router.put('/engine/accounting/mappings', ...auth(SA, M), acct.setMappings);
  router.post('/engine/accounting/run', ...auth(SA, M), acct.runAccounting);
  router.get('/engine/accounting/events', ...auth(SA, M), acct.listEvents);
  router.get('/engine/accounting/trial-balance', ...auth(SA, M), acct.getLedgerTrialBalance);
  router.get('/engine/accounting/periods', ...auth(SA, M), acct.listPeriods);
  router.post('/engine/accounting/periods', ...auth(SA, M), acct.createPeriod);
  router.post('/engine/accounting/periods/:id/close', ...auth(SA, M), acct.closePeriod);

  // P5 — schedules, sessions, results, settlements; P6 — eligibility
  router.post('/engine/groups/:id/schedules', ...auth(SA, M), ses.createGroupSchedule);
  router.get('/engine/groups/:id/schedules', ...auth(SA, M, S), ses.listGroupSchedules);
  router.post('/engine/schedules/:id/end', ...auth(SA, M), ses.endSchedule);
  router.get('/engine/holidays', ...auth(SA, M), ses.listHolidays);
  router.post('/engine/holidays', ...auth(SA, M), ses.addHoliday);
  router.post('/engine/groups/:id/sessions', ...auth(SA, M), ses.createSession);
  router.get('/engine/sessions', ...auth(SA, M, S), ses.listSessions);
  router.get('/engine/sessions/:id', ...auth(SA, M, S), ses.getSession);
  router.post('/engine/sessions/:id/open', ...auth(SA, M), ses.sessionAction('open'));
  router.post('/engine/sessions/:id/close', ...auth(SA, M), ses.sessionAction('close'));
  router.post('/engine/sessions/:id/postpone', ...auth(SA, M), ses.sessionAction('postpone'));
  router.post('/engine/sessions/:id/cancel', ...auth(SA, M), ses.sessionAction('cancel'));
  router.post('/engine/sessions/:id/no-bid', ...auth(SA, M), ses.sessionAction('no-bid'));
  router.post('/engine/sessions/:id/preview', ...auth(SA, M), ses.previewResult);
  router.post('/engine/sessions/:id/result', ...auth(SA, M), ses.enterResult);
  router.post('/engine/sessions/:id/eligibility', ...auth(SA, M), ses.evaluateSessionEligibility);
  router.post('/engine/sessions/:id/eligibility/override', ...auth(SA, M), ses.overrideSessionEligibility);
  router.get('/engine/settlements/:id', ...auth(SA, M), ses.getSettlement);
  router.post('/engine/settlements/:id/approve', ...auth(SA, M), ses.decideSettlement('APPROVE'));
  router.post('/engine/settlements/:id/reject', ...auth(SA, M), ses.decideSettlement('REJECT'));
  router.post('/engine/settlements/:id/reverse', ...auth(SA, M), ses.reverseSettlementHandler);
  router.post('/engine/scheduler/run', ...auth(SA, M), ses.schedulerRun);
  // external cron: authenticated by the X-Cron-Secret header only (CRON_SECRET)
  router.post('/engine/scheduler/cron', ses.cronRun);
}
