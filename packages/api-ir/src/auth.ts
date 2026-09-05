/**
 * The authentication model (specification section 7).
 *
 * A scheme describes *how* to authenticate — which header, which flow, which
 * scopes. It never carries a credential. The value is a `SecretReference`
 * string such as `env:PAYMENT_API_KEY`, resolved at the moment of use by the
 * security engine and registered with the redactor there.
 *
 * That separation is what makes it safe to persist an API catalog, show it in
 * the dashboard, and send parts of it to a model: there is nothing secret in
 * it to leak.
 */

export type AuthKind =
  | 'none'
  | 'apiKey'
  | 'bearer'
  | 'basic'
  | 'jwt'
  | 'oauth2'
  | 'cookie'
  | 'hmac'
  | 'awsSignature'
  | 'custom'
  | 'unknown';

export type ApiKeyLocation = 'header' | 'query' | 'cookie';

export type OAuth2Flow =
  | 'authorizationCode'
  | 'authorizationCodePkce'
  | 'clientCredentials'
  | 'implicit'
  | 'password'
  | 'deviceCode';

interface AuthSchemeBase {
  /** Identifier used by endpoints to reference this scheme. */
  readonly id: string;
  readonly kind: AuthKind;
  readonly description?: string;
  /**
   * Where the credential comes from, e.g. "env:STRIPE_API_KEY". Absent until
   * the user supplies one; never a literal credential.
   */
  readonly secretRef?: string;
}

export interface NoAuthScheme extends AuthSchemeBase {
  readonly kind: 'none';
}

export interface ApiKeyScheme extends AuthSchemeBase {
  readonly kind: 'apiKey';
  readonly in: ApiKeyLocation;
  /** Header, query parameter, or cookie name carrying the key. */
  readonly name: string;
  /** Prefix the API expects before the value, such as "Token ". */
  readonly valuePrefix?: string;
}

export interface BearerScheme extends AuthSchemeBase {
  readonly kind: 'bearer' | 'jwt';
  /** Bearer format hint from the source, such as "JWT". */
  readonly bearerFormat?: string;
  readonly headerName?: string;
}

export interface BasicScheme extends AuthSchemeBase {
  readonly kind: 'basic';
  readonly usernameRef?: string;
  readonly passwordRef?: string;
}

export interface OAuth2Scope {
  readonly name: string;
  readonly description?: string;
}

export interface OAuth2Scheme extends AuthSchemeBase {
  readonly kind: 'oauth2';
  readonly flow: OAuth2Flow;
  readonly authorizationUrl?: string;
  readonly tokenUrl?: string;
  readonly refreshUrl?: string;
  readonly scopes: readonly OAuth2Scope[];
  /** True when the flow requires PKCE, which a public client always should. */
  readonly pkce?: boolean;
  readonly clientIdRef?: string;
  readonly clientSecretRef?: string;
}

export interface CookieScheme extends AuthSchemeBase {
  readonly kind: 'cookie';
  readonly name: string;
}

export interface HmacScheme extends AuthSchemeBase {
  readonly kind: 'hmac';
  readonly headerName: string;
  readonly algorithm?: string;
  /** Which request parts are signed, when the source documents it. */
  readonly signedComponents?: readonly string[];
}

export interface AwsSignatureScheme extends AuthSchemeBase {
  readonly kind: 'awsSignature';
  readonly region?: string;
  readonly service?: string;
  readonly accessKeyIdRef?: string;
  readonly secretAccessKeyRef?: string;
}

export interface CustomScheme extends AuthSchemeBase {
  readonly kind: 'custom';
  /** Header names the API requires, without their values. */
  readonly headerNames: readonly string[];
  readonly instructions?: string;
}

export interface UnknownAuthScheme extends AuthSchemeBase {
  readonly kind: 'unknown';
  /** What the source said, when it was not machine-readable. */
  readonly rawDescription?: string;
}

export type AuthScheme =
  | NoAuthScheme
  | ApiKeyScheme
  | BearerScheme
  | BasicScheme
  | OAuth2Scheme
  | CookieScheme
  | HmacScheme
  | AwsSignatureScheme
  | CustomScheme
  | UnknownAuthScheme;

/** A single authentication requirement: a scheme plus the scopes it needs. */
export interface SecurityRequirement {
  readonly schemeId: string;
  readonly scopes: readonly string[];
}

