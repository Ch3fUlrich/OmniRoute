import test from "node:test";
import assert from "node:assert/strict";
import { inferRequiredScope } from "../../src/server/authz/accessScopes.ts";

test("read methods default to read", () => {
  assert.equal(inferRequiredScope("GET", "/api/v1/models"), "read");
  assert.equal(inferRequiredScope("HEAD", "/api/health"), "read");
  assert.equal(inferRequiredScope("OPTIONS", "/api/anything"), "read");
});

test("mutating methods default to write", () => {
  assert.equal(inferRequiredScope("PUT", "/api/config"), "write");
  assert.equal(inferRequiredScope("PATCH", "/api/combo/x"), "write");
});

test("admin-prefix routes require admin for ANY method", () => {
  assert.equal(inferRequiredScope("GET", "/api/cli/tokens"), "admin");
  assert.equal(inferRequiredScope("POST", "/api/cli/tokens"), "admin");
  assert.equal(inferRequiredScope("DELETE", "/api/cli/tokens/tok_1"), "admin");
  assert.equal(inferRequiredScope("GET", "/api/oauth/start"), "admin");
  assert.equal(inferRequiredScope("POST", "/api/auth/login"), "admin");
  assert.equal(inferRequiredScope("POST", "/api/policy"), "admin");
  assert.equal(inferRequiredScope("POST", "/api/services/foo/start"), "admin");
});

test("admin-mutation prefixes: GET stays read, mutations become admin", () => {
  // No static status route exists: this is a credential-bearing connection id.
  assert.equal(inferRequiredScope("GET", "/api/providers/status"), "admin");
  assert.equal(inferRequiredScope("GET", "/api/providers"), "read");
  assert.equal(inferRequiredScope("POST", "/api/providers"), "admin");
  assert.equal(inferRequiredScope("DELETE", "/api/providers/openai"), "admin");
  // cli-tools/apply writes to the host fs
  assert.equal(inferRequiredScope("POST", "/api/cli-tools/apply"), "admin");
});

test("a brand-new mutating route is write by default (not admin)", () => {
  assert.equal(inferRequiredScope("POST", "/api/some-future-route"), "write");
  assert.equal(inferRequiredScope("GET", "/api/some-future-route"), "read");
});

test("prefix matching does not over-match unrelated paths", () => {
  // "/api/authz-inventory" must NOT be caught by the "/api/auth" admin prefix
  assert.equal(inferRequiredScope("GET", "/api/authz-inventory"), "read");
  // "/api/services" itself and its children are admin, but a lookalike is not
  assert.equal(inferRequiredScope("GET", "/api/services-catalog"), "read");
});

test("API-key management needs admin: a write token cannot mint a manage-scoped key (GHSA-35gq)", () => {
  assert.equal(inferRequiredScope("POST", "/api/keys"), "admin");
  assert.equal(inferRequiredScope("PATCH", "/api/keys/abc"), "admin");
  assert.equal(inferRequiredScope("DELETE", "/api/keys/abc"), "admin");
  assert.equal(inferRequiredScope("POST", "/api/keys/abc/regenerate"), "admin");
  // listing stays readable, but the plaintext reveal is admin even though it is a GET
  assert.equal(inferRequiredScope("GET", "/api/keys"), "read");
  assert.equal(inferRequiredScope("GET", "/api/keys/abc/reveal"), "admin");
  assert.equal(inferRequiredScope("GET", "/api/keys-catalog"), "read");
});

test("status route read exceptions reject sub-routes, trailing slashes and mixed case", () => {
  // Base ff1ad941 allows safe-method reads on these paths, including siblings.
  for (const route of ["/api/providers", "/api/resilience", "/api/monitoring/health"]) {
    for (const method of ["GET", "HEAD", "OPTIONS"]) {
      assert.equal(inferRequiredScope(method, route), "read");
      assert.equal(inferRequiredScope(method, route + "/"), "read");
      assert.equal(
        inferRequiredScope(method, route.toUpperCase()),
        route === "/api/providers" ? "admin" : "read"
      );
    }
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      assert.notEqual(inferRequiredScope(method, route), "read");
    }
  }
  for (const method of ["GET", "HEAD", "OPTIONS"]) {
    assert.equal(inferRequiredScope(method, "/api/providers/id"), "admin");
    assert.equal(inferRequiredScope(method, "/api/providers/id/models"), "read");
    assert.equal(inferRequiredScope(method, "/api/resilience/id"), "read");
  }
});
