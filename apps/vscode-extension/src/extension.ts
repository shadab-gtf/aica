/**
 * Extension entry point.
 *
 * This file wires; it does not decide. Every non-trivial decision lives either
 * in the server (which is the policy enforcement point, §3) or in the pure
 * modules under `model/`. What is left here is lifecycle: start the server,
 * open the workspace as a project, register views and commands, and take
 * everything down cleanly.
 *
 * The one thing this process owns that the server cannot is **SecretStorage**.
 * The OS keychain is reachable from the extension host and nowhere else, so the
 * server asks for a secret over the reverse RPC channel and this file answers.
 * A key set here is never written to settings, never placed in a workspace
 * file, and never echoed back to the UI — the only thing the extension will
 * tell you afterwards is whether one is set.
 */

import * as vscode from 'vscode';

import { clientMethods } from '@aica/schemas';
import type {
  ApiSummary,
  EndpointSummary,
  PatchSummary,
  PlanSummary,
  RunRecord,
  ValidationSummary,
} from '@aica/schemas';
import type { AgentEvent, Result } from '@aica/shared';

import { ChatPanel } from './chat.js';
import { AgentClient } from './client.js';
import { VirtualDocuments, showDocument, showProposedDiff } from './documents.js';
import { summarizeValidation } from './model/diagnostics.js';
import { demandsAttention, statusBarText } from './model/status.js';
import { apiCatalogTree, patchTree, planTree, runTree, validationTree } from './model/tree.js';
import type { TreeNode } from './model/tree.js';
import { FindingActionProvider, ProblemReporter } from './problems.js';
import { RestartPolicy, ServerProcess, resolveServerEntry } from './serverProcess.js';
import { NodeTreeProvider } from './views.js';

/** The SecretStorage key the `keychain:postman` reference resolves to. */
const POSTMAN_SECRET_KEY = 'postman';

let session: Session | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const output = vscode.window.createOutputChannel('AICA', { log: true });
  context.subscriptions.push(output);

  session = new Session(context, output);
  context.subscriptions.push(new vscode.Disposable(() => session?.dispose()));

  session.registerUi();
  await session.start();
}

export function deactivate(): void {
  session?.dispose();
  session = undefined;
}

class Session {
  private readonly documents = new VirtualDocuments();
  private readonly apisView: NodeTreeProvider;
  private readonly planView: NodeTreeProvider;
  private readonly validationView: NodeTreeProvider;
  private readonly changesView: NodeTreeProvider;
  private readonly timelineView: NodeTreeProvider;
  private readonly problems: ProblemReporter;
  private readonly statusItem: vscode.StatusBarItem;
  private readonly restarts = new RestartPolicy();

  private server: ServerProcess | undefined;
  private client: AgentClient | undefined;
  private projectId: string | undefined;
  private startedAt = 0;
  private disposed = false;

