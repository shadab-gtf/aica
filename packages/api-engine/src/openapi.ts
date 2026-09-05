/**
 * OpenAPI 3.x and Swagger 2.0 parser.
 *
 * The two formats differ enough to be irritating and overlap enough that one
 * parser is worth the branches: both describe the same endpoints, and a project
 * importing "an API" should not care which vintage the file is.
 *
 * Three rules shape the implementation:
 *
 * - **Pure.** No network, no filesystem. Remote `$ref`s are reported as gaps
 *   rather than fetched, because a parser that makes requests cannot be run
 *   safely against an untrusted document.
 * - **Total.** Only an unrecognizable document fails. Every other defect —
 *   a dangling reference, a missing schema, an unsupported keyword — becomes a
 *   `ParseWarning` attached to the result, so a partly-broken specification
 *   still yields the endpoints it does describe.
 * - **Honest.** Where the source says nothing, the IR says `unknown` with a
 *   reason. Nothing is inferred from a field name or a status code.
 */

import type {
  ApiResponse,
  ApiSpec,
  AuthScheme,
  Endpoint,
  HttpMethod,
  MediaTypeBody,
  ObjectProperty,
  OAuth2Flow,
  OAuth2Scope,
  Parameter,
  ParameterLocation,
  ParameterStyle,
  ParseWarning,
  RequestBody,
  ResponseHeader,
  SchemaNode,
  SecurityOption,
  Server,
  ServerVariable,
  SourceRef,
} from '@aica/api-ir';
import {
  HTTP_METHODS,
  ParseWarningCode,
  checkSpecInvariants,
  endpointId,
  normalizePath,
  slugify,
  toResponseStatus,
  unknownSchema,
  warn,
} from '@aica/api-ir';
import { AgentError, ErrorCode, err, ok } from '@aica/shared';
import type { Result } from '@aica/shared';

import type { JsonRecord } from './json.js';
import {
  asArray,
  asBoolean,
  asNumber,
  asRecord,
  asString,
  asStringArray,
  asText,
  compact,
  isRecord,
  pointer,
  refName,
  resolvePointer,
} from './json.js';

export interface ParseOptions {
  /** File path or URL the document came from, recorded as provenance. */
  readonly location?: string;
  /** Used when the document has no `info.title`. */
  readonly fallbackTitle?: string;
}

/** How deep a chain of inlined `$ref`s may go before the IR gives up. */
const MAX_SCHEMA_DEPTH = 24;

/**
 * Keywords every schema kind shares. Lifted once per node and merged in, rather
 * than typed as `Partial<SchemaNode>` — a partial of a discriminated union
 * widens `kind` back to the full set and defeats the discriminant.
 */
interface SchemaCommon {
  readonly description?: string;
  readonly nullable?: boolean;
  readonly deprecated?: boolean;
  readonly example?: unknown;
  readonly format?: string;
  readonly default?: unknown;
  readonly readOnly?: boolean;
  readonly writeOnly?: boolean;
}

/** Attach shared keywords to an already-built node, keeping its kind intact. */
function withCommon(node: SchemaNode, common: SchemaCommon): SchemaNode {
  return { ...node, ...common };
}

type Flavor = 'openapi3' | 'swagger2';

/** True when the document looks like something this parser can read. */
export function isOpenApiDocument(document: unknown): boolean {
  return detectFlavor(document) !== undefined;
}

function detectFlavor(document: unknown): Flavor | undefined {
  const root = asRecord(document);
  if (!root) return undefined;
  if (typeof root.openapi === 'string' && root.openapi.startsWith('3')) return 'openapi3';
  if (root.swagger === '2.0' || root.swagger === 2) return 'swagger2';
  return undefined;
}

export function parseOpenApi(document: unknown, options: ParseOptions = {}): Result<ApiSpec> {
  const flavor = detectFlavor(document);
  if (!flavor) {
    return err(
      new AgentError(
        ErrorCode.INVALID_INPUT,
        'Not an OpenAPI or Swagger document: expected a top-level "openapi": "3.x" or "swagger": "2.0" field',
        { details: { location: options.location } },
      ),
    );
  }

  return ok(new OpenApiParser(asRecord(document) as JsonRecord, flavor, options).parse());
}

class OpenApiParser {
  private readonly warnings: ParseWarning[] = [];
  /** Pointers currently being expanded, so a cycle is detected rather than hung. */
  private readonly expanding = new Set<string>();
  private readonly reportedCycles = new Set<string>();

  constructor(
    private readonly root: JsonRecord,
    private readonly flavor: Flavor,
    private readonly options: ParseOptions,
  ) {}

  parse(): ApiSpec {
    const info = asRecord(this.root.info) ?? {};
    const title = asText(info.title) ?? this.options.fallbackTitle ?? 'Untitled API';

    const authSchemes = this.parseAuthSchemes();
    const security = this.parseSecurity(this.root.security, '#/security');
    const servers = this.parseServers();
    const components = this.parseComponents();
    const endpoints = this.parsePaths();

    const spec: ApiSpec = compact({
      id: slugify(title),
      title,
      version: asText(info.version),
      description: asText(info.description),
      servers,
      endpoints,
      authSchemes,
      security,
      components,
      source: this.sourceRef(),
      warnings: this.warnings,
    });

    // Invariant violations are appended rather than thrown: a specification
    // that contradicts itself is a finding to report, not a file to reject.
    return { ...spec, warnings: [...this.warnings, ...checkSpecInvariants(spec)] };
  }

  private sourceRef(jsonPointer?: string): SourceRef {
    return compact({
      format: this.flavor,
      location: this.options.location,
      pointer: jsonPointer,
    });
  }

  private note(code: ParseWarning['code'], message: string, jsonPointer?: string): void {
    this.warnings.push(warn(code, message, jsonPointer));
  }

