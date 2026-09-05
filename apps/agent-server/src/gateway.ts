/**
 * The method table.
 *
 * Every call arrives here as unvalidated JSON from another process and leaves
 * as a validated, typed object — or as an error that names the offending field.
 * Registration takes the contract from `@aica/schemas`, so a handler cannot be
 * bound to a method without also binding its schema; there is no path that
 * skips validation because there is no `register(name, handler)` overload.
 *
 * Results are validated too, which is less obvious and more useful than it
 * looks: Zod object schemas strip unknown keys, so an internal record handed
 * back by mistake loses everything the contract does not name. That turns
 * "don't leak internal state to the UI" from a review comment into a property
 * of the transport.
 */

import type { MethodContract } from '@aica/schemas';
import type { RequestContext, RpcConnection } from '@aica/rpc';
import type { Logger, Result } from '@aica/shared';
import { AgentError, ErrorCode, err, ok, silentLogger } from '@aica/shared';
import type { z } from 'zod';

export type Handler<P, R> = (params: P, context: RequestContext) => Promise<Result<R>>;

export interface GatewayOptions {
  readonly connection: RpcConnection;
  readonly logger?: Logger;
}

export class Gateway {
  private readonly logger: Logger;
  private readonly registered: string[] = [];

  constructor(private readonly options: GatewayOptions) {
    this.logger = (options.logger ?? silentLogger).child('gateway');
  }

  get methods(): readonly string[] {
    return [...this.registered].sort();
  }

  /** Bind one contract to its implementation. */
  register<P extends z.ZodTypeAny, R extends z.ZodTypeAny>(
    contract: MethodContract<P, R>,
    handler: Handler<z.infer<P>, z.infer<R>>,
  ): void {
    this.registered.push(contract.method);

    this.options.connection.onRequest(contract.method, async (raw, context) => {
      const params = contract.params.safeParse(raw ?? {});
      if (!params.success) {
        return err(invalidParams(contract.method, params.error));
      }

      const started = Date.now();
      const result = await handler(params.data as z.infer<P>, context);

      if (!result.ok) {
        // Logged at debug: a failed call is usually the user asking for
        // something that is not there, not a server problem. The client gets
        // the structured error either way.
        this.logger.debug('call failed', {
          method: contract.method,
          code: result.error.code,
        });
        return result;
      }

      const validated = contract.result.safeParse(result.value);
      if (!validated.success) {
        // This is a bug in this server, not in the caller: the handler built a
        // result its own contract does not accept. Fail loudly rather than
        // sending a shape the client cannot parse.
        this.logger.error('handler produced a result that violates its contract', {
          method: contract.method,
          issues: validated.error.issues.map((issue) => issue.path.join('.')).join(', '),
        });
        return err(
          new AgentError(
            ErrorCode.INTERNAL,
            `The server produced an invalid result for "${contract.method}".`,
            { details: { method: contract.method } },
          ),
        );
      }

      this.logger.debug('call completed', {
        method: contract.method,
        durationMs: Date.now() - started,
      });

      return ok(validated.data as unknown);
    });
  }
}

/**
 * Turn a validation failure into an error a person can act on.
 *
 * The field path matters more than the message. "Invalid input" sends someone
 * reading protocol source; "projectId: Required" tells them what to send.
 */
function invalidParams(method: string, error: z.ZodError): AgentError {
  const issues = error.issues.map((issue) => ({
    path: issue.path.join('.') || '(root)',
    message: issue.message,
  }));

  const summary = issues
    .slice(0, 5)
    .map((issue) => `${issue.path}: ${issue.message}`)
    .join('; ');

  return new AgentError(ErrorCode.INVALID_INPUT, `Invalid parameters for "${method}". ${summary}`, {
    details: { method, issues },
  });
}
