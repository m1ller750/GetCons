import { z } from 'zod';

/**
 * What the owner allows the agent to do (Pro plan). Everything the agent changes in the store
 * (orders, cancellations, refunds) is also confirmed by the customer first.
 */
export interface AgentPermissions {
  /** Look up products, prices and stock in the connected store. */
  catalog: boolean;
  /** Tell customers the status of their orders (after checking it is their order). */
  orderStatus: boolean;
  /** Place orders (with a payment link when the store provides one). */
  createOrders: boolean;
  /** Cancel orders that are not shipped yet. */
  cancelOrders: boolean;
  /** Returns and refunds: automatic up to refundAutoLimit, larger ones wait for the owner. */
  returns: boolean;
  /** Message customers in their chat when their order changes (paid, shipped, delivered...). */
  notify: boolean;
}

export interface AgentSettings {
  enabled: boolean;
  permissions: AgentPermissions;
  /** Refunds up to this amount (store currency) run without the owner; 0 = the owner approves every refund. */
  refundAutoLimit: number;
}

export const DEFAULT_AGENT_SETTINGS: AgentSettings = {
  enabled: false,
  permissions: { catalog: true, orderStatus: true, createOrders: true, cancelOrders: true, returns: true, notify: true },
  refundAutoLimit: 0,
};

const permissionsSchema = z
  .object({
    catalog: z.boolean(),
    orderStatus: z.boolean(),
    createOrders: z.boolean(),
    cancelOrders: z.boolean(),
    returns: z.boolean(),
    notify: z.boolean(),
  })
  .partial()
  .strict();

export const agentSettingsInput = z
  .object({
    enabled: z.boolean(),
    permissions: permissionsSchema,
    refundAutoLimit: z.number().min(0).max(1_000_000),
  })
  .partial()
  .strict();

/** Tolerant read of the stored jsonb: unknown or missing keys fall back to the defaults. */
export function readAgentSettings(raw: unknown): AgentSettings {
  const value = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const perms = (value.permissions && typeof value.permissions === 'object' ? value.permissions : {}) as Record<string, unknown>;
  const flag = (v: unknown, fallback: boolean) => (typeof v === 'boolean' ? v : fallback);
  const d = DEFAULT_AGENT_SETTINGS;
  const limit = Number(value.refundAutoLimit);
  return {
    enabled: flag(value.enabled, d.enabled),
    permissions: {
      catalog: flag(perms.catalog, d.permissions.catalog),
      orderStatus: flag(perms.orderStatus, d.permissions.orderStatus),
      createOrders: flag(perms.createOrders, d.permissions.createOrders),
      cancelOrders: flag(perms.cancelOrders, d.permissions.cancelOrders),
      returns: flag(perms.returns, d.permissions.returns),
      notify: flag(perms.notify, d.permissions.notify),
    },
    refundAutoLimit: Number.isFinite(limit) && limit >= 0 ? limit : d.refundAutoLimit,
  };
}

export function mergeAgentSettings(current: AgentSettings, patch: z.infer<typeof agentSettingsInput>): AgentSettings {
  return {
    enabled: patch.enabled ?? current.enabled,
    permissions: { ...current.permissions, ...patch.permissions },
    refundAutoLimit: patch.refundAutoLimit ?? current.refundAutoLimit,
  };
}
