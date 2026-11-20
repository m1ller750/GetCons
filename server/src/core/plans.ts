/**
 * Plans and what they unlock, as in the pitch deck (Business model slide). The server is the
 * only place these limits are enforced; the dashboard just displays them.
 */

export const PLAN_IDS = ['free', 'start', 'business', 'pro'] as const;
export type PlanId = (typeof PLAN_IDS)[number];
export type PaidPlanId = Exclude<PlanId, 'free'>;

export interface Plan {
  id: PlanId;
  /** Monthly price in USD (what the checkout charges). */
  priceUsd: number;
  maxConsultants: number;
  /** AI replies per calendar month, across all consultants of the account. */
  monthlyReplies: number;
  maxDocumentsPerConsultant: number;
  maxExamplesPerConsultant: number;
  /** File uploads per day (scans and photos are read by Gemini, which costs money). */
  dailyUploads: number;
  /** Import of real chats as training examples. */
  chatImport: boolean;
  /** Owner alerts in Telegram/WhatsApp when a chat needs a human. */
  ownerAlerts: boolean;
  /** Days of history in analytics. */
  analyticsDays: number;
  /** Free bots sign their replies with "Powered by GetCons". */
  poweredBy: boolean;
  /** AI agent: works in the connected store (orders, cancellations, returns) and sends order updates. */
  agent: boolean;
  api: boolean;
  whiteLabel: boolean;
  prioritySupport: boolean;
}

export const PLANS: Record<PlanId, Plan> = {
  free: {
    id: 'free',
    priceUsd: 0,
    maxConsultants: 1,
    monthlyReplies: 100,
    maxDocumentsPerConsultant: 3,
    maxExamplesPerConsultant: 20,
    dailyUploads: 10,
    chatImport: false,
    ownerAlerts: false,
    analyticsDays: 7,
    poweredBy: true,
    agent: false,
    api: false,
    whiteLabel: false,
    prioritySupport: false,
  },
  start: {
    id: 'start',
    priceUsd: 19,
    maxConsultants: 1,
    monthlyReplies: 1_500,
    maxDocumentsPerConsultant: 50,
    maxExamplesPerConsultant: 500,
    dailyUploads: 50,
    chatImport: false,
    ownerAlerts: false,
    analyticsDays: 30,
    poweredBy: false,
    agent: false,
    api: false,
    whiteLabel: false,
    prioritySupport: false,
  },
  business: {
    id: 'business',
    priceUsd: 49,
    maxConsultants: 3,
    monthlyReplies: 5_000,
    maxDocumentsPerConsultant: 200,
    maxExamplesPerConsultant: 2_000,
    dailyUploads: 200,
    chatImport: true,
    ownerAlerts: true,
    analyticsDays: 90,
    poweredBy: false,
    agent: false,
    api: false,
    whiteLabel: false,
    prioritySupport: false,
  },
  pro: {
    id: 'pro',
    priceUsd: 129,
    maxConsultants: 10,
    monthlyReplies: 20_000,
    maxDocumentsPerConsultant: 200,
    maxExamplesPerConsultant: 2_000,
    dailyUploads: 200,
    chatImport: true,
    ownerAlerts: true,
    analyticsDays: 90,
    poweredBy: false,
    agent: true,
    api: true,
    whiteLabel: true,
    prioritySupport: true,
  },
};

/** One paid period. Paying again for the same plan extends it. */
export const PERIOD_DAYS = 30;

export const POWERED_BY = 'Powered by GetCons';

export interface SubscriptionRow {
  user_id: string;
  plan: PlanId;
  current_period_end: string | null;
  updated_at: string;
}

/** The plan in force right now: a paid plan only until its period ends. */
export function effectivePlan(sub: Pick<SubscriptionRow, 'plan' | 'current_period_end'> | null, now = new Date()): Plan {
  if (!sub || sub.plan === 'free') return PLANS.free;
  if (!sub.current_period_end || new Date(sub.current_period_end) <= now) return PLANS.free;
  return PLANS[sub.plan] ?? PLANS.free;
}

export function isPaidPlan(id: string): id is PaidPlanId {
  return id === 'start' || id === 'business' || id === 'pro';
}

/** First moment of the current calendar month (UTC): monthly reply quotas reset then. */
export function monthStart(now = new Date()): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
}
