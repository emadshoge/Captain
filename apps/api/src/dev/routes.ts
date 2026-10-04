import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { LogOnlySender, type OtpSenders } from '../auth/senders';

/**
 * DEVELOPMENT/TEST ONLY: shows messages "sent" by log-only OTP senders so the
 * flows can be exercised without real SMS/email. Registered only when
 * APP_ENV is development or test (never staging/production), and the
 * log-only senders themselves are refused in production by the config guard.
 */
export const devRoutes: FastifyPluginAsyncZod<{ senders: OtpSenders }> = async (
  app,
  { senders },
) => {
  app.get(
    '/v1/dev/outbox',
    { schema: { querystring: z.object({ destination: z.string().min(3).max(254) }) } },
    async (request) => {
      const entries = [senders.sms, senders.email]
        .filter((sender): sender is LogOnlySender => sender instanceof LogOnlySender)
        .flatMap((sender) => sender.outbox)
        .filter(
          (entry) =>
            entry.destination === request.query.destination.trim().toLowerCase() ||
            entry.destination === request.query.destination.trim(),
        );
      return { simulated: true, messages: entries.slice(-10) };
    },
  );
};
