import express, { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import { AppError } from '../../lib/errors.js';
import type { Params } from '../../services/freedompay.js';
import { authed, type AppDeps } from '../deps.js';
import { parse } from '../middleware.js';

const checkoutSchema = z.object({
  plan: z.enum(['pro']),
  language: z.enum(['ru', 'en']).default('ru'),
});

function billingOf(deps: AppDeps) {
  if (!deps.billing) throw new AppError(503, 'payments_unavailable', 'Billing is not available on this server');
  return deps.billing;
}

/** Signed-in part: the Billing page and starting a card payment. */
export function billingRouter(deps: AppDeps): Router {
  const router = Router();

  router.get('/', async (req, res) => {
    const { user } = authed(req);
    res.json(await billingOf(deps).overview(user.id));
  });

  const checkoutLimit = rateLimit({
    windowMs: 10 * 60_000,
    limit: 10,
    keyGenerator: (req) => (req as express.Request).user?.id ?? 'anon',
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { error: { code: 'rate_limited', message: 'Too many payment attempts. Wait a few minutes.' } },
  });

  router.post('/checkout', checkoutLimit, async (req, res) => {
    const { user } = authed(req);
    const body = parse(checkoutSchema, req.body ?? {});
    res.status(201).json(await billingOf(deps).createCheckout(user, body.plan, body.language));
  });

  return router;
}

/**
 * Freedom Pay's result notification (server to server, no session). Trust comes only from the
 * pg_sig signature made with the merchant secret, checked in Billing.
 */
export function freedomPayResultHandler(deps: AppDeps) {
  const limit = rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: 'draft-8', legacyHeaders: false });
  const form = express.urlencoded({ extended: false, limit: '64kb', parameterLimit: 200 });
  return [
    limit,
    form,
    async (req: express.Request, res: express.Response) => {
      if (!deps.billing) {
        res.status(404).end();
        return;
      }
      const params: Params = {};
      for (const [key, value] of Object.entries((req.body ?? {}) as Record<string, unknown>)) {
        if (typeof value === 'string') params[key] = value;
      }
      // Freedom Pay signs with the name of the script it calls: the last path segment.
      const script = req.path.split('/').filter(Boolean).pop() ?? 'result';
      const xml = await deps.billing.handleFreedomPayResult(params, script);
      res.type('application/xml').send(xml);
    },
  ] as const;
}