  // -------------------------------------------------------------------------
  // Servers
  // -------------------------------------------------------------------------

  private parseServers(): Server[] {
    if (this.flavor === 'swagger2') return this.parseSwagger2Servers();

    const declared = asArray(this.root.servers) ?? [];
    const servers = declared
      .map((entry, index) => this.parseServer(entry, pointer('servers', String(index))))
      .filter((server): server is Server => server !== undefined);

    // "If the servers property is not provided the default is a Server Object
    // with a url value of /" — OpenAPI 3.1 §4.8.1.
    return servers.length > 0 ? servers : [{ url: '/', variables: [] }];
  }

  private parseServer(entry: unknown, jsonPointer: string): Server | undefined {
    const record = asRecord(entry);
    const url = asText(record?.url);
    if (!record || !url) {
      this.note(ParseWarningCode.MALFORMED_ENTRY, 'Server entry has no url', jsonPointer);
      return undefined;
    }

    const variables = Object.entries(asRecord(record.variables) ?? {})
      .map(([name, value]): ServerVariable | undefined => {
        const variable = asRecord(value);
        const fallback = asString(variable?.default);
        if (fallback === undefined) {
          this.note(
            ParseWarningCode.MALFORMED_ENTRY,
            `Server variable "${name}" has no default`,
            jsonPointer,
          );
          return undefined;
        }
        const enumValues = asStringArray(variable?.enum);
        return compact({
          name,
          default: fallback,
          enum: enumValues.length > 0 ? enumValues : undefined,
          description: asText(variable?.description),
        });
      })
      .filter((variable): variable is ServerVariable => variable !== undefined);

    return compact({ url, description: asText(record.description), variables });
  }

  private parseSwagger2Servers(): Server[] {
    const host = asText(this.root.host);
    const basePath = asText(this.root.basePath) ?? '';
    const schemes = asStringArray(this.root.schemes);

    if (!host) {
      // Swagger 2.0 says the host defaults to the host serving the document,
      // which a parser cannot know. Record the base path and say so.
      return [{ url: basePath.length > 0 ? basePath : '/', variables: [] }];
    }

    const protocols = schemes.length > 0 ? schemes : ['https'];
    return protocols.map((scheme) => ({ url: `${scheme}://${host}${basePath}`, variables: [] }));
  }

  // -------------------------------------------------------------------------
  // Authentication
  // -------------------------------------------------------------------------

  private securitySchemeSource(): JsonRecord {
    if (this.flavor === 'swagger2') return asRecord(this.root.securityDefinitions) ?? {};
    return asRecord(asRecord(this.root.components)?.securitySchemes) ?? {};
  }

  private parseAuthSchemes(): AuthScheme[] {
    const base =
      this.flavor === 'swagger2' ? ['securityDefinitions'] : ['components', 'securitySchemes'];

    return Object.entries(this.securitySchemeSource())
      .map(([id, value]) => this.parseAuthScheme(id, value, pointer(...base, id)))
      .filter((scheme): scheme is AuthScheme => scheme !== undefined);
  }

  private parseAuthScheme(id: string, value: unknown, jsonPointer: string): AuthScheme | undefined {
    const record = asRecord(this.deref(value, jsonPointer));
    if (!record) {
      this.note(
        ParseWarningCode.MALFORMED_ENTRY,
        `Security scheme "${id}" is not an object`,
        jsonPointer,
      );
      return undefined;
    }

    const description = asText(record.description);
    const type = asString(record.type)?.toLowerCase();

    switch (type) {
      case 'apikey':
        return this.parseApiKeyScheme(id, record, description, jsonPointer);
      case 'http':
        return this.parseHttpScheme(id, record, description, jsonPointer);
      case 'basic':
        // Swagger 2.0 spelled HTTP basic as its own type.
        return compact({ id, kind: 'basic' as const, description });
      case 'oauth2':
        return this.parseOAuth2Scheme(id, record, description, jsonPointer);
      case 'openidconnect':
        return this.parseOpenIdConnectScheme(id, record, description, jsonPointer);
      case 'mutualtls':
        this.note(
          ParseWarningCode.UNSUPPORTED_FEATURE,
          `Security scheme "${id}" uses mutual TLS, which needs a client certificate rather than a credential`,
          jsonPointer,
        );
        return compact({
          id,
          kind: 'custom' as const,
          description,
          headerNames: [],
          instructions: 'Requires a client TLS certificate configured on the HTTP agent',
        });
      default:
        this.note(
          ParseWarningCode.UNKNOWN_AUTH,
          `Security scheme "${id}" has unrecognized type ${JSON.stringify(record.type)}`,
          jsonPointer,
        );
        return compact({
          id,
          kind: 'unknown' as const,
          description,
          rawDescription: description,
        });
    }
  }

  private parseApiKeyScheme(
    id: string,
    record: JsonRecord,
    description: string | undefined,
    jsonPointer: string,
  ): AuthScheme {
    const location = asString(record.in)?.toLowerCase();
    const name = asText(record.name);

    if (!name) {
      this.note(
        ParseWarningCode.MALFORMED_ENTRY,
        `API key scheme "${id}" does not name the header or parameter carrying the key`,
        jsonPointer,
      );
      return compact({ id, kind: 'unknown' as const, description, rawDescription: description });
    }

    if (location === 'cookie') {
      return compact({ id, kind: 'cookie' as const, description, name });
    }

    const resolved: ParameterLocation = location === 'query' ? 'query' : 'header';
    if (location !== 'query' && location !== 'header') {
      this.note(
        ParseWarningCode.MALFORMED_ENTRY,
        `API key scheme "${id}" has in=${JSON.stringify(record.in)}; assuming header`,
        jsonPointer,
      );
    }

    return compact({ id, kind: 'apiKey' as const, description, in: resolved, name });
  }

