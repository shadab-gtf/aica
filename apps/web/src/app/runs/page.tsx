import { Notice } from '@/components/Notice';
import { LiveTimeline } from '@/components/LiveTimeline';
import { callAgent } from '@/lib/agent';
import { currentProject } from '@/lib/project';

export const dynamic = 'force-dynamic';

interface RunRecord {
  id: string;
  task: string;
  provider: string;
  model: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  startedAt: string;
  finishedAt?: string;
  summary?: string;
  toolCalls: number;
  filesChanged: number;
  validationPassed?: boolean;
}

/**
 * Run history, and a live view of whatever is happening now.
 *
 * The validation column is the one that has to be exact. A run that changed
 * nothing has nothing to validate, and showing that as a tick would be the same
 * false reassurance the validation engine exists to prevent — so "no changes",
 * "validated", "not validated" and "unvalidated" are four separate things here.
 */
export default async function RunsPage() {
  const lookup = await currentProject();

  if (lookup.state !== 'ok') {
    return (
      <>
        <h1>Runs</h1>
        <Notice title="No project is open.">
          {lookup.state === 'unreachable'
            ? lookup.message
            : 'Open a folder in the VS Code extension and it will appear here.'}
        </Notice>
      </>
    );
  }

  const projectId = lookup.project.projectId;
  const runs = await callAgent<{ runs: RunRecord[] }>('run/list', { projectId, limit: 50 });

  return (
    <>
      <h1>Runs</h1>
      <p className="lede">
        Every event the agent emits, as it happens. This is the same stream the editor renders and
        the same one written to the run record.
      </p>

      <LiveTimeline projectId={projectId} />

      <h2>History</h2>
      {!runs.ok ? (
        <Notice kind="error" title="Run history could not be loaded.">
          {runs.error.message}
        </Notice>
      ) : runs.value.runs.length === 0 ? (
        <div className="empty">Nothing has run yet.</div>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Task</th>
              <th style={{ width: 110 }}>Status</th>
              <th style={{ width: 90 }}>Files</th>
              <th style={{ width: 140 }}>Validation</th>
              <th style={{ width: 170 }}>Started</th>
            </tr>
          </thead>
          <tbody>
            {runs.value.runs.map((run) => (
              <tr key={run.id}>
                <td>
                  {run.task}
                  {run.summary ? <div style={{ color: 'var(--muted)' }}>{run.summary}</div> : null}
                  <div className="mono" style={{ color: 'var(--muted)', fontSize: 12 }}>
                    {run.provider} · {run.model}
                  </div>
                </td>
                <td>
                  <span className={`badge ${statusClass(run.status)}`}>{run.status}</span>
                </td>
                <td>{run.filesChanged}</td>
                <td>{validationLabel(run)}</td>
                <td className="mono" style={{ color: 'var(--muted)', fontSize: 12 }}>
                  {new Date(run.startedAt).toLocaleString()}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}

function statusClass(status: RunRecord['status']): string {
  if (status === 'completed') return 'ok';
  if (status === 'failed') return 'error';
  return '';
}

function validationLabel(run: RunRecord) {
  if (run.filesChanged === 0) {
    // Nothing was written, so there was nothing to check. Not a pass.
    return <span className="badge">no changes</span>;
  }
  if (run.validationPassed === true) return <span className="badge ok">validated</span>;
  if (run.validationPassed === false) return <span className="badge error">not validated</span>;
  return <span className="badge warn">unvalidated</span>;
}
