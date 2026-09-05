/**
 * The chat panel and the run timeline it renders.
 *
 * A webview is an untrusted document that happens to be ours, so the usual
 * rules apply and are worth being explicit about:
 *
 * - **A content security policy with a nonce**, so only the one inline script
 *   in this file can run, and nothing can be loaded from the network.
 * - **Every value is escaped before it reaches the DOM.** Event payloads
 *   contain file paths, tool output, and API descriptions — all of it
 *   ultimately from documents this project treats as untrusted data (§7). A
 *   template that interpolated one of those into HTML would be a script
 *   injection with an unusually literal delivery mechanism.
 * - **Messages from the webview are validated**, because a compromised webview
 *   is the exact thing the CSP is defending against, and defence in depth means
 *   not trusting it afterwards either.
 */

import * as vscode from 'vscode';

import type { AgentEvent } from '@aica/shared';

import type { TimelineEntry } from './model/status.js';
import { toTimelineEntry } from './model/status.js';

export type ChatSubmitHandler = (message: string) => void;

export class ChatPanel {
  private static current: ChatPanel | undefined;

  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly entries: TimelineEntry[] = [];
  private disposed = false;

  private constructor(
    panel: vscode.WebviewPanel,
    private readonly onSubmit: ChatSubmitHandler,
  ) {
    this.panel = panel;
    this.panel.webview.html = this.render();

    this.disposables.push(
      this.panel.webview.onDidReceiveMessage((raw: unknown) => {
        const message = raw as { type?: unknown; text?: unknown };
        if (message?.type !== 'submit' || typeof message.text !== 'string') return;

        const text = message.text.trim();
        if (text.length === 0) return;
        this.onSubmit(text);
      }),
    );

    this.panel.onDidDispose(() => this.dispose(), undefined, this.disposables);
  }

  static show(context: vscode.ExtensionContext, onSubmit: ChatSubmitHandler): ChatPanel {
    if (ChatPanel.current && !ChatPanel.current.disposed) {
      ChatPanel.current.panel.reveal(vscode.ViewColumn.Beside);
      return ChatPanel.current;
    }

    const panel = vscode.window.createWebviewPanel('aica.chat', 'AICA', vscode.ViewColumn.Beside, {
      enableScripts: true,
      // Nothing outside the extension is loadable, and there is nothing to
      // load: the panel has no external assets.
      localResourceRoots: [context.extensionUri],
      retainContextWhenHidden: true,
    });

    ChatPanel.current = new ChatPanel(panel, onSubmit);
    return ChatPanel.current;
  }

  static get active(): ChatPanel | undefined {
    return ChatPanel.current?.disposed === false ? ChatPanel.current : undefined;
  }

  /** Append one event to the timeline. */
  append(event: AgentEvent): void {
    if (this.disposed) return;
    const entry = toTimelineEntry(event);
    this.entries.push(entry);
    void this.panel.webview.postMessage({ type: 'entry', entry });
  }

  /** Show a line that did not come from the event stream, such as a local error. */
  note(label: string, severity: TimelineEntry['severity'] = 'info', detail?: string): void {
    if (this.disposed) return;
    const entry: TimelineEntry = {
      seq: this.entries.length + 1,
      at: new Date().toISOString(),
      type: 'LOCAL',
      label,
      ...(detail !== undefined ? { detail } : {}),
      icon: severity === 'error' ? 'error' : 'info',
      severity,
    };
    this.entries.push(entry);
    void this.panel.webview.postMessage({ type: 'entry', entry });
  }

  setBusy(busy: boolean): void {
    if (this.disposed) return;
    void this.panel.webview.postMessage({ type: 'busy', busy });
  }

  get timeline(): readonly TimelineEntry[] {
    return this.entries;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (ChatPanel.current === this) ChatPanel.current = undefined;
    for (const disposable of this.disposables) disposable.dispose();
    this.panel.dispose();
  }