  private parseHttpScheme(
    id: string,
    record: JsonRecord,
    description: string | undefined,
    jsonPointer: string,
  ): AuthScheme {
    const scheme = asString(record.scheme)?.toLowerCase();
    const bearerFormat = asText(record.bearerFormat);

    if (scheme === 'basic') return compact({ id, kind: 'basic' as const, description });

    if (scheme === 'bearer') {
      // A bearer token declared as a JWT is worth distinguishing: it can be
      // decoded, so expiry and scopes are inspectable without a request.
      const kind = bearerFormat?.toUpperCase() === 'JWT' ? ('jwt' as const) : ('bearer' as const);
      return compact({ id, kind, description, bearerFormat });
    }

    this.note(
      ParseWarningCode.UNKNOWN_AUTH,
      `HTTP security scheme "${id}" uses the "${scheme ?? 'unspecified'}" scheme, which has no first-class representation`,
      jsonPointer,
    );
    return compact({
      id,
      kind: 'custom' as const,
      description,
      headerNames: ['Authorization'],
      instructions: scheme ? `Authorization: ${scheme} <credential>` : undefined,
    });
  }

  private parseOAuth2Scheme(
    id: string,
    record: JsonRecord,
    description: string | undefined,
    jsonPointer: string,
  ): AuthScheme {
    const flows =
      this.flavor === 'swagger2' ? this.swagger2Flows(record) : (asRecord(record.flows) ?? {});
    const entries = Object.entries(flows);

    if (entries.length === 0) {
      this.note(
        ParseWarningCode.MALFORMED_ENTRY,
        `OAuth2 scheme "${id}" declares no flows`,
        jsonPointer,
      );
      return compact({
        id,
        kind: 'oauth2' as const,
        description,
        flow: 'authorizationCode' as OAuth2Flow,
        scopes: [],
      });
    }

    if (entries.length > 1) {
      this.note(
        ParseWarningCode.UNSUPPORTED_FEATURE,
        `OAuth2 scheme "${id}" declares ${entries.length} flows; using "${entries[0]?.[0] ?? ''}"`,
        jsonPointer,
      );
    }

    const [flowName, flowValue] = entries[0] as [string, unknown];
    const flowRecord = asRecord(flowValue) ?? {};
    const scopes: OAuth2Scope[] = Object.entries(asRecord(flowRecord.scopes) ?? {}).map(
      ([name, value]) => compact({ name, description: asText(value) }),
    );

    return compact({
      id,
      kind: 'oauth2' as const,
      description,
      flow: toOAuth2Flow(flowName),
      authorizationUrl: asText(flowRecord.authorizationUrl),
      tokenUrl: asText(flowRecord.tokenUrl),
      refreshUrl: asText(flowRecord.refreshUrl),
      scopes,
    });
  }

  /** Reshape Swagger 2.0's flat OAuth2 fields into the 3.x `flows` map. */
  private swagger2Flows(record: JsonRecord): JsonRecord {
    const flow = asString(record.flow) ?? 'implicit';
    return {
      [flow]: {
        authorizationUrl: record.authorizationUrl,
        tokenUrl: record.tokenUrl,
        scopes: record.scopes,
      },
    };
  }

  private parseOpenIdConnectScheme(
    id: string,
    record: JsonRecord,
    description: string | undefined,
    jsonPointer: string,
  ): AuthScheme {
    const discoveryUrl = asText(record.openIdConnectUrl);
    // The flow and its endpoints live behind a discovery document this parser
    // will not fetch, so they are recorded as unknown rather than assumed.
    this.note(
      ParseWarningCode.UNSUPPORTED_FEATURE,
      `Security scheme "${id}" is OpenID Connect; its endpoints come from ${discoveryUrl ?? 'a discovery document'}, which is not fetched during parsing`,
      jsonPointer,
    );
    return compact({
      id,
      kind: 'oauth2' as const,
      description:
        description ?? (discoveryUrl ? `OpenID Connect discovery: ${discoveryUrl}` : undefined),
      flow: 'authorizationCode' as OAuth2Flow,
      scopes: [],
      pkce: true,
    });
  }

  /**
   * A security list is alternatives; each entry ANDs its schemes. Both levels
   * are preserved — see `SecurityOption`.
   *
   * The empty case carries meaning and the two empties are not the same. An
   * *absent* `security` key means "inherit whatever the specification says",
   * and is represented as no options at all. A *present but empty* list —
   * `security: []` — is the document explicitly saying this endpoint needs no
   * authentication, which OpenAPI's own wording makes an override rather than a
   * silence, and is represented as one option requiring nothing.
   *
   * Collapsing them was a real defect: an endpoint the author had deliberately
   * marked public inherited the global bearer requirement, so the catalog
   * showed a lock on it and a generated client would have attached a token to a
   * request that must not carry one.
   */
  private parseSecurity(value: unknown, jsonPointer: string): SecurityOption[] {
    const alternatives = asArray(value);
    if (!alternatives) return [];
    if (alternatives.length === 0) return [[]];

    return alternatives.map((alternative, index): SecurityOption => {
      const record = asRecord(alternative);
      if (!record) {
        this.note(
          ParseWarningCode.MALFORMED_ENTRY,
          'Security entry is not an object',
          `${jsonPointer}/${index}`,
        );
        return [];
      }
      return Object.entries(record).map(([schemeId, scopes]) => ({
        schemeId,
        scopes: asStringArray(scopes),
      }));
    });
  }

  // -------------------------------------------------------------------------
  // Components
  // -------------------------------------------------------------------------

