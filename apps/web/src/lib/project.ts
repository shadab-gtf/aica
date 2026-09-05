import 'server-only';

import { callAgent } from './agent';

export interface ProjectSummary {
  projectId: string;
  name: string;
  root: string;
  configIssues: { path: string; message: string }[];
  hasConfig: boolean;
}

export type ProjectLookup =
  | { state: 'ok'; project: ProjectSummary }
  | { state: 'none' }
  | { state: 'unreachable'; message: string };

/**
 * Which project this dashboard is looking at.
 *
 * Asked for, rather than configured. The dashboard is started separately from
 * the editor and has no way to know a generated project id, so requiring one in
 * an environment variable would mean pasting a UUID in to see a page.
 *
 * `AICA_PROJECT_ID` still wins when it is set — several editor windows can be
 * open against one server, and then "the first one" is a coin toss.
 */
export async function currentProject(): Promise<ProjectLookup> {
  const listed = await callAgent<{ projects: ProjectSummary[] }>('project/list', {});

  if (!listed.ok) return { state: 'unreachable', message: listed.error.message };
  if (listed.value.projects.length === 0) return { state: 'none' };

  const requested = process.env['AICA_PROJECT_ID'];
  if (requested) {
    const match = listed.value.projects.find((project) => project.projectId === requested);
    // A configured id that does not match anything open is a stale id, and
    // silently showing a different project would be worse than saying so.
    if (!match) return { state: 'none' };
    return { state: 'ok', project: match };
  }

  return { state: 'ok', project: listed.value.projects[0] as ProjectSummary };
}
