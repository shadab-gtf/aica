# Changelog

## 0.1.0

First release.

- Symbol and reference indexing for TypeScript and JavaScript, with a dependency
  graph and impact analysis that reports what it could not attribute.
- API import from OpenAPI, Swagger, Postman collections, the Postman API, cURL,
  and documentation, all reaching one intermediate representation.
- Endpoint-to-code matching, including when a base path lives in a constant on
  one side and in the specification's path on the other.
- Deterministic planning: files, signatures, constraints, protected files, and
  the questions the evidence does not answer.
- Patch proposal and review. Nothing is written until it is applied, and a
  revert restores content captured at apply time.
- Validation with typecheck, lint, tests and build, failure diagnosis, and
  bounded repair. A skipped check is never reported as a passing one.
- MCP client with per-tool risk classification and permissions.
- Project guidance through skills, selected from what the repository contains.
- Postman credentials held in the OS keychain through SecretStorage.