  private componentSchemaSource(): JsonRecord {
    if (this.flavor === 'swagger2') return asRecord(this.root.definitions) ?? {};
    return asRecord(asRecord(this.root.components)?.schemas) ?? {};
  }

  private parseComponents(): Record<string, SchemaNode> {
    const base = this.flavor === 'swagger2' ? ['definitions'] : ['components', 'schemas'];
    const components: Record<string, SchemaNode> = {};

    for (const [name, value] of Object.entries(this.componentSchemaSource())) {
      const jsonPointer = pointer(...base, name);
      // Seed the cycle guard with this component's own pointer so a
      // self-referential type resolves to a named ref instead of recursing.
      this.expanding.add(jsonPointer);
      components[name] = this.toSchema(value, jsonPointer, 0);
      this.expanding.delete(jsonPointer);
    }

    return components;
  }

  // -------------------------------------------------------------------------
  // Paths and operations
  // -------------------------------------------------------------------------

  private parsePaths(): Endpoint[] {
    const paths = asRecord(this.root.paths);
    if (!paths) {
      this.note(ParseWarningCode.MALFORMED_ENTRY, 'Document declares no paths');
      return [];
    }

    const endpoints: Endpoint[] = [];

    for (const [rawPath, pathValue] of Object.entries(paths)) {
      if (rawPath.startsWith('x-')) continue;

      const pathPointer = pointer('paths', rawPath);
      const pathItem = asRecord(this.deref(pathValue, pathPointer));
      if (!pathItem) {
        this.note(
          ParseWarningCode.MALFORMED_ENTRY,
          `Path "${rawPath}" is not an object`,
          pathPointer,
        );
        continue;
      }

      const path = normalizePath(rawPath);
      const sharedParameters = this.parseParameters(
        pathItem.parameters,
        `${pathPointer}/parameters`,
      );
      const pathServers =
        this.flavor === 'openapi3' ? this.parseOperationServers(pathItem, pathPointer) : [];

      for (const method of HTTP_METHODS) {
        const operationValue = pathItem[method.toLowerCase()];
        if (operationValue === undefined) continue;

        const operationPointer = pointer('paths', rawPath, method.toLowerCase());
        const operation = asRecord(operationValue);
        if (!operation) {
          this.note(
            ParseWarningCode.MALFORMED_ENTRY,
            `Operation ${method} ${path} is not an object`,
            operationPointer,
          );
          continue;
        }

        endpoints.push(
          this.parseOperation(
            method,
            path,
            operation,
            operationPointer,
            sharedParameters,
            pathServers,
          ),
        );
      }
    }

    return endpoints;
  }

  private parseOperationServers(record: JsonRecord, jsonPointer: string): Server[] {
    const declared = asArray(record.servers);
    if (!declared) return [];
    return declared
      .map((entry, index) => this.parseServer(entry, `${jsonPointer}/servers/${index}`))
      .filter((server): server is Server => server !== undefined);
  }

  private parseOperation(
    method: HttpMethod,
    path: string,
    operation: JsonRecord,
    jsonPointer: string,
    sharedParameters: readonly Parameter[],
    pathServers: readonly Server[],
  ): Endpoint {
    const own = this.parseParameters(operation.parameters, `${jsonPointer}/parameters`);
    const parameters = mergeParameters(sharedParameters, own);

    const requestBody =
      this.flavor === 'swagger2'
        ? this.swagger2RequestBody(operation, jsonPointer)
        : this.parseRequestBody(operation.requestBody, `${jsonPointer}/requestBody`);

    const operationServers = this.parseOperationServers(operation, jsonPointer);

    return compact({
      id: endpointId(method, path),
      method,
      path,
      operationId: asText(operation.operationId),
      summary: asText(operation.summary),
      description: asText(operation.description),
      tags: asStringArray(operation.tags),
      parameters,
      requestBody,
      responses: this.parseResponses(operation, jsonPointer),
      security: this.parseSecurity(operation.security, `${jsonPointer}/security`),
      deprecated: asBoolean(operation.deprecated) === true ? true : undefined,
      servers: operationServers.length > 0 ? operationServers : pathServers,
      source: this.sourceRef(jsonPointer),
    });
  }

  // -------------------------------------------------------------------------
  // Parameters
  // -------------------------------------------------------------------------

  private parseParameters(value: unknown, jsonPointer: string): Parameter[] {
    const entries = asArray(value);
    if (!entries) return [];

    const parameters: Parameter[] = [];

    for (const [index, entry] of entries.entries()) {
      const entryPointer = `${jsonPointer}/${index}`;
      const record = asRecord(this.deref(entry, entryPointer));
      if (!record) {
        this.note(ParseWarningCode.MALFORMED_ENTRY, 'Parameter is not an object', entryPointer);
        continue;
      }

      const location = asString(record.in)?.toLowerCase();
      // Swagger 2.0 body and formData parameters describe a request body, not a
      // parameter; they are lifted in `swagger2RequestBody`.
      if (location === 'body' || location === 'formdata') continue;

      const parameter = this.parseParameter(record, entryPointer);
      if (parameter) parameters.push(parameter);
    }

    return parameters;
  }

  private parseParameter(record: JsonRecord, jsonPointer: string): Parameter | undefined {
    const name = asText(record.name);
    const rawLocation = asString(record.in)?.toLowerCase();

    if (!name || !rawLocation) {
      this.note(
        ParseWarningCode.MALFORMED_ENTRY,
        'Parameter is missing "name" or "in"',
        jsonPointer,
      );
      return undefined;
    }

    if (!isParameterLocation(rawLocation)) {
      this.note(
        ParseWarningCode.UNSUPPORTED_FEATURE,
        `Parameter "${name}" has unsupported location "${rawLocation}"`,
        jsonPointer,
      );
      return undefined;
    }

    return compact({
      name,
      in: rawLocation,
      // A path parameter is required by definition; sources that omit the flag
      // are corrected rather than trusted.
      required: rawLocation === 'path' ? true : asBoolean(record.required) === true,
      schema: this.parameterSchema(record, name, jsonPointer),
      description: asText(record.description),
      deprecated: asBoolean(record.deprecated) === true ? true : undefined,
      style: this.parameterStyle(record, rawLocation),
      explode: asBoolean(record.explode),
      example: record.example,
    });
  }