  private render(): string {
    const nonce = createNonce();
    const csp = [
      "default-src 'none'",
      `style-src 'nonce-${nonce}'`,
      `script-src 'nonce-${nonce}'`,
    ].join('; ');

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<style nonce="${nonce}">
  :root { color-scheme: light dark; }
  body {
    margin: 0;
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-foreground);
    background: var(--vscode-editor-background);
    display: flex;
    flex-direction: column;
    height: 100vh;
  }
  #timeline { flex: 1; overflow-y: auto; padding: 12px; }
  .entry { display: flex; gap: 8px; padding: 4px 0; align-items: baseline; }
  .entry .seq {
    color: var(--vscode-descriptionForeground);
    font-variant-numeric: tabular-nums;
    min-width: 2.5em;
    text-align: right;
    font-size: 0.85em;
  }
  .entry .body { flex: 1; min-width: 0; }
  .entry .label { white-space: pre-wrap; overflow-wrap: anywhere; }
  .entry .detail {
    color: var(--vscode-descriptionForeground);
    font-size: 0.9em;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .error .label { color: var(--vscode-errorForeground); }
  .warning .label { color: var(--vscode-editorWarning-foreground); }
  .success .label { color: var(--vscode-testing-iconPassed, inherit); }
  #empty { color: var(--vscode-descriptionForeground); padding: 12px; }
  form { display: flex; gap: 8px; padding: 8px 12px 12px; border-top: 1px solid var(--vscode-panel-border); }
  textarea {
    flex: 1;
    resize: vertical;
    min-height: 2.4em;
    font-family: inherit;
    font-size: inherit;
    color: var(--vscode-input-foreground);
    background: var(--vscode-input-background);
    border: 1px solid var(--vscode-input-border, transparent);
    padding: 6px;
  }
  button {
    color: var(--vscode-button-foreground);
    background: var(--vscode-button-background);
    border: none;
    padding: 6px 12px;
    cursor: pointer;
  }
  button:disabled { opacity: 0.6; cursor: default; }
</style>
</head>
<body>
  <div id="timeline"><div id="empty">Describe what you want to build. Everything the agent does appears here.</div></div>
  <form id="composer">
    <textarea id="input" rows="2" placeholder="Integrate POST /refunds into the order service"></textarea>
    <button id="send" type="submit">Send</button>
  </form>
<script nonce="${nonce}">
  const vscodeApi = acquireVsCodeApi();
  const timeline = document.getElementById('timeline');
  const empty = document.getElementById('empty');
  const form = document.getElementById('composer');
  const input = document.getElementById('input');
  const send = document.getElementById('send');

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    vscodeApi.postMessage({ type: 'submit', text });
    input.value = '';
  });

  input.addEventListener('keydown', (event) => {
    // Enter sends, Shift+Enter is a newline — the convention everywhere else.
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      form.requestSubmit();
    }
  });

  window.addEventListener('message', (event) => {
    const message = event.data;
    if (message.type === 'busy') {
      send.disabled = message.busy;
      return;
    }
    if (message.type !== 'entry') return;

    if (empty && empty.parentNode) empty.remove();

    // Built with createElement and textContent, never innerHTML: every value
    // here originates in a document this project treats as untrusted.
    const row = document.createElement('div');
    row.className = 'entry ' + message.entry.severity;

    const seq = document.createElement('span');
    seq.className = 'seq';
    seq.textContent = String(message.entry.seq);

    const body = document.createElement('div');
    body.className = 'body';

    const label = document.createElement('div');
    label.className = 'label';
    label.textContent = message.entry.label;
    body.appendChild(label);

    if (message.entry.detail) {
      const detail = document.createElement('div');
      detail.className = 'detail';
      detail.textContent = message.entry.detail;
      body.appendChild(detail);
    }

    row.appendChild(seq);
    row.appendChild(body);
    timeline.appendChild(row);

    const atBottom = timeline.scrollHeight - timeline.scrollTop - timeline.clientHeight < 80;
    if (atBottom) timeline.scrollTop = timeline.scrollHeight;
  });
</script>
</body>
</html>`;
  }
}

function createNonce(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
