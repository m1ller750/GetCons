import { PLANS, type Plan } from '../core/plans.js';
import { AppError } from '../lib/errors.js';
import type { AppDeps } from './deps.js';

/** The caller's plan in force; without billing wired in (tests) everyone is on Free. */
export async function planOf(deps: AppDeps, userId: string): Promise<Plan> {
  return deps.billing ? deps.billing.plan(userId) : PLANS.free;
}

/** 402: the feature exists, the plan does not include it. The dashboard offers an upgrade. */
export function planRequired(feature: string, message: string): AppError {
  return new AppError(402, 'plan_required', message, { feature });
}