  private parameterSchema(record: JsonRecord, name: string, jsonPointer: string): SchemaNode {
    if (this.flavor === 'swagger2') {
      // Swagger 2.0 inlines the type keywords directly on the parameter.
      return this.toSchema(record, `${jsonPointer}/schema`, 0);
    }

    if (record.schema !== undefined)
      return this.toSchema(record.schema, `${jsonPointer}/schema`, 0);

    // A parameter may instead carry a `content` map for complex serialization.
    const content = asRecord(record.content);
    const first = content ? Object.entries(content)[0] : undefined;
    if (first) {
      return this.toSchema(
        asRecord(first[1])?.schema,
        `${jsonPointer}/content/${first[0]}/schema`,
        0,
      );
    }

    this.note(
      ParseWarningCode.MISSING_SCHEMA,
      `Parameter "${name}" declares no schema`,
      jsonPointer,
    );
    return unknownSchema('parameter has no schema in the specification');
  }

  private parameterStyle(
    record: JsonRecord,
    location: ParameterLocation,
  ): ParameterStyle | undefined {
    const style = asString(record.style);
    if (style && isParameterStyle(style)) return style;

    if (this.flavor === 'swagger2') {
      // Swagger 2.0's collectionFormat is the same concept under another name.
      switch (asString(record.collectionFormat)) {
        case 'ssv':
          return 'spaceDelimited';
        case 'pipes':
          return 'pipeDelimited';
        case 'csv':
          return location === 'query' || location === 'cookie' ? 'form' : 'simple';
        default:
          return undefined;
      }
    }

    return undefined;
  }

  // -------------------------------------------------------------------------
  // Request bodies
  // -------------------------------------------------------------------------

  private parseRequestBody(value: unknown, jsonPointer: string): RequestBody | undefined {
    if (value === undefined) return undefined;

    const record = asRecord(this.deref(value, jsonPointer));
    if (!record) {
      this.note(ParseWarningCode.MALFORMED_ENTRY, 'Request body is not an object', jsonPointer);
      return undefined;
    }

    const content = this.parseContent(record.content, `${jsonPointer}/content`);
    if (content.length === 0) {
      this.note(
        ParseWarningCode.MISSING_SCHEMA,
        'Request body declares no media type',
        jsonPointer,
      );
    }

    return compact({
      required: asBoolean(record.required) === true,
      content,
      description: asText(record.description),
    });
  }

  /** Lift Swagger 2.0's `body` / `formData` parameters into a request body. */
  private swagger2RequestBody(operation: JsonRecord, jsonPointer: string): RequestBody | undefined {
    const entries = asArray(operation.parameters) ?? [];
    const consumes = asStringArray(operation.consumes ?? this.root.consumes);

    const parameters = entries
      .map((entry, index) => ({ record: asRecord(this.deref(entry, jsonPointer)), index }))
      .filter(
        (entry): entry is { record: JsonRecord; index: number } => entry.record !== undefined,
      );

    const body = parameters.find(({ record }) => asString(record.in) === 'body');
    if (body) {
      const mediaTypes = consumes.length > 0 ? consumes : ['application/json'];
      const schema = this.toSchema(
        body.record.schema,
        `${jsonPointer}/parameters/${body.index}/schema`,
        0,
      );
      return compact({
        required: asBoolean(body.record.required) === true,
        description: asText(body.record.description),
        content: mediaTypes.map((mediaType) => ({
          mediaType: normalizeMediaType(mediaType),
          schema,
        })),
      });
    }

    const formFields = parameters.filter(({ record }) => asString(record.in) === 'formData');
    if (formFields.length === 0) return undefined;

    // Form fields are individually declared parameters; together they describe
    // one object-shaped body.
    const properties: ObjectProperty[] = formFields.map(({ record, index }) => ({
      name: asText(record.name) ?? `field${index}`,
      required: asBoolean(record.required) === true,
      schema: this.toSchema(record, `${jsonPointer}/parameters/${index}`, 0),
    }));

    const mediaTypes =
      consumes.length > 0
        ? consumes
        : formFields.some(({ record }) => asString(record.type) === 'file')
          ? ['multipart/form-data']
          : ['application/x-www-form-urlencoded'];

    return {
      required: properties.some((property) => property.required),
      content: mediaTypes.map((mediaType) => ({
        mediaType: normalizeMediaType(mediaType),
        schema: { kind: 'object' as const, properties },
      })),
    };
  }

  private parseContent(value: unknown, jsonPointer: string): MediaTypeBody[] {
    const content = asRecord(value);
    if (!content) return [];

    return Object.entries(content).map(([mediaType, entry]) => {
      const record = asRecord(entry) ?? {};
      const entryPointer = `${jsonPointer}/${mediaType.replace(/\//g, '~1')}`;
      return compact({
        mediaType: normalizeMediaType(mediaType),
        schema:
          record.schema === undefined
            ? unknownSchema(`no schema declared for ${mediaType}`)
            : this.toSchema(record.schema, `${entryPointer}/schema`, 0),
        example: record.example ?? firstExample(record.examples),
      });
    });
  }

  // -------------------------------------------------------------------------
  // Responses
  // -------------------------------------------------------------------------

