/**
 * The typed client.
 *
 * Every call the extension makes goes through `call(contract, params)`, which
 * means the method name, the parameter shape, and the result shape all come
 * from one place. There is no `request('project/open', {...})` in the UI code,
 * so a renamed method is a compile error rather than a runtime "unknown method"
 * discovered by a user.
 *
 * The result is validated on arrival even though this client is talking to a
 * server from the same repository. Two processes are versioned separately the
 * moment one of them is installed rather than built — a packaged extension and
 * a server it spawns from a different install — and a UI that renders whatever
 * arrives will render `undefined` into a tree item and call it a day.
 *
 * No `vscode` import: everything here is transport plus schemas, so the whole
 * client can be exercised against a real server over a loopback pipe.
 */

import type { Transport } from '@aica/rpc';
import { RpcConnection } from '@aica/rpc';
import type { MethodContract, ParamsOf, ResultOf } from '@aica/schemas';
import {
  NOTIFY_EVENT,
  NOTIFY_LOG,
  eventNotificationSchema,
  logNotificationSchema,
  serverMethods,
} from '@aica/schemas';
import type { AgentEvent, Logger, Result } from '@aica/shared';
import { AgentError, ErrorCode, err, ok, silentLogger } from '@aica/shared';
import type { z } from 'zod';

/** Answers the server's request for a stored secret. */
export type SecretProvider = (name: string, reason: string) => Promise<string | undefined>;

/** Answers the server's request for the user's approval. */
export type ApprovalProvider = (request: {
  approvalId: string;
  subject: string;
  risk: string;
  detail: string;
  environment?: string;
}) => Promise<{ granted: boolean; remembered: boolean }>;

export interface AgentClientOptions {
  readonly transport: Transport;
  readonly logger?: Logger;
  readonly requestTimeoutMs?: number;
  /** Supplied only when the host can actually store secrets. */
  readonly secrets?: SecretProvider;
  readonly approvals?: ApprovalProvider;
  readonly onEvent?: (event: AgentEvent) => void;
  readonly onLog?: (level: string, message: string) => void;
}

export class AgentClient {
  private readonly connection: RpcConnection;
  private readonly logger: Logger;
  private readonly options: AgentClientOptions;

  constructor(options: AgentClientOptions) {
    this.options = options;
    this.logger = (options.logger ?? silentLogger).child('client');

    this.connection = new RpcConnection({
      transport: options.transport,
      logger: this.logger,
      ...(options.requestTimeoutMs !== undefined
        ? { requestTimeoutMs: options.requestTimeoutMs }
        : {}),
    });

    this.connection.onNotification(NOTIFY_EVENT, (params) => {
      const parsed = eventNotificationSchema.safeParse(params);
      if (!parsed.success) {
        this.logger.warn('discarded a malformed event notification');
        return;
      }
      // The envelope is validated; the payload is narrowed by the consumer
      // against the event union, which is its single definition.
      options.onEvent?.(parsed.data as unknown as AgentEvent);
    });

    this.connection.onNotification(NOTIFY_LOG, (params) => {
      const parsed = logNotificationSchema.safeParse(params);
      if (parsed.success) options.onLog?.(parsed.data.level, parsed.data.message);
    });

    // Registered only when the host offered the capability. Advertising a
    // capability that is not implemented turns a server call into a timeout,
    // which is a far worse failure than a clean refusal.
    if (options.secrets) {
      this.connection.onRequest(serverMethods.readSecret.method, async (raw) => {
        const params = serverMethods.readSecret.params.safeParse(raw);
        if (!params.success) {
          return err(new AgentError(ErrorCode.INVALID_INPUT, 'Malformed secret request.'));
        }

        const value = await options.secrets?.(params.data.name, params.data.reason);
        // The absence of a secret is reported as `found: false`, never as an
        // error carrying the name of what was missing into a log.
        return ok(value === undefined ? { found: false } : { found: true, value });
      });
    }

    if (options.approvals) {
      this.connection.onRequest(serverMethods.requestApproval.method, async (raw) => {
        const params = serverMethods.requestApproval.params.safeParse(raw);
        if (!params.success) {
          return err(new AgentError(ErrorCode.INVALID_INPUT, 'Malformed approval request.'));
        }

        const response = await options.approvals?.(params.data);
        // No answer means no permission. Failing closed is the only safe
        // default for a prompt the user dismissed.
        return ok(response ?? { granted: false, remembered: false });
      });
    }
  }

  get capabilities(): { secretStorage: boolean; approvals: boolean } {
    return {
      secretStorage: this.options.secrets !== undefined,
      approvals: this.options.approvals !== undefined,
    };
  }

  get isClosed(): boolean {
    return this.connection.isClosed;
  }

  /** Make one typed call. */
  async call<P extends z.ZodTypeAny, R extends z.ZodTypeAny>(
    contract: MethodContract<P, R>,
    params: ParamsOf<MethodContract<P, R>>,
    signal?: AbortSignal,
  ): Promise<Result<ResultOf<MethodContract<P, R>>>> {
    const response = await this.connection.request(contract.method, params, signal);
    if (!response.ok) return response;

    const validated = contract.result.safeParse(response.value);
    if (!validated.success) {
      return err(
        new AgentError(
          ErrorCode.MALFORMED_RESPONSE,
          `The agent server returned an unexpected result for "${contract.method}". The extension and the server may be different versions.`,
          {
            details: {
              method: contract.method,
              fields: validated.error.issues.map((issue) => issue.path.join('.')),
            },
          },
        ),
      );
    }

    return ok(validated.data as ResultOf<MethodContract<P, R>>);
  }

  dispose(): void {
    this.connection.dispose();
  }
}
