/**
 * Tree views.
 *
 * Thin by design: the shapes come from `model/tree.ts`, and this file only
 * turns a `TreeNode` into a `vscode.TreeItem`. Anything that decides *what* to
 * show belongs on the other side of that line, where it can be tested without
 * an editor.
 */

import * as vscode from 'vscode';

import type { TreeNode } from './model/tree.js';

export class NodeTreeProvider implements vscode.TreeDataProvider<TreeNode> {
  private readonly emitter = new vscode.EventEmitter<TreeNode | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;

  private nodes: readonly TreeNode[] = [];

  constructor(private readonly workspaceRoot: () => vscode.Uri | undefined) {}

  set(nodes: readonly TreeNode[]): void {
    this.nodes = nodes;
    this.emitter.fire(undefined);
  }

  getChildren(element?: TreeNode): TreeNode[] {
    return [...(element ? (element.children ?? []) : this.nodes)];
  }

  getTreeItem(node: TreeNode): vscode.TreeItem {
    const hasChildren = (node.children?.length ?? 0) > 0;

    const item = new vscode.TreeItem(
      node.label,
      hasChildren
        ? // Sections a user needs to read — questions, findings — open by
          // default. A collapsed warning is a warning nobody sees.
          expandedByDefault(node)
          ? vscode.TreeItemCollapsibleState.Expanded
          : vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None,
    );

    item.id = node.id;
    if (node.description !== undefined) item.description = node.description;
    if (node.tooltip !== undefined) item.tooltip = node.tooltip;
    if (node.icon !== undefined) item.iconPath = new vscode.ThemeIcon(node.icon);
    if (node.contextValue !== undefined) item.contextValue = node.contextValue;

    const root = this.workspaceRoot();
    if (node.location && root) {
      const uri = vscode.Uri.joinPath(root, node.location.file);
      item.resourceUri = uri;
      item.command = {
        command: 'vscode.open',
        title: 'Open',
        arguments: [
          uri,
          node.location.line !== undefined
            ? ({
                selection: new vscode.Range(
                  // Tool positions are 1-based; the editor is 0-based.
                  Math.max(0, node.location.line - 1),
                  0,
                  Math.max(0, node.location.line - 1),
                  0,
                ),
              } satisfies vscode.TextDocumentShowOptions)
            : undefined,
        ],
      };
    }

    return item;
  }
}

function expandedByDefault(node: TreeNode): boolean {
  return (
    node.id === 'plan:questions' ||
    node.id === 'plan:steps' ||
    node.id === 'validation:diagnosis' ||
    node.kind === 'check'
  );
}
