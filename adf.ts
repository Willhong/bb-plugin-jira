// Atlassian Document Format <-> Markdown.
//
// Jira Cloud's REST v3 takes and returns rich text (descriptions, comments) as
// ADF, a JSON tree. Agents and the panel both speak Markdown, so the plugin
// converts at the Jira boundary in both directions.
//
// The conversion covers what people actually type into an issue: paragraphs,
// headings, bullet/ordered lists, code blocks, quotes, rules, GFM tables, and
// inline bold, italic, strike, code, and links. Anything else Jira sends back
// (panels, media, mentions, emoji) degrades to its text rather than vanishing,
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

// A code span opens and closes with backtick runs of equal length, so
// ```` ``` ```` holds three backticks. One space of padding on each side is
// dropped, as in CommonMark.
const CODE_SPAN = /(`+)(?!`)([\s\S]*?[^`])\1(?!`)/;

function codeSpanText(content: string): string {
  return /^ [\s\S]* $/.test(content) && content.trim() !== "" ? content.slice(1, -1) : content;
}

/** Wraps text in a backtick run longer than any run inside it. */
function codeSpan(text: string): string {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(longest + 1);
  const pad = text.startsWith("`") || text.endsWith("`") ? " " : "";
  return `${fence}${pad}${text}${pad}${fence}`;
}

const INLINE_PATTERN = new RegExp(
  // Wrapped as group 1, so the code span's own backreference shifts to \2.
  `(${CODE_SPAN.source.replace("\\1", "\\2")})|` +
    /(\[[^\]]+\]\([^)\s]+\))|(\*\*[^*]+\*\*)|(__[^_]+__)|(~~[^~]+~~)|(\*[^*\s][^*]*\*)|(_[^_\s][^_]*_)/.source,
);

// ADF lets a `code` mark combine only with `link`; Jira rejects the whole
// document (400 INVALID_INPUT) otherwise. So `**see `x`**` keeps `x` as code
// and leaves that span unbolded rather than failing the write.
function withMark(nodes: AdfNode[], mark: AdfMark): AdfNode[] {
  return nodes.map((node) => {
    if (node.type !== "text") return node;
    const isCode = node.marks?.some((existing) => existing.type === "code") ?? false;
    if (isCode && mark.type !== "link") return node;
    return { ...node, marks: [...(node.marks ?? []), mark] };
  });
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
    // Groups 2 and 3 are the code span's backtick run and content.
    if (match[1] !== undefined) {
      nodes.push({
        type: "text",
        text: codeSpanText(match[3] ?? ""),
        marks: [{ type: "code" }],
      });
    } else if (match[4] !== undefined) {
      const split = token.indexOf("](");
      const label = token.slice(1, split);
      const href = token.slice(split + 2, -1);
      nodes.push(...withMark(inlineToAdf(label), { type: "link", attrs: { href } }));
    } else if (match[5] !== undefined || match[6] !== undefined) {
      nodes.push(...withMark(inlineToAdf(token.slice(2, -2)), { type: "strong" }));
    } else if (match[7] !== undefined) {
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

// GFM table: a header row, a `| --- | :-: |` delimiter row, then body rows.
const TABLE_DELIMITER = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

/** Splits a table row on unescaped pipes outside code spans; `\|` becomes `|`. */
export function splitTableRow(line: string): string[] {
  let row = line.trim();
  if (row.startsWith("|")) row = row.slice(1);
  if (row.endsWith("|") && !row.endsWith("\\|")) row = row.slice(0, -1);
  const cells: string[] = [];
  let cell = "";
  for (let position = 0; position < row.length; position += 1) {
    const char = row[position];
    if (char === "\\" && row[position + 1] === "|") {
      cell += "|";
      position += 1;
    } else if (char === "`") {
      // A code span runs to the next backtick run of the same length; pipes
      // inside it stay text. An unmatched run is literal backticks.
      const run = /^`+/.exec(row.slice(position))?.[0] ?? "`";
      const close = new RegExp(`(?<!\`)${run}(?!\`)`).exec(row.slice(position + run.length));
      const end = close === null ? position + run.length : position + run.length + close.index + run.length;
      cell += row.slice(position, end).replace(/\\\|/g, "|");
      position = end - 1;
    } else if (char === "|") {
      cells.push(cell.trim());
      cell = "";
    } else {
      cell += char;
    }
  }
  cells.push(cell.trim());
  return cells;
}

export function isTableStart(lines: string[], index: number): boolean {
  const header = lines[index] ?? "";
  const delimiter = lines[index + 1] ?? "";
  if (!header.includes("|") || !TABLE_DELIMITER.test(delimiter)) return false;
  return splitTableRow(header).length === splitTableRow(delimiter).length;
}

// Agents often break a line inside a cell with `<br>`; ADF wants a hardBreak.
function cellToAdf(text: string): AdfNode {
  const inline: AdfNode[] = [];
  text.split(/<br\s*\/?>/i).forEach((part, position) => {
    if (position > 0) inline.push({ type: "hardBreak" });
    inline.push(...inlineToAdf(part.trim()));
  });
  return inline.length > 0 ? { type: "paragraph", content: inline } : { type: "paragraph" };
}

function tableToAdf(rows: string[][]): AdfNode {
  const width = rows[0]?.length ?? 0;
  return {
    type: "table",
    attrs: { isNumberColumnEnabled: false, layout: "default" },
    content: rows.map((row, rowIndex) => ({
      type: "tableRow",
      content: Array.from({ length: width }, (_unused, column) => ({
        type: rowIndex === 0 ? "tableHeader" : "tableCell",
        attrs: {},
        content: [cellToAdf(row[column] ?? "")],
      })),
    })),
  };
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

    if (isTableStart(lines, index)) {
      const rows = [splitTableRow(line)];
      index += 2; // header and delimiter
      while (index < lines.length) {
        const current = lines[index] ?? "";
        if (current.trim() === "" || !current.includes("|")) break;
        rows.push(splitTableRow(current));
        index += 1;
      }
      content.push(tableToAdf(rows));
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
        ORDERED.test(current) ||
        isTableStart(lines, index)
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
  if (has("code")) return codeSpan(text);
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
    case "table": {
      // GFM needs the delimiter row after the header, or the pipes render as text.
      const rows = children(node).map((row) =>
        children(row).map((cell) =>
          blocksToMarkdown(children(cell)).replace(/\|/g, "\\|").replace(/\n+/g, "<br>"),
        ),
      );
      if (rows.length === 0) return "";
      const width = Math.max(...rows.map((row) => row.length));
      const line = (cells: string[]) =>
        `| ${Array.from({ length: width }, (_unused, column) => cells[column] ?? "").join(" | ")} |`;
      return [line(rows[0] ?? []), line(Array(width).fill("---")), ...rows.slice(1).map(line)].join("\n");
    }
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
