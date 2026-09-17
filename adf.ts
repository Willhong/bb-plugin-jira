// Atlassian Document Format <-> Markdown.
//
// Jira Cloud's REST v3 takes and returns rich text (descriptions, comments) as
// ADF, a JSON tree. Agents and the panel both speak Markdown, so the plugin
// converts at the Jira boundary in both directions.
//
// The conversion covers what people actually type into an issue: paragraphs,
// headings, bullet/ordered lists, code blocks, quotes, rules, and inline bold,
// italic, strike, code, and links. Anything else Jira sends back (panels,
// tables, media, mentions, emoji) degrades to its text rather than vanishing,
// so reading never silently drops content.

export interface AdfMark {
  type: string;
  attrs?: Record<string, unknown>;
}

export interface AdfNode {
  type: string;
  text?: string;
  marks?: AdfMark[];
  attrs?: Record<string, unknown>;
  content?: AdfNode[];
}

export interface AdfDoc {
  type: "doc";
  version: 1;
  content: AdfNode[];
}

// ---------------------------------------------------------------------------
// Markdown -> ADF
// ---------------------------------------------------------------------------

const INLINE_PATTERN =
  /(`[^`]+`)|(\[[^\]]+\]\([^)\s]+\))|(\*\*[^*]+\*\*)|(__[^_]+__)|(~~[^~]+~~)|(\*[^*\s][^*]*\*)|(_[^_\s][^_]*_)/;

function withMark(nodes: AdfNode[], mark: AdfMark): AdfNode[] {
  return nodes.map((node) =>
    node.type === "text"
      ? { ...node, marks: [...(node.marks ?? []), mark] }
      : node,
  );
}

export function inlineToAdf(text: string): AdfNode[] {
  const nodes: AdfNode[] = [];
  let rest = text;
  while (rest.length > 0) {
    const match = INLINE_PATTERN.exec(rest);
    if (match === null) {
      nodes.push({ type: "text", text: rest });
      break;
    }
    if (match.index > 0) {
      nodes.push({ type: "text", text: rest.slice(0, match.index) });
    }
    const token = match[0];
    if (match[1] !== undefined) {
      nodes.push({
        type: "text",
        text: token.slice(1, -1),
        marks: [{ type: "code" }],
      });
    } else if (match[2] !== undefined) {
      const split = token.indexOf("](");
      const label = token.slice(1, split);
      const href = token.slice(split + 2, -1);
      nodes.push(...withMark(inlineToAdf(label), { type: "link", attrs: { href } }));
    } else if (match[3] !== undefined || match[4] !== undefined) {
      nodes.push(...withMark(inlineToAdf(token.slice(2, -2)), { type: "strong" }));
    } else if (match[5] !== undefined) {
      nodes.push(...withMark(inlineToAdf(token.slice(2, -2)), { type: "strike" }));
    } else {
      nodes.push(...withMark(inlineToAdf(token.slice(1, -1)), { type: "em" }));
    }
    rest = rest.slice(match.index + token.length);
  }
  return nodes.filter((node) => node.type !== "text" || (node.text ?? "") !== "");
}

function paragraph(text: string): AdfNode {
  const content = inlineToAdf(text);
  return content.length > 0 ? { type: "paragraph", content } : { type: "paragraph" };
}

const BULLET = /^(\s*)[-*+]\s+(.*)$/;
const ORDERED = /^(\s*)\d+[.)]\s+(.*)$/;

function listItemsToAdf(
  lines: string[],
  kind: "bulletList" | "orderedList",
): AdfNode {
  const pattern = kind === "bulletList" ? BULLET : ORDERED;
  const items: AdfNode[] = [];
  for (const line of lines) {
    const match = pattern.exec(line);
    if (match !== null) {
      items.push({ type: "listItem", content: [paragraph(match[2] ?? "")] });
      continue;
    }
    // A continuation line folds into the previous item's paragraph.
    const last = items[items.length - 1]?.content?.[0];
    if (last !== undefined) {
      last.content = [
        ...(last.content ?? []),
        { type: "hardBreak" },
        ...inlineToAdf(line.trim()),
      ];
    }
  }
  return { type: kind, content: items };
}

export function markdownToAdf(markdown: string): AdfDoc {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const content: AdfNode[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index] ?? "";

    if (line.trim() === "") {
      index += 1;
      continue;
    }

    const fence = /^```\s*([\w+-]*)\s*$/.exec(line);
    if (fence !== null) {
      const body: string[] = [];
      index += 1;
      while (index < lines.length && !/^```\s*$/.test(lines[index] ?? "")) {
        body.push(lines[index] ?? "");
        index += 1;
      }
      index += 1; // closing fence (or end of input)
      const text = body.join("\n");
      content.push({
        type: "codeBlock",
        ...(fence[1] ? { attrs: { language: fence[1] } } : {}),
        ...(text.length > 0 ? { content: [{ type: "text", text }] } : {}),
      });
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading !== null) {
      content.push({
        type: "heading",
        attrs: { level: heading[1]?.length ?? 1 },
        content: inlineToAdf((heading[2] ?? "").trim()),
      });
      index += 1;
      continue;
    }

    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      content.push({ type: "rule" });
      index += 1;
      continue;
    }

    if (/^>\s?/.test(line)) {
      const quoted: string[] = [];
      while (index < lines.length && /^>\s?/.test(lines[index] ?? "")) {
        quoted.push((lines[index] ?? "").replace(/^>\s?/, ""));
        index += 1;
      }
      content.push({
        type: "blockquote",
        content: markdownToAdf(quoted.join("\n")).content,
      });
      continue;
    }

    const listKind = BULLET.test(line)
      ? "bulletList"
      : ORDERED.test(line)
        ? "orderedList"
        : null;
    if (listKind !== null) {
      const pattern = listKind === "bulletList" ? BULLET : ORDERED;
      const block: string[] = [];
      while (index < lines.length) {
        const current = lines[index] ?? "";
        if (current.trim() === "") break;
        if (!pattern.test(current) && !/^\s+\S/.test(current)) break;
        block.push(current);
        index += 1;
      }
      content.push(listItemsToAdf(block, listKind));
      continue;
    }

    // Paragraph: consecutive plain lines, joined with hard breaks the way
    // Jira's own editor keeps a typed line break.
    const block: string[] = [];
    while (index < lines.length) {
      const current = lines[index] ?? "";
      if (
        current.trim() === "" ||
        /^```/.test(current) ||
        /^#{1,6}\s/.test(current) ||
        /^>\s?/.test(current) ||
        BULLET.test(current) ||
        ORDERED.test(current)
      ) {
        break;
      }
      block.push(current);
      index += 1;
    }
    const inline: AdfNode[] = [];
    block.forEach((text, position) => {
      if (position > 0) inline.push({ type: "hardBreak" });
      inline.push(...inlineToAdf(text));
    });
    content.push(
      inline.length > 0 ? { type: "paragraph", content: inline } : { type: "paragraph" },
    );
  }

  return { type: "doc", version: 1, content };
}