  private parseResponses(operation: JsonRecord, jsonPointer: string): ApiResponse[] {
    const responses = asRecord(operation.responses);
    if (!responses) {
      this.note(ParseWarningCode.MISSING_SCHEMA, 'Operation declares no responses', jsonPointer);
      return [];
    }

    const produces = asStringArray(operation.produces ?? this.root.produces);
    const parsed: ApiResponse[] = [];

    for (const [key, value] of Object.entries(responses)) {
      if (key.startsWith('x-')) continue;

      const responsePointer = `${jsonPointer}/responses/${key}`;
      const status = toResponseStatus(key);
      if (status === undefined) {
        this.note(
          ParseWarningCode.MALFORMED_ENTRY,
          `Response key "${key}" is neither a status code, a range, nor "default"`,
          responsePointer,
        );
        continue;
      }

      const record = asRecord(this.deref(value, responsePointer));
      if (!record) {
        this.note(
          ParseWarningCode.MALFORMED_ENTRY,
          `Response ${key} is not an object`,
          responsePointer,
        );
        continue;
      }

      parsed.push(
        compact({
          status,
          description: asText(record.description),
          content:
            this.flavor === 'swagger2'
              ? this.swagger2ResponseContent(record, produces, responsePointer)
              : this.parseContent(record.content, `${responsePointer}/content`),
          headers: this.parseResponseHeaders(record.headers, `${responsePointer}/headers`),
        }),
      );
    }

    return parsed;
  }

  private swagger2ResponseContent(
    record: JsonRecord,
    produces: readonly string[],
    jsonPointer: string,
  ): MediaTypeBody[] {
    if (record.schema === undefined) return [];

    const schema = this.toSchema(record.schema, `${jsonPointer}/schema`, 0);
    const mediaTypes = produces.length > 0 ? produces : ['application/json'];
    const example = firstExample(record.examples);

    return mediaTypes.map((mediaType) =>
      compact({ mediaType: normalizeMediaType(mediaType), schema, example }),
    );
  }

  private parseResponseHeaders(value: unknown, jsonPointer: string): ResponseHeader[] {
    const headers = asRecord(value);
    if (!headers) return [];

    return Object.entries(headers).map(([name, entry]) => {
      const record = asRecord(this.deref(entry, jsonPointer)) ?? {};
      const headerPointer = `${jsonPointer}/${name}`;
      // 3.x nests the shape under `schema`; 2.0 inlines the type keywords.
      const source = record.schema !== undefined ? record.schema : record;
      return compact({
        name,
        schema: this.toSchema(source, headerPointer, 0),
        description: asText(record.description),
      });
    });
  }

  // -------------------------------------------------------------------------
  // Schemas
  // -------------------------------------------------------------------------

  /**
   * Lower a JSON-Schema-shaped value into the IR, inlining local references.
   *
   * References are inlined rather than kept symbolic so that every consumer —
   * path resolution, contract comparison, type rendering — sees one complete
   * shape. Cycles and excessive depth terminate as a named `ref` node, which
   * keeps the type nameable without recursing forever.
   */
  private toSchema(value: unknown, jsonPointer: string, depth: number): SchemaNode {
    if (value === undefined || value === null) {
      return unknownSchema('no schema in the specification');
    }

    // JSON Schema allows a bare boolean: `true` accepts anything, `false`
    // accepts nothing.
    if (value === true) return unknownSchema('schema is `true`, which accepts any value');
    if (value === false) return unknownSchema('schema is `false`, which accepts no value');

    const record = asRecord(value);
    if (!record) {
      this.note(ParseWarningCode.MALFORMED_ENTRY, 'Schema is not an object', jsonPointer);
      return unknownSchema('schema is not an object');
    }

    if (depth > MAX_SCHEMA_DEPTH) {
      this.note(
        ParseWarningCode.UNSUPPORTED_FEATURE,
        `Schema nesting exceeded ${MAX_SCHEMA_DEPTH} levels and was truncated`,
        jsonPointer,
      );
      return unknownSchema(`nesting deeper than ${MAX_SCHEMA_DEPTH} levels`);
    }

    const ref = asString(record.$ref);
    if (ref !== undefined) return this.expandRef(ref, record, jsonPointer, depth);

    return this.buildSchema(record, jsonPointer, depth);
  }

  private expandRef(
    ref: string,
    record: JsonRecord,
    jsonPointer: string,
    depth: number,
  ): SchemaNode {
    const name = refName(ref);

    if (!ref.startsWith('#')) {
      this.note(
        ParseWarningCode.UNRESOLVED_REF,
        `Reference "${ref}" points outside this document; external references are not fetched during parsing`,
        jsonPointer,
      );
      return compact({ kind: 'ref' as const, ref, name, description: asText(record.description) });
    }

    if (this.expanding.has(ref)) {
      if (!this.reportedCycles.has(ref)) {
        this.reportedCycles.add(ref);
        this.note(
          ParseWarningCode.CIRCULAR_REF,
          `Type "${name}" is recursive; the cycle is represented as a named reference`,
          jsonPointer,
        );
      }
      return compact({
        kind: 'ref' as const,
        ref,
        name,
        circular: true,
        description: asText(record.description),
      });
    }

    const target = resolvePointer(this.root, ref);
    if (target === undefined) {
      this.note(
        ParseWarningCode.UNRESOLVED_REF,
        `Reference "${ref}" does not resolve within this document`,
        jsonPointer,
      );
      return compact({ kind: 'ref' as const, ref, name, description: asText(record.description) });
    }

    this.expanding.add(ref);
    const resolved = this.toSchema(target, ref, depth + 1);
    this.expanding.delete(ref);

    // A sibling `description` next to `$ref` is the local override, and 3.1
    // makes that explicit; preserve it over the target's own text.
    const description = asText(record.description);
    return description ? { ...resolved, description } : resolved;
  }

