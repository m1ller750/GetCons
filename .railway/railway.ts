/**
 * Railway Infrastructure as Code for GetCons (replaces the deprecated railway.json).
 *
 *   npx railway login && npx railway link
 *   npx railway config plan     # preview
 *   npx railway config apply    # create/update the service
 *
 * Secrets use preserve(): their values live only in Railway (Variables tab), never in git.
 * Replace the repository below with your fork.
 */
import { defineRailway, github, preserve, project, service } from 'railway/iac';

export default defineRailway(() => {
  const app = service('getcons', {
    source: github('m1ller750/GetCons', { branch: 'main' }),
    // The root Dockerfile builds the dashboard and the API into one image.
    build: { builder: 'DOCKERFILE', dockerfilePath: 'Dockerfile' },
    deploy: {
      // One always-on replica: Telegram webhooks must reach a process that never sleeps.
      numReplicas: 1,
      sleepApplication: false,
      restartPolicyType: 'ALWAYS',
      healthcheckPath: '/api/health',
      healthcheckTimeout: 60,
    },
    env: {
      NODE_ENV: 'production',
      TELEGRAM_MODE: 'webhook',
      GEMINI_MODEL: 'gemini-3.1-flash-lite',
      GEMINI_FALLBACK_MODEL: 'gemini-3.5-flash-lite',
      GEMINI_EMBEDDING_MODEL: 'gemini-embedding-001',
      LOG_LEVEL: 'info',
      SUPABASE_URL: preserve(),
      SUPABASE_ANON_KEY: preserve(),
      SUPABASE_SERVICE_ROLE_KEY: preserve(),
      GEMINI_API_KEY: preserve(),
      ENCRYPTION_KEY: preserve(),
      MANAGER_BOT_TOKEN: preserve(),
    },
  });

  return project('getcons', { resources: [app] });
});