  private apis: readonly ApiSummary[] = [];
  private endpoints = new Map<string, readonly EndpointSummary[]>();
  private plan: PlanSummary | undefined;
  private validation: ValidationSummary | undefined;
  private patches: readonly PatchSummary[] = [];
  private runs: readonly RunRecord[] = [];
  private timeline: TreeNode[] = [];
  private activeRunId: string | undefined;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly output: vscode.LogOutputChannel,
  ) {
    const root = () => this.workspaceRoot;
    this.apisView = new NodeTreeProvider(root);
    this.planView = new NodeTreeProvider(root);
    this.validationView = new NodeTreeProvider(root);
    this.changesView = new NodeTreeProvider(root);
    this.timelineView = new NodeTreeProvider(root);
    this.problems = new ProblemReporter(root);

    this.statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    this.statusItem.command = 'aica.showOutput';
  }

  private get workspaceRoot(): vscode.Uri | undefined {
    return vscode.workspace.workspaceFolders?.[0]?.uri;
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  registerUi(): void {
    const { subscriptions } = this.context;

    subscriptions.push(
      vscode.window.registerTreeDataProvider('aica.apis', this.apisView),
      vscode.window.registerTreeDataProvider('aica.plan', this.planView),
      vscode.window.registerTreeDataProvider('aica.validation', this.validationView),
      vscode.window.registerTreeDataProvider('aica.changes', this.changesView),
      vscode.window.registerTreeDataProvider('aica.timeline', this.timelineView),
      vscode.workspace.registerTextDocumentContentProvider('aica', this.documents),
      vscode.languages.registerCodeActionsProvider(
        { scheme: 'file' },
        new FindingActionProvider(),
        FindingActionProvider.metadata,
      ),
      this.problems,
      this.statusItem,
      new vscode.Disposable(() => this.documents.dispose()),
    );

    this.refreshViews();

    const command = (name: string, handler: (...args: never[]) => unknown): void => {
      subscriptions.push(vscode.commands.registerCommand(name, handler));
    };

    command('aica.chat', () => this.openChat());
    command('aica.showOutput', () => this.output.show());
    command('aica.restartServer', () => void this.restart());
    command('aica.indexWorkspace', () => void this.indexWorkspace());
    command('aica.importApi', () => void this.importApi());
    command('aica.importFromPostman', () => void this.importFromPostman());
    command('aica.setPostmanKey', () => void this.setPostmanKey());
    command('aica.clearPostmanKey', () => void this.clearPostmanKey());
    command('aica.createPlan', (message?: string) => void this.createPlan(message));
    command('aica.showPlanBrief', () => void this.showPlanBrief());
    command('aica.runValidation', () => void this.runValidation());
    command('aica.analyzeImpact', () => void this.analyzeImpact());
    command('aica.run', (task?: string) => void this.startRun(task));
    command('aica.cancelRun', () => void this.cancelRun());
    command('aica.reviewChange', (node?: TreeNode) => void this.reviewChange(node));
    command('aica.applyChange', (node?: TreeNode) => void this.applyChange(node));
    command('aica.revertChange', (node?: TreeNode) => void this.revertChange(node));
    command('aica.discardChange', (node?: TreeNode) => void this.discardChange(node));
  }

  async start(): Promise<void> {
    const root = this.workspaceRoot;
    if (!root) {
      // Nothing to analyse without a folder. Said once, in the status bar, and
      // not repeated as a modal on every activation.
      this.setStatus('$(folder) AICA: open a folder', 'AICA needs an open folder to work with.');
      return;
    }

    const configured = vscode.workspace.getConfiguration('aica');
    const entry = resolveServerEntry({
      configured: configured.get<string>('server.path') ?? '',
      extensionPath: this.context.extensionUri.fsPath,
    });

    this.startedAt = Date.now();
    this.server = new ServerProcess({
      entry,
      cwd: root.fsPath,
      logLevel: configured.get<string>('server.logLevel') ?? 'info',
      onStderr: (chunk) => this.output.append(chunk),
      onExit: (code, signal) => void this.onServerExit(code, signal),
    });

    let transport;
    try {
      transport = this.server.start();
    } catch (error) {
      this.fail(`The agent server could not start: ${(error as Error).message}`);
      return;
    }

    this.client = new AgentClient({
      transport,
      // Offered only because this process genuinely can do it. The server asks
      // for a capability only when the client advertised it.
      secrets: (name) => this.readSecret(name),
      approvals: (request) => this.askApproval(request),
      onEvent: (event) => this.onEvent(event),
      onLog: (level, message) => this.output.appendLine(`[server:${level}] ${message}`),
    });

    const handshake = await this.client.call(clientMethods.initialize, {
      clientName: 'vscode',
      clientVersion: this.context.extension.packageJSON.version ?? '0.0.0',
      capabilities: this.client.capabilities,
    });

    if (!handshake.ok) {
      this.fail(`The agent server did not respond: ${handshake.error.message}`);
      return;
    }

    this.output.info(
      `agent server ${handshake.value.serverVersion}, protocol ${handshake.value.protocolVersion}`,
    );

    const opened = await this.client.call(clientMethods.openProject, { root: root.fsPath });
    if (!opened.ok) {
      this.fail(`Could not open this folder: ${opened.error.message}`);
      return;
    }

    this.projectId = opened.value.projectId;
    this.restarts.reset();
    this.setStatus('$(check) AICA', `Connected. Project: ${opened.value.name}`);

    // Configuration problems are shown, not swallowed. Running on defaults the
    // user did not choose, silently, is how a tool ends up doing the wrong
    // thing very politely.
    for (const issue of opened.value.configIssues) {
      this.output.warn(`agent.config.json — ${issue.path}: ${issue.message}`);
    }
    if (opened.value.configIssues.length > 0) {
      void vscode.window
        .showWarningMessage(
          `AICA: ${opened.value.configIssues.length} problem(s) in agent.config.json. Defaults are in use.`,
          'Show Log',
        )
        .then((choice) => {
          if (choice === 'Show Log') this.output.show();
        });
    }

    await this.refreshApis();
    await this.refreshRuns();

    if (configured.get<boolean>('index.onStartup') === true) await this.indexWorkspace();
  }

  private async onServerExit(code: number | null, signal: NodeJS.Signals | null): Promise<void> {
    if (this.disposed) return;

    this.client?.dispose();
    this.client = undefined;
    this.projectId = undefined;

    const uptimeMs = Date.now() - this.startedAt;
    this.output.error(`agent server exited (code ${code ?? 'none'}, signal ${signal ?? 'none'})`);

    if (!this.restarts.shouldRestart(uptimeMs)) {
      // A server that dies on every start is misconfigured, and restarting it
      // forever burns a core and fills the log with the same failure.
      this.fail(
        `The agent server exited ${this.restarts.consecutiveFailures} times without starting properly. Use "AICA: Restart Agent Server" once the cause is fixed.`,
      );
      return;
    }

    this.setStatus('$(sync~spin) AICA: restarting…', 'The agent server exited and is restarting.');
    await this.start();
  }

  private async restart(): Promise<void> {
    this.server?.stop();
    this.client?.dispose();
    this.client = undefined;
    this.projectId = undefined;
    this.restarts.reset();
    await this.start();
  }

  dispose(): void {
    this.disposed = true;
    this.client?.dispose();
    this.server?.stop();
    ChatPanel.active?.dispose();
  }

  // -------------------------------------------------------------------------
  // Secrets
  // -------------------------------------------------------------------------

  /**
   * Answer the server's request for a stored credential.
   *
   * The value goes from the OS keychain to the server and nowhere else. It is
   * not logged, not shown, and not written to any settings file — only the fact
   * that a request happened is recorded.
   */
  private async readSecret(name: string): Promise<string | undefined> {
    const value = await this.context.secrets.get(`aica.${name}`);
    this.output.debug(`secret requested: ${name} (${value ? 'available' : 'not set'})`);
    return value ?? undefined;
  }

  private async setPostmanKey(): Promise<void> {
    const value = await vscode.window.showInputBox({
      title: 'Postman API key',
      prompt:
        'Stored in the OS keychain through VS Code SecretStorage. It is never written to settings or to your repository.',
      password: true,
      ignoreFocusOut: true,
      validateInput: (input) =>
        input.trim().length === 0 ? 'Enter a key, or press Escape to cancel.' : undefined,
    });

    if (value === undefined) return;

    await this.context.secrets.store(`aica.${POSTMAN_SECRET_KEY}`, value.trim());
    void vscode.window.showInformationMessage(
      'AICA: Postman key stored. Set `postman.apiKeyRef` to "keychain:postman" in agent.config.json to use it.',
    );
  }

  private async clearPostmanKey(): Promise<void> {
    await this.context.secrets.delete(`aica.${POSTMAN_SECRET_KEY}`);
    void vscode.window.showInformationMessage('AICA: Postman key removed from the keychain.');
  }

  private async askApproval(request: {
    subject: string;
    risk: string;
    detail: string;
  }): Promise<{ granted: boolean; remembered: boolean }> {
    const choice = await vscode.window.showWarningMessage(
      `AICA wants to ${request.subject}`,
      { modal: true, detail: `${request.detail}\n\nRisk: ${request.risk}` },
      'Allow',
      'Allow for this run',
    );

    // A dismissed prompt is a denial. Failing closed is the only safe reading
    // of "the user did not answer".
    if (choice === 'Allow') return { granted: true, remembered: false };
    if (choice === 'Allow for this run') return { granted: true, remembered: true };
    return { granted: false, remembered: false };
  }

  // -------------------------------------------------------------------------
  // Commands
  // -------------------------------------------------------------------------

  private openChat(): void {
    const panel = ChatPanel.show(this.context, (message) => void this.startRun(message));
    panel.setBusy(false);
  }

  // -------------------------------------------------------------------------
  // Runs
  // -------------------------------------------------------------------------

  /**
   * Start a run.
   *
   * The request resolves only when the run is over, which can be minutes.
   * Progress does not come from the response: it arrives as events on the
   * notification channel and is already on screen by the time this returns.
   */
  private async startRun(task?: string): Promise<void> {
    const ready = this.requireProject();
    if (!ready) return;

    const request =
      task ??
      (await vscode.window.showInputBox({
        title: 'What should the agent do?',
        prompt: 'For example: add a way to cancel an order',
        ignoreFocusOut: true,
      }));
    if (!request || request.trim().length === 0) return;

    const chat = ChatPanel.show(this.context, (message) => void this.startRun(message));
    chat.setBusy(true);
    this.setStatus('$(sync~spin) AICA: working…', request);

    const result = await ready.client.call(clientMethods.startRun, {
      projectId: ready.projectId,
      task: request,
    });

    chat.setBusy(false);
    this.activeRunId = undefined;

    if (!result.ok) {
      this.report('The run failed', result);
      chat.note(result.error.message, 'error');
      this.setStatus('$(error) AICA', result.error.message);
      await this.refreshRuns();
      return;
    }

    const summary = result.value;
    await this.refreshPatches();
    await this.refreshRuns();

    // What happened is stated in terms the user can act on, and a proposal is
    // never described as a change.
    if (summary.patchesProposed > summary.patchesApplied) {
      const pending = summary.patchesProposed - summary.patchesApplied;
      chat.note(
        `${pending} change${pending === 1 ? '' : 's'} proposed and waiting for review.`,
        'warning',
      );
      const choice = await vscode.window.showInformationMessage(
        `AICA proposed ${pending} change${pending === 1 ? '' : 's'}.`,
        'Review',
      );
      if (choice === 'Review') await vscode.commands.executeCommand('aica.changes.focus');
    } else if (summary.filesChanged.length === 0) {
      chat.note('No changes were made.', 'info', summary.summary);
    }

    this.setStatus(
      summary.validationPassed === true ? '$(pass) AICA' : '$(check) AICA',
      summary.validationPassed === true
        ? `Validated. ${summary.filesChanged.length} file(s) changed.`
        : summary.summary,
    );
  }

  private async cancelRun(): Promise<void> {
    const ready = this.requireProject();
    if (!ready || !this.activeRunId) {
      void vscode.window.showInformationMessage('AICA: nothing is running.');
      return;
    }

    await ready.client.call(clientMethods.cancelRun, { runId: this.activeRunId });
  }

  // -------------------------------------------------------------------------
  // Reviewing changes
  // -------------------------------------------------------------------------

  private patchIdOf(node?: TreeNode): string | undefined {
    if (node?.id.startsWith('patch:')) return node.id.split(':')[1];
    // Invoked from the palette rather than the tree: the oldest proposal is the
    // one the user has been waiting on.
    return this.patches.find((patch) => patch.status === 'proposed')?.patchId;
  }

  /**
   * Show a proposed change as a diff against the file on disk.
   *
   * Against the file as it is now, not as it was when the agent started — the
   * user may have edited it since, and reviewing against a stale snapshot would
   * hide exactly the conflict §37 exists to surface.
   */
  private async reviewChange(node?: TreeNode): Promise<void> {
    const ready = this.requireProject();
    const root = this.workspaceRoot;
    const patchId = this.patchIdOf(node);
    if (!ready || !root || !patchId) {
      void vscode.window.showInformationMessage('AICA: there is no change to review.');
      return;
    }

    const preview = await ready.client.call(clientMethods.previewPatch, {
      projectId: ready.projectId,
      patchId,
    });
    if (!preview.ok) {
      this.report('Could not open the change', preview);
      return;
    }

    for (const file of preview.value.files) {
      await showProposedDiff({
        documents: this.documents,
        workspaceRoot: root,
        file: file.path,
        proposed: file.after ?? '',
        title: `${file.path} — proposed`,
      });
    }

    const choice = await vscode.window.showInformationMessage(
      preview.value.rationale,
      { modal: false },
      'Apply',
      'Discard',
    );

    if (choice === 'Apply') await this.applyChange(node);
    if (choice === 'Discard') await this.discardChange(node);
  }

  private async applyChange(node?: TreeNode): Promise<void> {
    const ready = this.requireProject();
    const patchId = this.patchIdOf(node);
    if (!ready || !patchId) return;

    const result = await ready.client.call(clientMethods.applyPatch, {
      projectId: ready.projectId,
      patchId,
    });
    if (!result.ok) {
      this.report('Could not apply the change', result);
      return;
    }

    await this.refreshPatches();

    const choice = await vscode.window.showInformationMessage(
      `AICA applied changes to ${result.value.files.length} file(s).`,
      'Run Validation',
      'Revert',
    );
    if (choice === 'Run Validation') await this.runValidation();
    if (choice === 'Revert') await this.revertChange(node);
  }

  private async revertChange(node?: TreeNode): Promise<void> {
    const ready = this.requireProject();
    const patchId =
      node?.id.startsWith('patch:') === true
        ? node.id.split(':')[1]
        : this.patches.find((patch) => patch.status === 'applied')?.patchId;
    if (!ready || !patchId) return;

    const result = await ready.client.call(clientMethods.revertPatch, {
      projectId: ready.projectId,
      patchId,
    });
    if (!result.ok) {
      this.report('Could not revert the change', result);
      return;
    }

    await this.refreshPatches();
    void vscode.window.showInformationMessage(
      `AICA restored ${result.value.files.length} file(s).`,
    );
  }

  private async discardChange(node?: TreeNode): Promise<void> {
    const ready = this.requireProject();
    const patchId = this.patchIdOf(node);
    if (!ready || !patchId) return;

    const result = await ready.client.call(clientMethods.discardPatch, {
      projectId: ready.projectId,
      patchId,
    });
    if (!result.ok) {
      this.report('Could not discard the change', result);
      return;
    }

    await this.refreshPatches();
  }

  private async refreshPatches(): Promise<void> {
    const ready = this.requireProject(false);
    if (!ready) return;

    const result = await ready.client.call(clientMethods.listPatches, {
      projectId: ready.projectId,
    });
    if (!result.ok) return;

    this.patches = result.value.patches;
    this.refreshViews();
  }

  private async refreshRuns(): Promise<void> {
    const ready = this.requireProject(false);
    if (!ready) return;

    const result = await ready.client.call(clientMethods.listRuns, {
      projectId: ready.projectId,
    });
    if (!result.ok) return;

    this.runs = result.value.runs;
    this.refreshViews();
  }

  private async indexWorkspace(): Promise<void> {
    const ready = this.requireProject();
    if (!ready) return;

    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Window, title: 'AICA: indexing workspace' },
      async () => {
        const maxFiles = vscode.workspace.getConfiguration('aica').get<number>('index.maxFiles');
        const result = await ready.client.call(clientMethods.indexCode, {
          projectId: ready.projectId,
          ...(maxFiles ? { maxFiles } : {}),
        });

        if (!result.ok) {
          this.report('Indexing failed', result);
          return;
        }

        const stats = result.value;
        this.output.info(
          `indexed ${stats.files} files, ${stats.symbols} symbols, ${Math.round(stats.resolutionRate * 100)}% of references resolved in ${stats.durationMs}ms`,
        );
        // Skipped files are reported rather than hidden: an index that quietly
        // omitted a file will confidently tell you nothing depends on it.
        if (stats.skipped.length > 0) {
          this.output.warn(
            `${stats.skipped.length} file(s) were skipped: ${stats.skipped.join(', ')}`,
          );
        }

        this.setStatus('$(check) AICA', `${stats.files} files indexed`);
        await this.refreshApis();
      },
    );
  }

  private async importApi(): Promise<void> {
    const ready = this.requireProject();
    if (!ready) return;

    const choice = await vscode.window.showQuickPick(
      [
        { label: '$(file) From a file in this workspace', id: 'file' },
        { label: '$(clippy) From the clipboard', id: 'clipboard' },
        { label: '$(cloud) From Postman', id: 'postman' },
      ],
      { title: 'Import an API specification', ignoreFocusOut: true },
    );
    if (!choice) return;

    if (choice.id === 'postman') {
      await this.importFromPostman();
      return;
    }

    if (choice.id === 'clipboard') {
      const text = await vscode.env.clipboard.readText();
      if (text.trim().length === 0) {
        void vscode.window.showWarningMessage('AICA: the clipboard is empty.');
        return;
      }
      await this.doImport({ kind: 'text', text });
      return;
    }

    const picked = await vscode.window.showOpenDialog({
      title: 'Choose an API specification',
      canSelectMany: false,
      filters: { 'API specifications': ['json', 'yaml', 'yml', 'md'], 'All files': ['*'] },
      ...(this.workspaceRoot ? { defaultUri: this.workspaceRoot } : {}),
    });
    const file = picked?.[0];
    if (!file) return;

    const root = this.workspaceRoot;
    if (!root || !file.fsPath.startsWith(root.fsPath)) {
      // The server would refuse this anyway — every path is containment-checked
      // there — but saying so here is a better experience than a policy error.
      void vscode.window.showWarningMessage(
        'AICA: only files inside the open folder can be imported.',
      );
      return;
    }

    await this.doImport({
      kind: 'file',
      path: vscode.workspace.asRelativePath(file, false),
    });
  }

  private async importFromPostman(): Promise<void> {
    const ready = this.requireProject();
    if (!ready) return;

    const stored = await this.context.secrets.get(`aica.${POSTMAN_SECRET_KEY}`);
    if (!stored) {
      const choice = await vscode.window.showWarningMessage(
        'AICA: no Postman API key is stored.',
        'Set Key',
      );
      if (choice === 'Set Key') await this.setPostmanKey();
      return;
    }

    const workspaces = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Window, title: 'AICA: loading Postman workspaces' },
      () =>
        ready.client.call(clientMethods.listPostmanWorkspaces, {
          projectId: ready.projectId,
          refresh: false,
        }),
    );

    if (!workspaces.ok) {
      this.report('Could not load Postman workspaces', workspaces);
      return;
    }

    if (workspaces.value.workspaces.length === 0) {
      void vscode.window.showInformationMessage('AICA: this Postman key can see no workspaces.');
      return;
    }

    const workspace = await vscode.window.showQuickPick(
      workspaces.value.workspaces.map((entry) => ({
        label: entry.name,
        description: entry.type ?? '',
        detail: entry.description ?? '',
        id: entry.id,
      })),
      { title: 'Postman workspace', ignoreFocusOut: true, matchOnDescription: true },
    );
    if (!workspace) return;

    const collections = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Window, title: 'AICA: loading collections' },
      () =>
        ready.client.call(clientMethods.listPostmanCollections, {
          projectId: ready.projectId,
          workspaceId: workspace.id,
          refresh: false,
        }),
    );

    if (!collections.ok) {
      this.report('Could not load Postman collections', collections);
      return;
    }

    if (collections.value.collections.length === 0) {
      void vscode.window.showInformationMessage(`AICA: "${workspace.label}" has no collections.`);
      return;
    }

    const collection = await vscode.window.showQuickPick(
      collections.value.collections.map((entry) => ({
        label: entry.name,
        description: entry.updatedAt ? `updated ${entry.updatedAt}` : '',
        uid: entry.uid,
      })),
      { title: 'Postman collection', ignoreFocusOut: true },
    );
    if (!collection) return;

    await this.doImport({ kind: 'postman', collectionUid: collection.uid }, collection.label);
  }

  private async doImport(
    source:
      | { kind: 'text'; text: string }
      | { kind: 'file'; path: string }
      | { kind: 'postman'; collectionUid: string },
    name?: string,
  ): Promise<void> {
    const ready = this.requireProject();
    if (!ready) return;

    const result = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Window, title: 'AICA: importing API' },
      () =>
        ready.client.call(clientMethods.importApi, {
          projectId: ready.projectId,
          ...(name ? { name } : {}),
          source,
        }),
    );

    if (!result.ok) {
      this.report('Import failed', result);
      return;
    }

    void vscode.window.showInformationMessage(
      `AICA: imported "${result.value.name}" — ${result.value.endpointCount} endpoint(s).`,
    );
    await this.refreshApis();
  }

  private async createPlan(message?: string): Promise<void> {
    const ready = this.requireProject();
    if (!ready) return;

    const request =
      message ??
      (await vscode.window.showInputBox({
        title: 'What should the agent do?',
        prompt: 'For example: integrate POST /refunds into the order service',
        ignoreFocusOut: true,
      }));
    if (!request || request.trim().length === 0) return;

    const chat = ChatPanel.active;
    chat?.setBusy(true);

    const result = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Window, title: 'AICA: building a plan' },
      () =>
        ready.client.call(clientMethods.createPlan, {
          projectId: ready.projectId,
          message: request,
        }),
    );

    chat?.setBusy(false);

    if (!result.ok) {
      this.report('Could not build a plan', result);
      chat?.note(result.error.message, 'error');
      return;
    }

    this.plan = result.value;
    this.refreshViews();

    // A plan with open questions is a plan that should not be executed yet, so
    // it is surfaced rather than left for someone to notice in a tree.
    if (result.value.openQuestions.length > 0) {
      chat?.note(
        `The plan has ${result.value.openQuestions.length} open question(s).`,
        'warning',
        result.value.openQuestions.join('\n'),
      );
      void vscode.window
        .showWarningMessage(
          `AICA: the plan is ${result.value.confidence} confidence with ${result.value.openQuestions.length} open question(s).`,
          'Show Plan',
        )
        .then((choice) => {
          if (choice === 'Show Plan') void vscode.commands.executeCommand('aica.plan.focus');
        });
    } else {
      chat?.note(
        result.value.endpoint
          ? `Plan ready: ${result.value.endpoint.method} ${result.value.endpoint.path}`
          : 'Plan ready',
        'success',
        `${result.value.steps.length} step(s), ${result.value.confidence} confidence`,
      );
    }
  }

  private async showPlanBrief(): Promise<void> {
    const ready = this.requireProject();
    if (!ready || !this.plan) {
      void vscode.window.showInformationMessage('AICA: build a plan first.');
      return;
    }

    const result = await ready.client.call(clientMethods.getPlanBrief, {
      projectId: ready.projectId,
      planId: this.plan.planId,
    });

    if (!result.ok) {
      this.report('Could not render the brief', result);
      return;
    }

    await showDocument({
      documents: this.documents,
      kind: 'brief',
      path: 'plan-brief.md',
      content: result.value.brief,
      language: 'markdown',
    });
  }

  private async runValidation(): Promise<void> {
    const ready = this.requireProject();
    if (!ready) return;

    this.setStatus('$(sync~spin) AICA: validating…', 'Running the configured checks.');

    const result = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Window, title: 'AICA: running validation' },
      () => ready.client.call(clientMethods.runValidation, { projectId: ready.projectId }),
    );

    if (!result.ok) {
      this.report('Validation could not run', result);
      this.setStatus('$(error) AICA', result.error.message);
      return;
    }

    this.validation = result.value;
    this.problems.report(result.value.findings);
    this.refreshViews();

    const summary = summarizeValidation(result.value);
    this.setStatus(result.value.passed ? `$(pass) ${summary}` : `$(error) ${summary}`, summary);

    // Findings with no file cannot appear in the problems view against a line,
    // so they go to the log rather than being lost.
    for (const finding of this.problems.unlocatedFindings) {
      this.output.warn(`${finding.check}: ${finding.message}`);
    }
  }

  private async analyzeImpact(): Promise<void> {
    const ready = this.requireProject();
    if (!ready) return;

    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      void vscode.window.showInformationMessage('AICA: open a file first.');
      return;
    }

    const file = vscode.workspace.asRelativePath(editor.document.uri, false);
    const result = await ready.client.call(clientMethods.analyzeImpact, {
      projectId: ready.projectId,
      file,
    });

    if (!result.ok) {
      this.report('Impact analysis failed', result);
      return;
    }

    const lines = [
      `# Impact of changing ${file}`,
      '',
      `${result.value.affected.length} affected symbol(s) across ${result.value.files.length} file(s).`,
      result.value.truncated ? '\n> The traversal hit its cap; this report is partial.' : '',
      '',
      '## Files',
      ...result.value.files.map((entry) => `- ${entry}`),
      '',
      '## Affected',
      ...result.value.affected.map(
        (entry) => `- ${entry.name} (${entry.file}, ${entry.distance} hop(s))`,
      ),
    ];

    if (result.value.blindSpots.length > 0) {
      // What the analysis could not see is part of the answer. Omitting it
      // turns "nothing else I can prove" into "nothing else".
      lines.push(
        '',
        '## Not covered by this analysis',
        'These references could not be attributed, so a change here might affect them without this report saying so.',
        ...result.value.blindSpots.map((spot) => `- ${spot.detail} (${spot.kind})`),
      );
    }

    await showDocument({
      documents: this.documents,
      kind: 'impact',
      path: `${file}.impact.md`,
      content: lines.join('\n'),
      language: 'markdown',
    });
  }

  // -------------------------------------------------------------------------
  // State
  // -------------------------------------------------------------------------

  private async refreshApis(): Promise<void> {
    const ready = this.requireProject(false);
    if (!ready) return;

    const apis = await ready.client.call(clientMethods.listApis, { projectId: ready.projectId });
    if (!apis.ok) {
      this.output.warn(`could not list APIs: ${apis.error.message}`);
      return;
    }
    this.apis = apis.value.apis;

    const endpoints = await ready.client.call(clientMethods.listEndpoints, {
      projectId: ready.projectId,
    });

    const grouped = new Map<string, EndpointSummary[]>();
    if (endpoints.ok) {
      for (const endpoint of endpoints.value.endpoints) {
        const existing = grouped.get(endpoint.apiId);
        if (existing) existing.push(endpoint);
        else grouped.set(endpoint.apiId, [endpoint]);
      }
    }
    this.endpoints = grouped;

    this.refreshViews();
  }

  private onEvent(event: AgentEvent): void {
    ChatPanel.active?.append(event);
    this.activeRunId = event.runId;

    const status = statusBarText(event);
    if (status !== undefined) this.setStatus(`$(sync~spin) ${status}`, status);

    // A proposal appearing is the moment review becomes possible, so the view
    // updates then rather than at the end of a run that may take minutes more.
    if (event.type === 'PATCH_CREATED' || event.type === 'PATCH_APPLIED') {
      void this.refreshPatches();
    }

    if (event.type === 'VALIDATION_FAILED' || event.type === 'VALIDATION_PASSED') {
      void this.runValidationFromEvent();
    }

    if (demandsAttention(event)) {
      // Something is waiting on the user. A chat panel behind three editor tabs
      // is not a notification.
      ChatPanel.show(this.context, (message) => void this.startRun(message));
    }
  }

  /**
   * Refresh the problems view after the agent ran the checks itself.
   *
   * The event says a check passed or failed; it does not carry the findings,
   * because an event payload is not the place for a hundred compiler errors.
   * This asks for them.
   */
  private async runValidationFromEvent(): Promise<void> {
    const ready = this.requireProject(false);
    if (!ready) return;

    const result = await ready.client.call(clientMethods.runValidation, {
      projectId: ready.projectId,
      only: [],
    });
    if (!result.ok) return;

    this.validation = result.value;
    this.problems.report(result.value.findings);
    this.refreshViews();
  }

  private refreshViews(): void {
    this.apisView.set(apiCatalogTree(this.apis, this.endpoints));
    this.planView.set(planTree(this.plan));
    this.validationView.set(validationTree(this.validation));
    this.changesView.set(patchTree(this.patches));
    this.timelineView.set(this.timeline.length > 0 ? this.timeline : runTree(this.runs));
  }

  private requireProject(complain = true): { client: AgentClient; projectId: string } | undefined {
    if (this.client && this.projectId && !this.client.isClosed) {
      return { client: this.client, projectId: this.projectId };
    }
    if (complain) {
      void vscode.window
        .showWarningMessage('AICA: the agent server is not connected.', 'Restart Server')
        .then((choice) => {
          if (choice === 'Restart Server') void this.restart();
        });
    }
    return undefined;
  }

  private report(title: string, result: Result<unknown>): void {
    if (result.ok) return;
    this.output.error(`${title}: ${result.error.message}`);
    void vscode.window
      .showErrorMessage(`AICA: ${title} — ${result.error.message}`, 'Show Log')
      .then((choice) => {
        if (choice === 'Show Log') this.output.show();
      });
  }

  private fail(message: string): void {
    this.output.error(message);
    this.setStatus('$(error) AICA', message);
    void vscode.window.showErrorMessage(`AICA: ${message}`, 'Show Log').then((choice) => {
      if (choice === 'Show Log') this.output.show();
    });
  }

  private setStatus(text: string, tooltip: string): void {
    this.statusItem.text = text;
    this.statusItem.tooltip = tooltip;
    this.statusItem.show();
  }
}
