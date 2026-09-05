/**
 * One open project, and everything scoped to it.
 *
 * §48 requires hard project isolation, and the cheapest way to get it is to
 * make the project the object that owns state rather than a key threaded
 * through shared maps. There is no cross-project query to write because there
 * is no shared collection to query: a session holds its own path policy, its
 * own index, its own API catalog, and its own secret resolver, and nothing
 * reaches across.
 *
 * Everything expensive is built lazily and cached until invalidated. Opening a
 * project must be instant — the extension calls it on activation — while
 * indexing a large repository is not, so the two are separate operations and
 * the UI decides when to pay.
 */

import { EndpointIndex, PostmanApiClient, parseApiSource, parsePostman } from '@aica/api-engine';
import type { ApiSpec } from '@aica/api-ir';
import type { CodeGraph } from '@aica/code-graph';
import { buildGraph } from '@aica/code-graph';
import type { CodeIndex } from '@aica/code-intelligence';
import { Indexer } from '@aica/code-intelligence';
import { CommandExecutor } from '@aica/exec-engine';
import { PatchEngine, WorkspaceReader } from '@aica/fs-engine';
import type { IntegrationPlan } from '@aica/integration-planner';
import type { AgentConfig } from '@aica/schemas';
import { defaultConfig, parseConfig } from '@aica/schemas';
import type { ConfigIssue } from '@aica/schemas';
import type { CommandRule } from '@aica/security-engine';
import { CommandPolicy, PathPolicy, Redactor, SecretResolver } from '@aica/security-engine';
import type { Id, Logger, Result } from '@aica/shared';
import { AgentError, ErrorCode, err, newId, ok, silentLogger } from '@aica/shared';
import { ValidationPipeline } from '@aica/validation-engine';

import type { Store } from './store/index.js';
import { MemoryStore, SupabaseStore, toApiSnapshot, toIndexSnapshot } from './store/index.js';

import { readFile } from 'node:fs/promises';
import path from 'node:path';

/** Reads a named secret from the client's keychain. Absent when unavailable. */
export type KeychainReader = (name: string, reason: string) => Promise<string | undefined>;

export interface ProjectSessionOptions {
  readonly root: string;
  readonly name?: string;
  readonly logger?: Logger;
  /** Wired to the editor's SecretStorage over the reverse RPC channel. */
  readonly keychainReader?: KeychainReader;
  /** Injected in tests so no Postman request ever leaves the process. */
  readonly fetchImpl?: typeof fetch;
}

export interface StoredApi {
  readonly apiId: string;
  readonly spec: ApiSpec;
  /** Where it came from, e.g. `openapi`, `postman-api`. */
  readonly format: string;
}

export interface StoredPlan {
  readonly planId: Id<'plan'>;
  readonly plan: IntegrationPlan;
  readonly createdAt: number;
}

export class ProjectSession {
  readonly projectId: Id<'proj'>;
  readonly root: string;
  readonly name: string;
  readonly logger: Logger;

  /**
   * Replaced in `open()` once configuration is known, so project-specific
   * patterns are in force before anything can be read or executed. Nothing
   * that redacts is constructed before that point.
   */
  private redactorInstance = new Redactor();

  private config: AgentConfig = defaultConfig();
  private configIssues: readonly ConfigIssue[] = [];
  private hasConfigFile = false;

  private pathPolicy: PathPolicy | undefined;
  private reader: WorkspaceReader | undefined;
  private executor: CommandExecutor | undefined;
  private secrets: SecretResolver | undefined;
  private postman: PostmanApiClient | undefined;

  private storeInstance: Store = new MemoryStore();
  private index: CodeIndex | undefined;
  private graph: CodeGraph | undefined;
  private endpointIndex: EndpointIndex | undefined;

  private readonly apis = new Map<string, StoredApi>();
  private readonly plans = new Map<string, StoredPlan>();

  constructor(private readonly options: ProjectSessionOptions) {
    this.projectId = newId('proj');
    this.root = path.resolve(options.root);
    this.name = options.name ?? path.basename(this.root);
    this.logger = (options.logger ?? silentLogger).child('project');
  }

  get redactor(): Redactor {
    return this.redactorInstance;
  }