// ---------------------------------------------------------------------------
// ADF -> Markdown
// ---------------------------------------------------------------------------

function isNode(value: unknown): value is AdfNode {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { type?: unknown }).type === "string"
  );
}

function children(node: AdfNode): AdfNode[] {
  return Array.isArray(node.content) ? node.content.filter(isNode) : [];
}

function textWithMarks(node: AdfNode): string {
  let text = node.text ?? "";
  if (text.length === 0) return "";
  const marks = Array.isArray(node.marks) ? node.marks : [];
  const has = (type: string) => marks.some((mark) => mark.type === type);
  if (has("code")) return `\`${text}\``;
  if (has("strong")) text = `**${text}**`;
  if (has("em")) text = `*${text}*`;
  if (has("strike")) text = `~~${text}~~`;
  const link = marks.find((mark) => mark.type === "link");
  const href = link?.attrs?.href;
  if (typeof href === "string") text = `[${text}](${href})`;
  return text;
}

function inlineToMarkdown(nodes: AdfNode[]): string {
  return nodes
    .map((node) => {
      switch (node.type) {
        case "text":
          return textWithMarks(node);
        case "hardBreak":
          return "\n";
        case "mention": {
          const label = node.attrs?.text;
          return typeof label === "string" ? label : "@user";
        }
        case "emoji": {
          const shortName = node.attrs?.text ?? node.attrs?.shortName;
          return typeof shortName === "string" ? shortName : "";
        }
        case "inlineCard": {
          const url = node.attrs?.url;
          return typeof url === "string" ? url : "";
        }
        case "date": {
          const timestamp = Number(node.attrs?.timestamp);
          return Number.isFinite(timestamp)
            ? new Date(timestamp).toISOString().slice(0, 10)
            : "";
        }
        case "status": {
          const label = node.attrs?.text;
          return typeof label === "string" ? `[${label}]` : "";
        }
        default:
          return inlineToMarkdown(children(node));
      }
    })
    .join("");
}

