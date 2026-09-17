import { describe, expect, it } from "vitest";
import { adfToMarkdown, markdownToAdf } from "../adf";

describe("markdown -> ADF", () => {
  it("builds headings, paragraphs with hard breaks, and inline marks", () => {
    const doc = markdownToAdf("# Title\n\nSee **bold** and `code`\nnext line [docs](https://x.dev)");
    expect(doc).toEqual({
      type: "doc",
      version: 1,
      content: [
        { type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: "Title" }] },
        {
          type: "paragraph",
          content: [
            { type: "text", text: "See " },
            { type: "text", text: "bold", marks: [{ type: "strong" }] },
            { type: "text", text: " and " },
            { type: "text", text: "code", marks: [{ type: "code" }] },
            { type: "hardBreak" },
            { type: "text", text: "next line " },
            { type: "text", text: "docs", marks: [{ type: "link", attrs: { href: "https://x.dev" } }] },
          ],
        },
      ],
    });
  });

  it("builds lists and fenced code blocks without eating following blocks", () => {
    const doc = markdownToAdf("- one\n- two\n\n1. first\n2. second\n\n```ts\nconst a = 1;\n```\nafter");
    expect(doc.content.map((node) => node.type)).toEqual([
      "bulletList",
      "orderedList",
      "codeBlock",
      "paragraph",
    ]);
    expect(doc.content[0]?.content).toHaveLength(2);
    expect(doc.content[2]).toEqual({
      type: "codeBlock",
      attrs: { language: "ts" },
      content: [{ type: "text", text: "const a = 1;" }],
    });
  });

  it("produces an empty doc for blank input", () => {
    expect(markdownToAdf("  \n\n")).toEqual({ type: "doc", version: 1, content: [] });
  });
});

describe("ADF -> markdown", () => {
  it("round-trips the supported subset", () => {
    const source = [
      "## Steps",
      "",
      "Run *this* then **that** with `npm test`",
      "",
      "- alpha",
      "- beta",
      "",
      "1. one",
      "2. two",
      "",
      "> quoted",
      "",
      "```sh",
      "echo hi",
      "```",
      "",
      "---",
    ].join("\n");
    expect(adfToMarkdown(markdownToAdf(source))).toBe(source);
  });

  it("keeps the text of nodes it has no markdown for instead of dropping them", () => {
    const doc = {
      type: "doc",
      version: 1,
      content: [
        {
          type: "panel",
          attrs: { panelType: "info" },
          content: [{ type: "paragraph", content: [{ type: "text", text: "Heads up" }] }],
        },
        {
          type: "paragraph",
          content: [
            { type: "mention", attrs: { id: "abc", text: "@Kim" } },
            { type: "text", text: " please check" },
          ],
        },
      ],
    };
    expect(adfToMarkdown(doc)).toBe("Heads up\n\n@Kim please check");
  });

  it("treats non-ADF values as empty", () => {
    expect(adfToMarkdown(null)).toBe("");
    expect(adfToMarkdown({ nope: true })).toBe("");
  });
});
