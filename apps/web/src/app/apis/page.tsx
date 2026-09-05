import { Notice } from '@/components/Notice';
import { callAgent } from '@/lib/agent';
import { currentProject } from '@/lib/project';

export const dynamic = 'force-dynamic';

interface ApiSummary {
  apiId: string;
  name: string;
  version?: string;
  format: string;
  endpointCount: number;
  servers: string[];
  securitySchemes: string[];
}

interface EndpointSummary {
  id: string;
  apiId: string;
  method: string;
  path: string;
  summary?: string;
  tags: string[];
  requiresAuth: boolean;
  callSites: { file: string; line: number }[];
}

/**
 * The API catalog.
 *
 * The column that earns this page its place is "call sites": whether the
 * codebase already talks to an endpoint is the difference between a task and a
 * false start, and it is the one thing a specification viewer cannot tell you.
 */
export default async function ApiCatalogPage() {
  const lookup = await currentProject();

  if (lookup.state !== 'ok') {
    return (
      <>
        <h1>API catalog</h1>
        <Notice title="No project is open.">
          {lookup.state === 'unreachable'
            ? lookup.message
            : 'Open a folder in the VS Code extension and it will appear here.'}
        </Notice>
      </>
    );
  }

  const projectId = lookup.project.projectId;

  const [apis, endpoints] = await Promise.all([
    callAgent<{ apis: ApiSummary[] }>('api/list', { projectId }),
    callAgent<{ endpoints: EndpointSummary[] }>('api/endpoints', { projectId }),
  ]);

  if (!apis.ok) {
    return (
      <>
        <h1>API catalog</h1>
        <Notice kind="error" title="The catalog could not be loaded.">
          {apis.error.message}
        </Notice>
      </>
    );
  }

  if (apis.value.apis.length === 0) {
    return (
      <>
        <h1>API catalog</h1>
        <Notice title="No API has been imported yet.">
          Import an OpenAPI document, a Postman collection, or a cURL command from the editor.
        </Notice>
      </>
    );
  }

  const byApi = new Map<string, EndpointSummary[]>();
  for (const endpoint of endpoints.ok ? endpoints.value.endpoints : []) {
    const existing = byApi.get(endpoint.apiId);
    if (existing) existing.push(endpoint);
    else byApi.set(endpoint.apiId, [endpoint]);
  }

  return (
    <>
      <h1>API catalog</h1>
      <p className="lede">
        {apis.value.apis.length} specification(s). Call sites come from the code index, so an
        endpoint with none is one this codebase does not call — not one it cannot.
      </p>

      {apis.value.apis.map((api) => (
        <section key={api.apiId}>
          <h2>
            {api.name}
            {api.version ? (
              <span style={{ color: 'var(--muted)' }}> {api.version}</span>
            ) : null}{' '}
            <span className="badge">{api.format}</span>
          </h2>

          <div className="panel" style={{ marginBottom: 12 }}>
            <div className="mono" style={{ color: 'var(--muted)' }}>
              {api.servers.length > 0 ? api.servers.join('  ·  ') : 'No server URL documented'}
            </div>
            {api.securitySchemes.length > 0 ? (
              <div style={{ marginTop: 6 }}>
                Security schemes: <code>{api.securitySchemes.join(', ')}</code>
                <span style={{ color: 'var(--muted)' }}>
                  {' '}
                  — names only; no credential is stored or shown.
                </span>
              </div>
            ) : null}
          </div>

          <table>
            <thead>
              <tr>
                <th style={{ width: 70 }}>Method</th>
                <th>Path</th>
                <th style={{ width: 90 }}>Auth</th>
                <th style={{ width: 220 }}>Call sites</th>
              </tr>
            </thead>
            <tbody>
              {(byApi.get(api.apiId) ?? []).map((endpoint) => (
                <tr key={endpoint.id}>
                  <td className="method">{endpoint.method}</td>
                  <td>
                    <span className="mono">{endpoint.path}</span>
                    {endpoint.summary ? (
                      <div style={{ color: 'var(--muted)' }}>{endpoint.summary}</div>
                    ) : null}
                  </td>
                  <td>
                    {endpoint.requiresAuth ? (
                      <span className="badge warn">required</span>
                    ) : (
                      <span className="badge">none documented</span>
                    )}
                  </td>
                  <td>
                    {endpoint.callSites.length === 0 ? (
                      <span style={{ color: 'var(--muted)' }}>not called</span>
                    ) : (
                      endpoint.callSites.map((site) => (
                        <div key={`${site.file}:${site.line}`} className="mono">
                          {site.file}:{site.line}
                        </div>
                      ))
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ))}
    </>
  );
}