  /**
   * Load configuration and build the policies.
   *
   * A missing or invalid `agent.config.json` is not fatal: the defaults can
   * read the repository and do nothing else without asking (§49), which is the
   * right posture for a project that has not been configured. The issues are
   * returned so the UI can show them rather than silently running on defaults
   * the user did not choose.
   */
  async open(): Promise<Result<true>> {
    const configPath = path.join(this.root, 'agent.config.json');

    try {
      const raw = await readFile(configPath, 'utf8');
      this.hasConfigFile = true;
      const parsed = parseConfig(JSON.parse(raw) as unknown);
      if (parsed.ok) this.config = parsed.config;
      else this.configIssues = parsed.issues;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') {
        this.configIssues = [
          { path: 'agent.config.json', message: `Could not be read: ${(error as Error).message}` },
        ];
      }
    }

    const { patterns, invalid } = compilePatterns(this.config.privacy.extraRedactionPatterns);
    if (invalid.length > 0) {
      // A redaction pattern that does not compile is a hole in the redaction,
      // so it is surfaced rather than dropped silently.
      this.configIssues = [
        ...this.configIssues,
        ...invalid.map((pattern) => ({
          path: 'privacy.extraRedactionPatterns',
          message: `"${pattern}" is not a valid regular expression and was not applied.`,
        })),
      ];
    }
    this.redactorInstance = new Redactor({ extraPatterns: patterns });

    const gitignore = await readOptional(path.join(this.root, '.gitignore'));

    try {
      this.pathPolicy = new PathPolicy({
        root: this.root,
        ...(gitignore !== undefined ? { gitignore } : {}),
        extraIgnores: this.config.privacy.ignorePaths,
      });
    } catch (error) {
      return err(
        new AgentError(ErrorCode.INVALID_INPUT, `Cannot open "${this.root}".`, { cause: error }),
      );
    }

    this.reader = new WorkspaceReader({
      pathPolicy: this.pathPolicy,
      redactor: this.redactorInstance,
      logger: this.logger,
    });

    this.executor = new CommandExecutor({
      pathPolicy: this.pathPolicy,
      commandPolicy: new CommandPolicy({
        additionalRules: this.config.permissions.additionalCommands.map(toCommandRule),
        blockedPrograms: this.config.permissions.blockedCommands,
      }),
      redactor: this.redactorInstance,
      logger: this.logger,
    });

    this.secrets = new SecretResolver({
      redactor: this.redactorInstance,
      fileReader: async (relative) => {
        // A secret file is still a file, and the containment rule applies to it
        // exactly as it does to source.
        const resolved = this.requirePathPolicy().resolve(relative);
        if (!resolved.ok) throw resolved.error;
        return readFile(resolved.value.absolute, 'utf8');
      },
      ...(this.options.keychainReader
        ? {
            keychainReader: async (name) => {
              const value = await this.options.keychainReader?.(
                name,
                'The agent server needs this credential to call an API on your behalf.',
              );
              if (value === undefined) {
                throw new AgentError(
                  ErrorCode.NOT_FOUND,
                  `No secret named "${name}" is stored in the editor.`,
                );
              }
              return value;
            },
          }
        : {}),
    });

    await this.openStore();

    const saved = await this.storeInstance.saveProject({
      id: this.projectId,
      name: this.name,
      root: this.root,
      fileCount: 0,
      symbolCount: 0,
      referenceCount: 0,
      resolutionRate: 0,
    });
    if (!saved.ok)
      this.logger.warn('could not record the project', { reason: saved.error.message });