  private buildSchema(record: JsonRecord, jsonPointer: string, depth: number): SchemaNode {
    const base = compact({
      description: asText(record.description),
      nullable: this.isNullable(record) ? true : undefined,
      deprecated: asBoolean(record.deprecated) === true ? true : undefined,
      example: record.example ?? firstExample(record.examples),
      format: asText(record.format),
      default: record.default,
      readOnly: asBoolean(record.readOnly) === true ? true : undefined,
      writeOnly: asBoolean(record.writeOnly) === true ? true : undefined,
    });

    const composed = this.composedSchema(record, base, jsonPointer, depth);
    if (composed) return composed;

    // 3.1 `const` is a one-value enumeration; treating it as such keeps a
    // single code path for exact-value matching.
    if (record.const !== undefined && isEnumValue(record.const)) {
      return { ...base, kind: 'enum', values: [record.const] };
    }

    const enumValues = asArray(record.enum);
    if (enumValues) {
      const values = enumValues.filter(isEnumValue);
      if (values.length !== enumValues.length) {
        this.note(
          ParseWarningCode.UNSUPPORTED_FEATURE,
          'Enumeration contains non-primitive values, which were dropped',
          jsonPointer,
        );
      }
      return compact({ ...base, kind: 'enum' as const, values, base: this.enumBase(record) });
    }

    return this.typedSchema(record, base, jsonPointer, depth);
  }

  /** `allOf` / `oneOf` / `anyOf`, which take precedence over `type`. */
  private composedSchema(
    record: JsonRecord,
    base: SchemaCommon,
    jsonPointer: string,
    depth: number,
  ): SchemaNode | undefined {
    const allOf = asArray(record.allOf);
    if (allOf && allOf.length > 0) {
      const parts = allOf.map((entry, index) =>
        this.toSchema(entry, `${jsonPointer}/allOf/${index}`, depth + 1),
      );
      // A single-element allOf is just the element, commonly used to attach a
      // description to a $ref; collapsing it avoids a pointless wrapper.
      return parts.length === 1
        ? withCommon(parts[0] as SchemaNode, base)
        : { ...base, kind: 'intersection', parts };
    }

    const oneOf = asArray(record.oneOf);
    const anyOf = asArray(record.anyOf);
    const options = oneOf ?? anyOf;
    if (options && options.length > 0) {
      const keyword = oneOf ? 'oneOf' : 'anyOf';
      const parsed = options.map((entry, index) =>
        this.toSchema(entry, `${jsonPointer}/${keyword}/${index}`, depth + 1),
      );
      const discriminator = asText(asRecord(record.discriminator)?.propertyName);
      return parsed.length === 1
        ? withCommon(parsed[0] as SchemaNode, base)
        : compact({ ...base, kind: 'union' as const, options: parsed, discriminator });
    }

    if (record.not !== undefined) {
      this.note(
        ParseWarningCode.UNSUPPORTED_FEATURE,
        '"not" has no representation in the IR and was dropped',
        jsonPointer,
      );
    }

    return undefined;
  }

  private typedSchema(
    record: JsonRecord,
    base: SchemaCommon,
    jsonPointer: string,
    depth: number,
  ): SchemaNode {
    const type = this.resolveType(record, jsonPointer);

    switch (type) {
      case 'string':
        return compact({
          ...base,
          kind: 'string' as const,
          minLength: asNumber(record.minLength),
          maxLength: asNumber(record.maxLength),
          pattern: asText(record.pattern),
        });

      case 'number':
      case 'integer':
        return compact({
          ...base,
          kind: type,
          minimum: asNumber(record.minimum),
          maximum: asNumber(record.maximum),
          exclusiveMinimum: asNumber(record.exclusiveMinimum),
          exclusiveMaximum: asNumber(record.exclusiveMaximum),
          multipleOf: asNumber(record.multipleOf),
        });

      case 'boolean':
        return { ...base, kind: 'boolean' };

      case 'null':
        return { ...base, kind: 'null' };

      case 'array':
        return compact({
          ...base,
          kind: 'array' as const,
          items: this.arrayItems(record, jsonPointer, depth),
          minItems: asNumber(record.minItems),
          maxItems: asNumber(record.maxItems),
          uniqueItems: asBoolean(record.uniqueItems),
        });

      case 'object':
        return this.objectSchema(record, base, jsonPointer, depth);

      default:
        // No `type`, but `properties` is decisive about what this is.
        if (
          asRecord(record.properties) !== undefined ||
          record.additionalProperties !== undefined
        ) {
          return this.objectSchema(record, base, jsonPointer, depth);
        }
        if (record.items !== undefined) {
          return {
            ...base,
            kind: 'array',
            items: this.arrayItems(record, jsonPointer, depth),
          };
        }
        return { ...base, kind: 'unknown', reason: 'specification declares no type' };
    }
  }

  private arrayItems(record: JsonRecord, jsonPointer: string, depth: number): SchemaNode {
    if (record.items !== undefined) {
      return this.toSchema(record.items, `${jsonPointer}/items`, depth + 1);
    }

    // 3.1 tuples: positional schemas rather than one element type.
    const prefixItems = asArray(record.prefixItems);
    if (prefixItems && prefixItems.length > 0) {
      this.note(
        ParseWarningCode.UNSUPPORTED_FEATURE,
        'Tuple validation ("prefixItems") is represented as an array of the union of its positions',
        jsonPointer,
      );
      const options = prefixItems.map((entry, index) =>
        this.toSchema(entry, `${jsonPointer}/prefixItems/${index}`, depth + 1),
      );
      return options.length === 1 ? (options[0] as SchemaNode) : { kind: 'union', options };
    }

    this.note(ParseWarningCode.MISSING_SCHEMA, 'Array does not say what it contains', jsonPointer);
    return unknownSchema('array element type is unspecified');
  }

