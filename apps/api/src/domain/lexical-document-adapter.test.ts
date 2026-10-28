import assert from "node:assert/strict";
import test from "node:test";
import {
  articleDocumentToLexicalEditorState,
  lexicalEditorStateToArticleDocument,
} from "./lexical-document-adapter.ts";

const lexicalText = (text, format = 0) => ({
  detail: 0, format, mode: "normal", style: "", text, type: "text", version: 1,
});
const lexicalElement = (type, children, extra = {}) => ({
  children, direction: null, format: "", indent: 0, type, version: 1, ...extra,
});

test("application v1 round-trips marks, links, headings, quotes, lists, code and stable block IDs", () => {
  const contentBlocks = [
    {
      id: "intro",
      type: "paragraph",
      text: "中文 bold link",
      inlines: [
        { text: "中文 " },
        { text: "bold", marks: ["bold"] },
        { text: " " },
        { text: "link", href: "https://example.test/essay", marks: ["italic", "underline"] },
      ],
    },
    { id: "heading", type: "heading", level: 2, text: "A heading" },
    { id: "quote", type: "quote", text: "Quoted words", inlines: [{ text: "Quoted ", marks: ["italic"] }, { text: "words" }] },
    {
      id: "list", type: "list", ordered: true, items: ["first item", "linked item"],
      itemInlines: [[{ text: "first item" }], [{ text: "linked ", href: "/articles/one" }, { text: "item", marks: ["bold"] }]],
    },
    { id: "code", type: "code", language: "typescript", code: "const answer = 42;\nconsole.log(answer);" },
  ];

  const lexical = articleDocumentToLexicalEditorState(contentBlocks, { contentBlocksVersion: 1 });
  assert.equal(lexical.root.type, "root");
  assert.equal(lexical.root.children[0].children[1].format, 1);
  const roundTrip = lexicalEditorStateToArticleDocument(lexical, { previousBlocks: contentBlocks });
  assert.equal(roundTrip.contentBlocksVersion, 1);
  assert.deepEqual(roundTrip.contentBlocks, contentBlocks);
});

test("Lexical EditorState imports standard text formatting and hyperlink nodes into v1 runs", () => {
  const state = {
    root: lexicalElement("root", [
      lexicalElement("paragraph", [
        lexicalText("A "),
        lexicalText("bold", 1),
        lexicalText(" and "),
        lexicalElement("link", [lexicalText("linked", 2)], { url: "https://example.test/path", rel: null, target: null, title: null }),
        lexicalText(".", 0),
      ]),
    ]),
  };
  const document = lexicalEditorStateToArticleDocument(JSON.stringify(state));
  assert.equal(document.contentBlocksVersion, 1);
  assert.equal(document.contentBlocks[0].text, "A bold and linked.");
  assert.deepEqual(document.contentBlocks[0].inlines, [
    { text: "A " },
    { text: "bold", marks: ["bold"] },
    { text: " and " },
    { text: "linked", marks: ["italic"], href: "https://example.test/path" },
    { text: "." },
  ]);
});

test("Lexical list types and code language/text survive conversion", () => {
  const state = {
    root: lexicalElement("root", [
      lexicalElement("list", [
        lexicalElement("listitem", [lexicalText("first")], { checked: null, value: 1 }),
        lexicalElement("listitem", [
          lexicalElement("link", [lexicalText("second")], { url: "/second", rel: null, target: null, title: null }),
        ], { checked: null, value: 2 }),
      ], { listType: "bullet", start: 1, tag: "ul" }),
      lexicalElement("code", [lexicalText("let value = 3;")], { language: "javascript", theme: "" }),
    ]),
  };
  const document = lexicalEditorStateToArticleDocument(state);
  assert.deepEqual(document.contentBlocks[0], {
    id: "lexical-block-1", type: "list", ordered: false, items: ["first", "second"],
    itemInlines: [[{ text: "first" }], [{ text: "second", href: "/second" }]],
  });
  assert.deepEqual(document.contentBlocks[1], {
    id: "lexical-block-2", type: "code", language: "javascript", code: "let value = 3;",
  });
});

test("unsupported custom nodes and data that the application contract cannot represent fail closed", () => {
  const imageDocument = [{ id: "image", type: "image", src: "/media/cover.webp", alt: "Cover" }];
  assert.throws(() => articleDocumentToLexicalEditorState(imageDocument), { code: "BAD_USER_INPUT" });
  assert.throws(() => articleDocumentToLexicalEditorState([
    { id: "quote", type: "quote", text: "Attribution", attribution: "A writer" },
  ]), { code: "BAD_USER_INPUT" });

  const unsupportedNode = { root: lexicalElement("root", [lexicalElement("table", [])]) };
  assert.throws(() => lexicalEditorStateToArticleDocument(unsupportedNode), /unsupported block node type/);
  const unsafeLink = {
    root: lexicalElement("root", [
      lexicalElement("paragraph", [
        lexicalElement("link", [lexicalText("x")], { url: "javascript:alert(1)", rel: null, target: null, title: null }),
      ]),
    ]),
  };
  assert.throws(() => lexicalEditorStateToArticleDocument(unsafeLink), { code: "BAD_USER_INPUT" });
});

test("adapter rejects unsupported formats, CSS styles, nested lists and malformed Lexical JSON", () => {
  const cases = [
    { root: lexicalElement("root", [lexicalElement("paragraph", [lexicalText("x", 32)])]) },
    { root: lexicalElement("root", [lexicalElement("paragraph", [{ ...lexicalText("x"), style: "color:red" }])]) },
    { root: lexicalElement("root", [lexicalElement("list", [
      lexicalElement("listitem", [lexicalElement("list", [lexicalElement("listitem", [lexicalText("nested")])], { listType: "bullet", tag: "ul", start: 1 })]),
    ], { listType: "bullet", tag: "ul", start: 1 })]) },
    { root: lexicalElement("root", [lexicalElement("heading", [lexicalText("x")], { tag: "h1" })]) },
  ];
  for (const state of cases) assert.throws(() => lexicalEditorStateToArticleDocument(state), { code: "BAD_USER_INPUT" });
  assert.throws(() => lexicalEditorStateToArticleDocument("{not json"), { code: "BAD_USER_INPUT" });
  assert.throws(() => lexicalEditorStateToArticleDocument({ root: lexicalElement("root", []) }), { code: "BAD_USER_INPUT" });
});

test("adapter preserves unchanged IDs and assigns unique IDs to new or edited blocks", () => {
  const previousBlocks = [
    { id: "original-id", type: "paragraph", text: "Before" },
    { id: "kept-id", type: "paragraph", text: "Keep me" },
  ];
  const state = {
    root: lexicalElement("root", [
      lexicalElement("paragraph", [lexicalText("Changed")]),
      lexicalElement("paragraph", [lexicalText("Keep me")]),
    ]),
  };
  const document = lexicalEditorStateToArticleDocument(state, { previousBlocks, idFactory: (index) => "fresh-" + (index + 1) });
  assert.equal(document.contentBlocks[0].id, "fresh-1");
  assert.equal(document.contentBlocks[1].id, "kept-id");
  assert.equal(new Set(document.contentBlocks.map((block) => block.id)).size, 2);
});