/**
 * One complete way to authenticate a call: every requirement in the array must
 * be satisfied *simultaneously*. An endpoint carries a list of options and the
 * caller satisfies any one of them.
 *
 * The nesting is not incidental. OpenAPI's security list expresses both "or"
 * (between entries) and "and" (within an entry), and an API that needs a key
 * *and* a signature is common enough that flattening the two levels would tell
 * the agent either credential alone suffices — a wrong integration, not merely
 * an incomplete one.
 *
 * An empty option means the endpoint may be called with no credentials.
 */
export type SecurityOption = readonly SecurityRequirement[];

/** True when at least one option requires nothing, i.e. the endpoint is open. */
export function isPublic(options: readonly SecurityOption[]): boolean {
  return options.length === 0 || options.some((option) => option.length === 0);
}

/** Every scheme mentioned across all options, deduplicated. */
export function referencedSchemeIds(options: readonly SecurityOption[]): string[] {
  return [...new Set(options.flat().map((requirement) => requirement.schemeId))];
}

/**
 * The first option whose every scheme is configured, or `undefined` when none
 * can be satisfied. Picking here rather than at the call site keeps the "any
 * one option, all of its requirements" rule in a single place.
 */
export function satisfiableOption(
  options: readonly SecurityOption[],
  schemes: readonly AuthScheme[],
): SecurityOption | undefined {
  const byId = new Map(schemes.map((scheme) => [scheme.id, scheme]));
  return options.find((option) =>
    option.every((requirement) => {
      const scheme = byId.get(requirement.schemeId);
      return scheme !== undefined && isConfigured(scheme);
    }),
  );
}

/** Human-readable summary for the UI and for approval prompts. */
export function describeAuth(scheme: AuthScheme): string {
  switch (scheme.kind) {
    case 'none':
      return 'No authentication';
    case 'apiKey':
      return `API key in ${scheme.in} "${scheme.name}"`;
    case 'bearer':
      return `Bearer token in ${scheme.headerName ?? 'Authorization'}`;
    case 'jwt':
      return `JWT in ${scheme.headerName ?? 'Authorization'}`;
    case 'basic':
      return 'HTTP basic authentication';
    case 'oauth2':
      return `OAuth2 ${scheme.flow}${scheme.pkce ? ' with PKCE' : ''}`;
    case 'cookie':
      return `Session cookie "${scheme.name}"`;
    case 'hmac':
      return `HMAC signature in ${scheme.headerName}`;
    case 'awsSignature':
      return `AWS signature v4${scheme.service ? ` for ${scheme.service}` : ''}`;
    case 'custom':
      return `Custom headers: ${scheme.headerNames.join(', ')}`;
    case 'unknown':
    default:
      return 'Authentication requirement could not be determined from the specification';
  }
}

/**
 * Which secret references a scheme needs before a request can be sent.
 * Used to tell the user exactly which environment variables to set, by name.
 */
export function requiredSecretRefs(scheme: AuthScheme): readonly string[] {
  const refs: string[] = [];
  const push = (value: string | undefined): void => {
    if (value) refs.push(value);
  };

  push(scheme.secretRef);
  if (scheme.kind === 'basic') {
    push(scheme.usernameRef);
    push(scheme.passwordRef);
  }
  if (scheme.kind === 'oauth2') {
    push(scheme.clientIdRef);
    push(scheme.clientSecretRef);
  }
  if (scheme.kind === 'awsSignature') {
    push(scheme.accessKeyIdRef);
    push(scheme.secretAccessKeyRef);
  }
  return [...new Set(refs)];
}

/**
 * True when the scheme is fully configured and a request could be attempted.
 * A scheme the agent cannot satisfy must produce a question, not a failed call.
 */
export function isConfigured(scheme: AuthScheme): boolean {
  if (scheme.kind === 'none') return true;
  if (scheme.kind === 'unknown') return false;
  if (scheme.kind === 'basic') {
    return Boolean(scheme.usernameRef && scheme.passwordRef);
  }
  if (scheme.kind === 'oauth2') {
    return scheme.flow === 'clientCredentials'
      ? Boolean(scheme.clientIdRef && scheme.clientSecretRef)
      : Boolean(scheme.secretRef ?? scheme.clientIdRef);
  }
  if (scheme.kind === 'awsSignature') {
    return Boolean(scheme.accessKeyIdRef && scheme.secretAccessKeyRef);
  }
  return Boolean(scheme.secretRef);
}
