import assert from "node:assert/strict";
import { test } from "node:test";
import { requiresDocumentNavigation } from "./document-navigation.ts";

test("CSP-isolated local file tools cross real document boundaries in both directions, but ordinary routes and same-document fragments keep SPA behavior", () => {
  for (const href of ["/write/vault", "/write/vault?file=untrusted", "/write/%76ault", "/write/vault/"]) assert.equal(requiresDocumentNavigation("/write", href), true);
  for (const href of ["/", "/write", "/write/collections", "https://other.example.test/"]) assert.equal(requiresDocumentNavigation("/write/vault", href), true);
  for (const [from, to] of [["/write", "/write/merge"], ["/articles/example", "/"], ["/write/vault", "#top"], ["/write/vault", "javascript:alert(1)"]]) assert.equal(requiresDocumentNavigation(from!, to!), false);
});

test("overlap's URL-inert local shell crosses Documents rather than feeding Router data queries through its clean-URL loader", () => {
  for (const href of ["/write/overlap", "/write/overlap?file=untrusted", "/write/%6fverlap", "/write/overlap/"]) assert.equal(requiresDocumentNavigation("/write/collections", href), true);
  for (const href of ["/", "/write", "/write/collections", "/write/merge"]) assert.equal(requiresDocumentNavigation("/write/overlap", href), true);
  assert.equal(requiresDocumentNavigation("/write/overlap", "#top"), false);
});

test("terminology review uses a clean, private Document for both entry and exit, without selecting files through Router queries", () => {
  for (const href of ["/write/terms", "/write/terms?recipe=untrusted", "/write/%74erms", "/write/terms/"]) assert.equal(requiresDocumentNavigation("/write/collections", href), true);
  for (const href of ["/", "/write", "/write/collections", "/write/overlap"]) assert.equal(requiresDocumentNavigation("/write/terms", href), true);
  assert.equal(requiresDocumentNavigation("/write/terms", "#top"), false);
});
