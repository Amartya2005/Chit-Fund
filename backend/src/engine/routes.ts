import { Router } from 'express';
import { authenticateToken, requireRoles } from '../middleware/auth.js';
import * as dues from './dues/dues.controller.js';

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
}
