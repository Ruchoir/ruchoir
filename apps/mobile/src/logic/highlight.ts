/**
 * A code block's colours, as the web's (`features/channel/highlight.ts`, same highlight.js and the
 * same candidate languages): highlight.js writes HTML, which is read back here into runs of text,
 * each with the kind of token it is, for `Text` spans to draw.
 */
import hljs from "highlight.js";

/** What a run of code is, as the web's theme groups highlight.js's classes; `plain` for the rest. */
export type CodeTone = "plain" | "comment" | "keyword" | "string" | "number" | "title" | "type" | "deletion";

export type CodeRun = { text: string; tone: CodeTone };

const AUTODETECT = [
  "rust", "typescript", "javascript", "python", "go", "java", "kotlin", "swift", "scala",
  "c", "cpp", "csharp", "objectivec", "php", "ruby", "elixir", "erlang", "haskell", "clojure",
  "lua", "perl", "r", "dart", "bash", "shell", "powershell", "sql", "json", "yaml", "toml",
  "ini", "xml", "html", "css", "scss", "less", "markdown", "dockerfile", "makefile", "diff",
  "graphql", "nginx", "plaintext",
];

const TONE: Record<string, CodeTone> = {
  comment: "comment",
  quote: "comment",
  keyword: "keyword",
  "selector-tag": "keyword",
  built_in: "keyword",
  name: "keyword",
  tag: "keyword",
  string: "string",
  attr: "string",
  symbol: "string",
  bullet: "string",
  addition: "string",
  number: "number",
  literal: "number",
  variable: "number",
  "template-variable": "number",
  attribute: "number",
  title: "title",
  section: "title",
  "selector-id": "title",
  type: "type",
  meta: "type",
  deletion: "deletion",
};

const ENTITIES: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#x27;": "'", "&#39;": "'" };
const unescape = (text: string) => text.replace(/&(amp|lt|gt|quot|#x27|#39);/g, (e) => ENTITIES[e] ?? e);

/** The tone of an opening tag's classes (`hljs-title class_` reads as a type, as on the web). */
function toneOf(classes: string, outer: CodeTone): CodeTone {
  const names = classes.split(/\s+/).map((c) => c.replace(/^hljs-/, ""));
  if (names[0] === "title" && names.includes("class_")) return "type";
  return TONE[names[0] ?? ""] ?? outer;
}

/** highlight.js's HTML read back into runs; anything it does not recognise stays plain text. */
export function runsFromHtml(html: string): CodeRun[] {
  const runs: CodeRun[] = [];
  const stack: CodeTone[] = ["plain"];
  const re = /<span class="([^"]*)">|<\/span>|([^<]+)/g;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    if (m[1] !== undefined) stack.push(toneOf(m[1], stack[stack.length - 1]!));
    else if (m[2] !== undefined) {
      const text = unescape(m[2]);
      const tone = stack[stack.length - 1]!;
      const last = runs[runs.length - 1];
      if (last && last.tone === tone) last.text += text;
      else runs.push({ text, tone });
    } else if (stack.length > 1) stack.pop();
  }
  return runs;
}

/** Colour a block: by its declared language when highlight.js knows it, else by a guess. */
export function highlight(code: string, lang?: string): { runs: CodeRun[]; language?: string } {
  try {
    const res = lang && hljs.getLanguage(lang) ? hljs.highlight(code, { language: lang }) : hljs.highlightAuto(code, AUTODETECT);
    return { runs: runsFromHtml(res.value), language: res.language };
  } catch {
    return { runs: [{ text: code, tone: "plain" }] };
  }
}
