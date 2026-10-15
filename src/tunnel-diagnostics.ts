import { z } from 'zod';

export const tunnelDiagnosticsSchema = z.object({
  activeConnections: z.number().int().nonnegative(),
  protocol: z.enum(['quic', 'http2']).nullable(),
  requestFailures: z.number().int().nonnegative(),
  lastFailure: z
    .object({
      kind: z.enum(['origin_unreachable', 'control_stream', 'request_failed']),
      at: z.string().datetime(),
    })
    .nullable(),
});
export type TunnelDiagnostics = z.infer<typeof tunnelDiagnosticsSchema>;
