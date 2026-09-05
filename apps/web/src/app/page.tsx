import { Notice } from '@/components/Notice';
import { Stat } from '@/components/Stat';
import { agentHealth, callAgent } from '@/lib/agent';
import { currentProject } from '@/lib/project';

export const dynamic = 'force-dynamic';

interface ProjectSummary {
  projectId: string;
  name: string;
  root: string;
  configIssues: { path: string; message: string }[];
  hasConfig: boolean;
}

interface StatusResult {
  project: ProjectSummary;
  index?: {
    files: number;
    symbols: number;
    references: number;
    resolutionRate: number;
    unresolvedImports: number;
    skipped: string[];
  };
  apiCount: number;
  planCount: number;
  postmanReady: boolean;
}

/**
 * The overview.
 *
 * Every number here is counted, and where a number would be misleading on its
 * own the page says what it does not cover. A resolution rate of 65% with no
 * further comment reads as a defect; the same figure next to "member and global
 * references are counted, not attributed" reads as what it is.
 */
export default async function OverviewPage() {
  const health = await agentHealth();

  if (!health.configured) {
    return (
      <>
        <h1>Overview</h1>
        <Notice kind="error" title="This dashboard cannot authenticate to the agent server.">
          Set <code>AICA_SERVER_TOKEN</code> — the agent server prints it on startup — and{' '}
          <code>AICA_SERVER_URL</code> if it is not on the default port.
        </Notice>
      </>
    );
  }

  if (!health.reachable) {
    return (
      <>
        <h1>Overview</h1>
        <Notice kind="error" title="The agent server is not running.">
          Start it, or open a folder in the VS Code extension, which starts one.
        </Notice>
      </>
    );
  }

  const lookup = await currentProject();

  if (lookup.state !== 'ok') {
    return (
      <>
        <h1>Overview</h1>
        <div className="empty-state">
          <div style={{ fontSize: 48, marginBottom: 16 }}>▲</div>
          <h3>No project is open</h3>
          <p>
            {lookup.state === 'unreachable'
              ? lookup.message
              : 'Open a folder in the AICA VS Code extension to connect and analyze your workspace.'}
          </p>
        </div>
      </>
    );
  }

  const opened = await callAgent<StatusResult>('project/status', {
    projectId: lookup.project.projectId,
  });

  if (!opened.ok) {
    return (
      <>
        <h1>{lookup.project.name}</h1>
        <Notice kind="error" title="The project status could not be read.">
          {opened.error.message}
        </Notice>
      </>
    );
  }

  const status = opened.value;
  const index = status.index;

  return (
    <>
      <h1>{status.project.name}</h1>
      <p className="lede mono">{status.project.root}</p>

      {status.project.configIssues.length > 0 ? (
        <Notice title={`${status.project.configIssues.length} problem(s) in agent.config.json`}>
          <ul style={{ margin: '6px 0 0 18px', padding: 0 }}>
            {status.project.configIssues.map((issue) => (
              <li key={issue.path}>
                <code>{issue.path}</code>: {issue.message}
              </li>
            ))}
          </ul>
          Defaults are in use for anything invalid.
        </Notice>
      ) : null}

      <div className="grid">
        <Stat label="Files indexed" value={index ? String(index.files) : '—'} />
        <Stat label="Symbols" value={index ? String(index.symbols) : '—'} />
        <Stat label="APIs imported" value={String(status.apiCount)} />
        <Stat label="Plans built" value={String(status.planCount)} />
      </div>

      <h2>Index</h2>
      {index ? (
        <div className="panel">
          <p style={{ margin: 0 }}>
            <strong>{Math.round(index.resolutionRate * 100)}%</strong> of{' '}
            {index.references.toLocaleString()} references were attributed to a declaration in this
            workspace.
          </p>
          <p style={{ color: 'var(--muted)', margin: '8px 0 0' }}>
            The rest are not failures. A reference reached through a property access needs the
            receiver&rsquo;s type to resolve, and a global such as <code>fetch</code> has no
            declaration here at all — both are counted rather than guessed at, because attributing
            them by name would point at the wrong function.
          </p>
          {index.unresolvedImports > 0 ? (
            <p style={{ margin: '8px 0 0' }}>
              <span className="badge warn">{index.unresolvedImports} unresolved imports</span>{' '}
              <span style={{ color: 'var(--muted)' }}>
                — local imports whose target file was not found.
              </span>
            </p>
          ) : null}
          {index.skipped.length > 0 ? (
            <p style={{ margin: '8px 0 0' }}>
              <span className="badge warn">{index.skipped.length} files skipped</span>{' '}
              <span style={{ color: 'var(--muted)' }}>
                — too large, or unreadable. Anything in them is invisible to impact analysis.
              </span>
            </p>
          ) : null}
        </div>
      ) : (
        <div className="empty">
          This project has not been indexed yet, so nothing can be searched or planned against.
        </div>
      )}

      <h2>Connections</h2>
      <div className="panel">
        <p style={{ margin: 0 }}>
          Postman:{' '}
          {status.postmanReady ? (
            <span className="badge ok">connected</span>
          ) : (
            <span className="badge">not configured</span>
          )}
        </p>
        <p style={{ color: 'var(--muted)', margin: '8px 0 0' }}>
          A Postman key is stored in the editor&rsquo;s keychain and read by the server on demand.
          It is never held by this page.
        </p>
      </div>
    </>
  );
}