  private objectSchema(
    record: JsonRecord,
    base: SchemaCommon,
    jsonPointer: string,
    depth: number,
  ): SchemaNode {
    const required = new Set(asStringArray(record.required));
    const properties: ObjectProperty[] = Object.entries(asRecord(record.properties) ?? {}).map(
      ([name, value]) => ({
        name,
        required: required.has(name),
        schema: this.toSchema(
          value,
          `${jsonPointer}/properties/${name.replace(/\//g, '~1')}`,
          depth + 1,
        ),
      }),
    );

    for (const name of required) {
      if (!properties.some((property) => property.name === name)) {
        this.note(
          ParseWarningCode.MALFORMED_ENTRY,
          `Property "${name}" is required but never declared`,
          jsonPointer,
        );
      }
    }

    return compact({
      ...base,
      kind: 'object' as const,
      properties,
      additionalProperties: this.additionalProperties(record, jsonPointer, depth),
      title: asText(record.title),
    });
  }

  private additionalProperties(
    record: JsonRecord,
    jsonPointer: string,
    depth: number,
  ): SchemaNode | false | undefined {
    const value = record.additionalProperties;
    if (value === undefined) return undefined;
    if (value === false) return false;
    if (value === true) return unknownSchema('additional properties are allowed but unconstrained');
    return this.toSchema(value, `${jsonPointer}/additionalProperties`, depth + 1);
  }

  /** OpenAPI 3.0 says `nullable: true`; 3.1 puts `"null"` in the type list. */
  private isNullable(record: JsonRecord): boolean {
    if (asBoolean(record.nullable) === true) return true;
    if (asBoolean(record['x-nullable']) === true) return true;
    const types = asArray(record.type);
    return types !== undefined && types.includes('null');
  }

  private resolveType(record: JsonRecord, jsonPointer: string): string | undefined {
    const single = asString(record.type);
    if (single !== undefined) return single;

    const types = asArray(record.type);
    if (!types) return undefined;

    // 3.1 type arrays: `null` is already captured as nullability, so the
    // remaining entry is the real type. Several remaining entries are a union
    // the IR expresses through `union`, not through a multi-typed node.
    const concrete = types.filter(
      (entry): entry is string => typeof entry === 'string' && entry !== 'null',
    );
    if (concrete.length <= 1) return concrete[0];

    this.note(
      ParseWarningCode.UNSUPPORTED_FEATURE,
      `Multi-typed schema [${concrete.join(', ')}] was narrowed to "${concrete[0] as string}"`,
      jsonPointer,
    );
    return concrete[0];
  }

  private enumBase(record: JsonRecord): 'string' | 'number' | 'integer' | 'boolean' | undefined {
    const type = asString(record.type);
    return type === 'string' || type === 'number' || type === 'integer' || type === 'boolean'
      ? type
      : undefined;
  }

  /** Resolve a `$ref` wrapper around a non-schema object (parameter, response). */
  private deref(value: unknown, jsonPointer: string): unknown {
    if (!isRecord(value)) return value;
    const ref = asString(value.$ref);
    if (ref === undefined) return value;

    const target = resolvePointer(this.root, ref);
    if (target === undefined) {
      this.note(
        ParseWarningCode.UNRESOLVED_REF,
        `Reference "${ref}" does not resolve within this document`,
        jsonPointer,
      );
      return undefined;
    }
    return target;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Operation parameters override path-level ones with the same name and
 * location, per OpenAPI 3.1 §4.8.9.
 */
function mergeParameters(shared: readonly Parameter[], own: readonly Parameter[]): Parameter[] {
  const merged = new Map<string, Parameter>();
  for (const parameter of [...shared, ...own]) {
    merged.set(`${parameter.in}:${parameter.name}`, parameter);
  }
  return [...merged.values()];
}

function isParameterLocation(value: string): value is ParameterLocation {
  return value === 'path' || value === 'query' || value === 'header' || value === 'cookie';
}

const PARAMETER_STYLES: readonly string[] = [
  'simple',
  'form',
  'label',
  'matrix',
  'spaceDelimited',
  'pipeDelimited',
  'deepObject',
];

function isParameterStyle(value: string): value is ParameterStyle {
  return PARAMETER_STYLES.includes(value);
}

function toOAuth2Flow(name: string): OAuth2Flow {
  switch (name) {
    case 'implicit':
      return 'implicit';
    case 'password':
      return 'password';
    // Swagger 2.0 called these "application" and "accessCode".
    case 'application':
    case 'clientCredentials':
      return 'clientCredentials';
    case 'accessCode':
    case 'authorizationCode':
      return 'authorizationCode';
    case 'deviceCode':
      return 'deviceCode';
    default:
      return 'authorizationCode';
  }
}

function isEnumValue(value: unknown): value is string | number | boolean | null {
  return (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  );
}

/** `application/json; charset=utf-8` and `Application/JSON` are one media type. */
function normalizeMediaType(mediaType: string): string {
  return (mediaType.split(';')[0] ?? mediaType).trim().toLowerCase();
}

/**
 * Pull one example out of the several shapes the specifications use: OpenAPI's
 * `examples` map of objects wrapping the value under `value`, Swagger 2.0's map
 * of media type to example, and JSON Schema 2020-12's plain array.
 */
function firstExample(value: unknown): unknown {
  const first = Array.isArray(value) ? value[0] : Object.values(asRecord(value) ?? {})[0];
  if (first === undefined) return undefined;

  const wrapper = asRecord(first);
  return wrapper && 'value' in wrapper ? wrapper.value : first;
}
