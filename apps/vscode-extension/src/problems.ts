/**
 * Findings in the problems view, and the quick fixes attached to them.
 *
 * The mapping itself lives in `model/diagnostics.ts`; this file owns the
 * editor-side collection and the code-action provider.
 *
 * One decision is worth stating here rather than in the model. A quick fix
 * offered by this extension never edits code directly. It offers to *ask the
 * agent* to fix the finding, which routes through the plan, the patch review,
 * and the validation pipeline like any other change. A lightbulb that silently
 * rewrites a line is exactly the kind of unreviewed edit §37 exists to prevent.
 */

import * as vscode from 'vscode';

import type { ValidationFindingSummary } from '@aica/schemas';

import { toDiagnostics } from './model/diagnostics.js';

export const DIAGNOSTIC_COLLECTION = 'aica';

export class ProblemReporter {
  private readonly collection: vscode.DiagnosticCollection;
  private unlocated: readonly ValidationFindingSummary[] = [];

  constructor(private readonly workspaceRoot: () => vscode.Uri | undefined) {
    this.collection = vscode.languages.createDiagnosticCollection(DIAGNOSTIC_COLLECTION);
  }

  /** Replace every finding this extension owns. */
  report(findings: readonly ValidationFindingSummary[]): void {
    this.collection.clear();

    const root = this.workspaceRoot();
    if (!root) return;

    const { byFile, unlocated } = toDiagnostics(findings);
    this.unlocated = unlocated;

    for (const [file, descriptors] of byFile) {
      const uri = vscode.Uri.joinPath(root, file);

      this.collection.set(
        uri,
        descriptors.map((descriptor) => {
          const diagnostic = new vscode.Diagnostic(
            new vscode.Range(
              descriptor.startLine,
              descriptor.startColumn,
              descriptor.endLine,
              // A whole-line range asks for a column past the end; the editor
              // clamps it to the real line length.
              descriptor.wholeLine ? Number.MAX_SAFE_INTEGER : descriptor.endColumn,
            ),
            descriptor.message,
            toSeverity(descriptor.severity),
          );

          diagnostic.source = descriptor.source;
          if (descriptor.code !== undefined) diagnostic.code = descriptor.code;
          return diagnostic;
        }),
      );
    }
  }

  /**
   * Findings that named no file.
   *
   * They are kept and surfaced rather than dropped: an unlocated compiler error
   * is still a failing build, and a problems view that disagrees with the
   * terminal is worse than one that says "somewhere".
   */
  get unlocatedFindings(): readonly ValidationFindingSummary[] {
    return this.unlocated;
  }

  clear(): void {
    this.collection.clear();
    this.unlocated = [];
  }

  dispose(): void {
    this.collection.dispose();
  }
}

function toSeverity(severity: 'error' | 'warning' | 'info'): vscode.DiagnosticSeverity {
  if (severity === 'error') return vscode.DiagnosticSeverity.Error;
  if (severity === 'warning') return vscode.DiagnosticSeverity.Warning;
  return vscode.DiagnosticSeverity.Information;
}

/**
 * Quick fixes for this extension's own diagnostics.
 *
 * Only ours: offering an action on another tool's diagnostic would put this
 * extension in the middle of a workflow it does not understand.
 */
export class FindingActionProvider implements vscode.CodeActionProvider {
  static readonly metadata: vscode.CodeActionProviderMetadata = {
    providedCodeActionKinds: [vscode.CodeActionKind.QuickFix],
  };

  provideCodeActions(
    _document: vscode.TextDocument,
    _range: vscode.Range | vscode.Selection,
    context: vscode.CodeActionContext,
  ): vscode.CodeAction[] {
    const ours = context.diagnostics.filter((diagnostic) =>
      diagnostic.source?.startsWith(`${DIAGNOSTIC_COLLECTION}/`),
    );
    if (ours.length === 0) return [];

    const actions: vscode.CodeAction[] = [];

    for (const diagnostic of ours) {
      const fix = new vscode.CodeAction(
        `Ask AICA to fix: ${truncate(diagnostic.message)}`,
        vscode.CodeActionKind.QuickFix,
      );
      fix.diagnostics = [diagnostic];
      fix.command = {
        command: 'aica.createPlan',
        title: 'Plan a fix',
        // The message is the request. The agent re-derives the failure from the
        // validation run rather than trusting a string from the UI.
        arguments: [`fix this validation failure: ${diagnostic.message}`],
      };
      actions.push(fix);
    }

    if (ours.length > 1) {
      const all = new vscode.CodeAction(
        `Ask AICA to fix all ${ours.length} findings here`,
        vscode.CodeActionKind.QuickFix,
      );
      all.diagnostics = [...ours];
      all.command = {
        command: 'aica.createPlan',
        title: 'Plan a fix',
        arguments: ['fix the validation failures in this file'],
      };
      actions.push(all);
    }

    return actions;
  }
}

function truncate(message: string, max = 60): string {
  const single = message.replace(/\s+/g, ' ').trim();
  return single.length <= max ? single : `${single.slice(0, max - 1)}…`;
}