    return ok(true);
  }

  /**
   * Connect the store, or fall back to memory and say why.
   *
   * A database that is not running must never be the reason someone cannot
   * index their code. The failure is recorded as a configuration issue — which
   * the UI shows — and the session continues without history, because losing
   * history is a much smaller loss than losing the ability to work.
   */
  private async openStore(): Promise<void> {
    const database = this.config.database;
    if (!database.enabled) return;

    if (!database.serviceKeyRef) {
      this.configIssues = [
        ...this.configIssues,
        {
          path: 'database.serviceKeyRef',
          message:
            'The database is enabled but no service-role key reference is set. Running without history.',
        },
      ];
      return;
    }

    const key = await this.requireSecrets().resolve(database.serviceKeyRef);
    if (!key.ok) {
      this.configIssues = [
        ...this.configIssues,
        {
          path: 'database.serviceKeyRef',
          message: `${key.error.message} Running without history.`,
        },
      ];
      return;
    }

    const store = new SupabaseStore({
      url: database.url,
      serviceKey: key.value,
      logger: this.logger,
      batchSize: database.batchSize,
    });

    // Checked once, here, rather than discovered on the first write halfway
    // through a run.
    const healthy = await store.health();
    if (!healthy.ok) {
      this.configIssues = [
        ...this.configIssues,
        { path: 'database', message: `${healthy.error.message} Running without history.` },
      ];
      return;
    }

    this.storeInstance = store;
    this.logger.info('connected to the database', { url: database.url });
  }

  get store(): Store {
    return this.storeInstance;
  }

  get configuration(): AgentConfig {
    return this.config;
  }

  get issues(): readonly ConfigIssue[] {
    return this.configIssues;
  }

  get configured(): boolean {
    return this.hasConfigFile;
  }

  get codeIndex(): CodeIndex | undefined {
    return this.index;
  }

  get codeGraph(): CodeGraph | undefined {
    return this.graph;
  }

  get apiCount(): number {
    return this.apis.size;
  }

  get planCount(): number {
    return this.plans.size;
  }

  listApis(): readonly StoredApi[] {
    return [...this.apis.values()];
  }

  api(apiId: string): StoredApi | undefined {
    return this.apis.get(apiId);
  }

  plan(planId: string): StoredPlan | undefined {
    return this.plans.get(planId);
  }

  /** Build or rebuild the code index, and the graph derived from it. */
  async buildIndex(options: { root?: string; maxFiles?: number } = {}): Promise<Result<CodeIndex>> {
    const indexer = new Indexer({
      reader: this.requireReader(),
      pathPolicy: this.requirePathPolicy(),
      logger: this.logger,
    });

    const built = await indexer.build(options);
    if (!built.ok) return built;

    this.index = built.value;
    // The graph is a pure function of the index, so it is rebuilt with it
    // rather than kept and patched — a stale graph is worse than no graph,
    // because it answers confidently.
    this.graph = buildGraph(built.value);

    // Written as a projection, never read back. §2 puts AST facts above stored
    // state, so the in-memory index is always re-derived from source; these
    // rows exist to be queried, not to reconstitute anything.
    const recorded = await this.storeInstance.replaceIndex(
      this.projectId,
      toIndexSnapshot(built.value, this.graph),
    );
    if (!recorded.ok) {
      this.logger.warn('could not record the index', { reason: recorded.error.message });
    }

    return ok(built.value);
  }

  /**
   * Add an API specification to the project's catalog.
   *
   * Every source format converges here through the parsers that already exist:
   * this method never learns a new format, it only decides which existing
   * parser to hand the document to.
   */
  addSpec(spec: ApiSpec, format: string): StoredApi {
    const stored: StoredApi = { apiId: spec.id, spec, format };
    this.apis.set(spec.id, stored);
    // The endpoint index spans the catalog, so adding a spec invalidates it.
    this.endpointIndex = undefined;

    // Unlike the index this is durable: a collection fetched over the network
    // should not have to be fetched again after a restart. Fire and forget —
    // the catalog in memory is already correct.
    void this.storeInstance.saveApi(this.projectId, toApiSnapshot(spec, format)).then((result) => {
      if (!result.ok) this.logger.warn('could not record the API', { apiId: spec.id });
    });

    return stored;
  }

  /** Parse a document from text and add it. */
  importText(text: string, options: { name?: string; format?: string } = {}): Result<StoredApi> {
    const parsed = parseApiSource(text, {
      ...(options.format ? { format: options.format as never } : {}),
      ...(options.name ? { location: options.name } : {}),
    });
    if (!parsed.ok) return parsed;
    return ok(this.addSpec(parsed.value, options.format ?? parsed.value.source.format));
  }

  /** Read a workspace file and add it, subject to the path policy. */
  async importFile(relativePath: string, format?: string): Promise<Result<StoredApi>> {
    const read = await this.requireReader().read(relativePath);
    if (!read.ok) return read;
    return this.importText(read.value.content, {
      name: relativePath,
      ...(format ? { format } : {}),
    });
  }

  /**
   * Fetch a Postman collection and add it.
   *
   * The client is transport only; normalization is `parsePostman`, the same
   * function a collection exported to a file goes through. One parser, two
   * ways in — which is the point of the IR.
   */
  async importPostmanCollection(collectionUid: string, name?: string): Promise<Result<StoredApi>> {
    const client = await this.postmanClient();
    if (!client.ok) return client;

    const document = await client.value.fetchCollection(collectionUid);
    if (!document.ok) return document;

    const parsed = parsePostman(document.value, {
      location: name ?? `postman:${collectionUid}`,
    });
    if (!parsed.ok) return parsed;

    return ok(this.addSpec(parsed.value, 'postman-api'));
  }

  storePlan(plan: IntegrationPlan): StoredPlan {
    const stored: StoredPlan = { planId: newId('plan'), plan, createdAt: Date.now() };
    this.plans.set(stored.planId, stored);
    return stored;
  }

  /** The endpoint index across every spec in the catalog, built on demand. */
  endpoints(): EndpointIndex {
    if (!this.endpointIndex) {
      this.endpointIndex = new EndpointIndex();
      for (const stored of this.apis.values()) this.endpointIndex.add(stored.spec);
    }
    return this.endpointIndex;
  }

  /** A patch engine bound to this project's path policy. */
  patchEngine(): PatchEngine {
    return new PatchEngine({ pathPolicy: this.requirePathPolicy(), logger: this.logger });
  }

  validation(): ValidationPipeline {
    return new ValidationPipeline({
      executor: this.requireExecutor(),
      config: this.config.validation,
      logger: this.logger,
    });
  }

  /**
   * A Postman client, if one can be configured.
   *
   * Deliberately returns an error rather than a null client when no key
   * reference is set: "Postman is not connected" is something the UI should
   * say, and a client that silently fails every call cannot say it.
   */
  async postmanClient(): Promise<Result<PostmanApiClient>> {
    if (this.postman) return ok(this.postman);

    const apiKeyRef = this.config.postman.apiKeyRef;
    if (!apiKeyRef) {
      return err(
        new AgentError(
          ErrorCode.CONFIG_ERROR,
          'No Postman API key is configured. Set `postman.apiKeyRef` to a secret reference such as `keychain:postman`.',
        ),
      );
    }

    this.postman = new PostmanApiClient({
      apiKeyRef,
      secrets: this.requireSecrets(),
      redactor: this.redactorInstance,
      logger: this.logger,
      cacheTtlMs: this.config.postman.cacheTtlMs,
      timeoutMs: this.config.postman.requestTimeoutMs,
      ...(this.options.fetchImpl ? { fetch: this.options.fetchImpl } : {}),
    });

    return ok(this.postman);
  }

  /** Whether Postman is configured, without making a request to find out. */
  get postmanConfigured(): boolean {
    return this.config.postman.apiKeyRef !== undefined;
  }

  requirePathPolicy(): PathPolicy {
    if (!this.pathPolicy) throw new Error('ProjectSession.open() has not been called.');
    return this.pathPolicy;
  }

  requireReader(): WorkspaceReader {
    if (!this.reader) throw new Error('ProjectSession.open() has not been called.');
    return this.reader;
  }

  requireExecutor(): CommandExecutor {
    if (!this.executor) throw new Error('ProjectSession.open() has not been called.');
    return this.executor;
  }

  requireSecrets(): SecretResolver {
    if (!this.secrets) throw new Error('ProjectSession.open() has not been called.');
    return this.secrets;
  }
}

/**
 * A configured program name becomes a rule at the lowest risk the executor can
 * express, never a blanket permit. A project saying "also allow `pnpm`" is
 * saying which program may run, not that anything it does is safe — the risk
 * class and the approval gate above it still apply.
 */
function toCommandRule(program: string): CommandRule {
  return {
    program,
    risk: 'LOW_RISK_WRITE',
    description: `Added by project configuration.`,
  };
}

function compilePatterns(sources: readonly string[]): {
  patterns: RegExp[];
  invalid: string[];
} {
  const patterns: RegExp[] = [];
  const invalid: string[] = [];

  for (const source of sources) {
    try {
      patterns.push(new RegExp(source, 'gi'));
    } catch {
      invalid.push(source);
    }
  }

  return { patterns, invalid };
}

async function readOptional(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, 'utf8');
  } catch {
    return undefined;
  }
}
