/**
 * Read-only virtual documents, and the diff view built on them.
 *
 * Two things the extension shows are not files on disk: an executor brief, and
 * the *proposed* side of a change that has not been applied. Both are served
 * from here under the `aica:` scheme.
 *
 * The proposed side has to be a virtual document rather than a temporary file,
 * and the reason is the whole point of the review step. A proposed change that
 * exists on disk before the user has accepted it is a change that has already
 * happened — a build watcher picks it up, a test runner sees it, and the "do you
 * want this?" question has been answered by writing it down. Serving it from
 * memory keeps the answer genuinely open until the patch is applied
 * transactionally by `fs-engine`.
 */

import * as vscode from 'vscode';

export const AICA_SCHEME = 'aica';

export class VirtualDocuments implements vscode.TextDocumentContentProvider {
  private readonly emitter = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.emitter.event;

  private readonly contents = new Map<string, string>();

  provideTextDocumentContent(uri: vscode.Uri): string {
    return (
      this.contents.get(uri.toString()) ??
      '// This content is no longer available. It may have been superseded by a newer run.'
    );
  }

  /**
   * Publish a document.
   *
   * `label` becomes the tab title and `path` the notional file path, so an
   * editor showing a proposed TypeScript file gets TypeScript highlighting
   * rather than plain text.
   */
  publish(options: { kind: string; path: string; content: string }): vscode.Uri {
    const uri = vscode.Uri.from({
      scheme: AICA_SCHEME,
      path: `/${options.kind}/${options.path.replace(/^\/+/, '')}`,
      // A distinct query per publication means the editor treats a new version
      // as a new document rather than serving a cached one.
      query: String(this.contents.size),
    });

    this.contents.set(uri.toString(), options.content);
    this.emitter.fire(uri);
    return uri;
  }

  forget(uri: vscode.Uri): void {
    this.contents.delete(uri.toString());
  }

  clear(): void {
    this.contents.clear();
  }

  dispose(): void {
    this.emitter.dispose();
    this.contents.clear();
  }
}

/**
 * Open a diff between a file on disk and a proposed version of it.
 *
 * The left side is the real file, so what the user reviews is the change
 * against what is actually there right now — not against a snapshot taken when
 * the agent started, which may already be stale if they have been editing (§37).
 */
export async function showProposedDiff(options: {
  documents: VirtualDocuments;
  workspaceRoot: vscode.Uri;
  file: string;
  proposed: string;
  title?: string;
}): Promise<void> {
  const original = vscode.Uri.joinPath(options.workspaceRoot, options.file);
  const modified = options.documents.publish({
    kind: 'proposed',
    path: options.file,
    content: options.proposed,
  });

  await vscode.commands.executeCommand(
    'vscode.diff',
    original,
    modified,
    options.title ?? `${options.file} (proposed)`,
    { preview: true } satisfies vscode.TextDocumentShowOptions,
  );
}

/** Open a generated document, such as an executor brief, in a preview tab. */
export async function showDocument(options: {
  documents: VirtualDocuments;
  kind: string;
  path: string;
  content: string;
  language?: string;
}): Promise<void> {
  const uri = options.documents.publish({
    kind: options.kind,
    path: options.path,
    content: options.content,
  });

  const document = await vscode.workspace.openTextDocument(uri);
  if (options.language) await vscode.languages.setTextDocumentLanguage(document, options.language);
  await vscode.window.showTextDocument(document, { preview: true });
}