function indent(text: string, prefix: string): string {
  return text
    .split("\n")
    .map((line, index) => (index === 0 ? line : `${prefix}${line}`))
    .join("\n");
}

function blockToMarkdown(node: AdfNode): string {
  switch (node.type) {
    case "paragraph":
      return inlineToMarkdown(children(node));
    case "heading": {
      const level = Math.min(6, Math.max(1, Number(node.attrs?.level) || 1));
      return `${"#".repeat(level)} ${inlineToMarkdown(children(node))}`;
    }
    case "codeBlock": {
      const language = node.attrs?.language;
      const body = children(node)
        .map((child) => child.text ?? "")
        .join("");
      return `\`\`\`${typeof language === "string" ? language : ""}\n${body}\n\`\`\``;
    }
    case "blockquote":
      return blocksToMarkdown(children(node))
        .split("\n")
        .map((line) => `> ${line}`)
        .join("\n");
    case "rule":
      return "---";
    case "bulletList":
    case "orderedList":
      return children(node)
        .map((item, position) => {
          const marker = node.type === "bulletList" ? "- " : `${position + 1}. `;
          const body = children(item).map(blockToMarkdown).join("\n");
          return `${marker}${indent(body, " ".repeat(marker.length))}`;
        })
        .join("\n");
    case "taskList":
      return children(node)
        .map((item) => {
          const done = item.attrs?.state === "DONE";
          return `- [${done ? "x" : " "}] ${inlineToMarkdown(children(item))}`;
        })
        .join("\n");
    case "table":
      return children(node)
        .map(
          (row) =>
            `| ${children(row)
              .map((cell) => blocksToMarkdown(children(cell)).replace(/\n+/g, " "))
              .join(" | ")} |`,
        )
        .join("\n");
    case "mediaSingle":
    case "mediaGroup":
    case "media":
      return "(attachment)";
    default: {
      // panel, expand, layoutSection, …: keep their text.
      const inner = children(node);
      if (inner.length === 0) return node.text ?? "";
      return inner.every((child) => child.type === "text" || child.type === "hardBreak")
        ? inlineToMarkdown(inner)
        : blocksToMarkdown(inner);
    }
  }
}

function blocksToMarkdown(nodes: AdfNode[]): string {
  return nodes.map(blockToMarkdown).filter((text) => text.length > 0).join("\n\n");
}

/** Renders an ADF value to Markdown; a non-ADF or empty value becomes "". */
export function adfToMarkdown(value: unknown): string {
  if (typeof value === "string") return value;
  if (!isNode(value)) return "";
  return value.type === "doc" ? blocksToMarkdown(children(value)) : blockToMarkdown(value);
}
