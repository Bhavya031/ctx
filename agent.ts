#!/usr/bin/env bun
import Anthropic from "@anthropic-ai/sdk";
import fs from "fs";
import path from "path";
import { parseArgs } from "util";
import { execSync } from "child_process";
import { createHash } from "crypto";

// --- CLI ---

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  options: {
    prompt:   { type: "string",  short: "p" },
    out:      { type: "string",  short: "o", default: "lingo-context.md" },
    model:    { type: "string",  short: "m", default: "claude-haiku-4-5" },
    commits:  { type: "string",  short: "c" },
    "dry-run": { type: "boolean", short: "d", default: false },
    help:     { type: "boolean", short: "h", default: false },
  },
  allowPositionals: true,
});

if (values.help) {
  console.log(`
Usage: ctx [folder] [options]

Arguments:
  folder            Folder to analyse (default: current directory)

Options:
  -p, --prompt      What the agent should focus on
  -o, --out         Output file        (default: lingo-context.md)
  -m, --model       Claude model       (default: claude-haiku-4-5)
  -c, --commits <n> Use files changed in last N commits instead of uncommitted
  -d, --dry-run     Show what would run without writing anything
  -h, --help        Show this help

Modes:
  Fresh   lingo-context.md absent → full project scan via agent tools
  Update  lingo-context.md exists → only changed files sent to LLM (uncommitted)
  Commits --commits <n>           → only files changed in last N commits sent to LLM

Examples:
  ctx ./lingo-app -p "B2B SaaS, formal tone"
  ctx ./lingo-app -p "consumer app, friendly and casual"
  ctx ./lingo-app --out lingo-context.md
  ctx --commits 3
`);
  process.exit(0);
}

const targetDir   = path.resolve(positionals[0] ?? process.cwd());
const outPath     = path.resolve(targetDir, values.out!);
const model       = values.model!;
const commitCount = values.commits ? parseInt(values.commits, 10) : null;
const dryRun      = values["dry-run"]!;

// --- Interactive prompts ---

async function selectMenu(question: string, options: string[], defaultIndex = 0): Promise<number> {
  let selected = defaultIndex;
  const render = () => {
    process.stdout.write("\x1B[?25l");
    process.stdout.write(`\n${question}\n`);
    for (let i = 0; i < options.length; i++) {
      process.stdout.write(i === selected
        ? `\x1B[36m❯ ${options[i]}\x1B[0m\n`
        : `  ${options[i]}\n`
      );
    }
  };
  const clear = () => process.stdout.write(`\x1B[${options.length + 2}A\x1B[0J`);

  render();

  return new Promise((resolve) => {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding("utf-8");

    const onKey = (key: string) => {
      if (key === "\x1B[A" && selected > 0) { clear(); selected--; render(); }
      else if (key === "\x1B[B" && selected < options.length - 1) { clear(); selected++; render(); }
      else if (key === "\r" || key === "\n") {
        process.stdout.write("\x1B[?25h");
        process.stdin.setRawMode(false);
        process.stdin.pause();
        process.stdin.off("data", onKey);
        process.stdout.write("\n");
        resolve(selected);
      } else if (key === "\x03") {
        process.stdout.write("\x1B[?25h");
        process.exit(0);
      }
    };

    process.stdin.on("data", onKey);
  });
}

async function textPrompt(question: string, placeholder = ""): Promise<string> {
  process.stdout.write(question);
  if (placeholder) process.stdout.write(` \x1B[2m(${placeholder})\x1B[0m`);
  process.stdout.write("\n\x1B[36m❯ \x1B[0m");

  return new Promise((resolve) => {
    process.stdin.resume();
    process.stdin.setEncoding("utf-8");
    process.stdin.once("data", (data: string) => {
      process.stdin.pause();
      resolve(data.trim());
    });
  });
}

function die(...lines: string[]): never {
  for (const line of lines) console.error(line);
  process.exit(1);
}

// --- State (stored in ~/.ctx/state/) ---

type State = { processedFiles: Record<string, string> };
type FileEntry = [path: string, hash: string];

// Created once, reused across all state ops
let _stateDir: string | undefined;
function getStateDir(): string {
  if (!_stateDir) {
    _stateDir = path.join(process.env.HOME!, ".ctx", "state");
    fs.mkdirSync(_stateDir, { recursive: true });
  }
  return _stateDir;
}

function md5(data: Buffer | string): string {
  return createHash("md5").update(data).digest("hex");
}

function stateFile(p: string) {
  return path.join(getStateDir(), `${md5(p)}.json`);
}

function loadState(p: string): State {
  try { return JSON.parse(fs.readFileSync(stateFile(p), "utf-8")); }
  catch { return { processedFiles: {} }; }
}

function saveState(p: string, state: State) {
  fs.writeFileSync(stateFile(p), JSON.stringify(state, null, 2));
}

function fileHash(f: string): string {
  try { return md5(fs.readFileSync(f)); }
  catch { return ""; }
}

// Returns [path, hash] pairs for files new/changed since last run
function filterNewFiles(files: string[], state: State): FileEntry[] {
  return files.flatMap((f) => {
    const hash = fileHash(f);
    return hash !== state.processedFiles[f] ? [[f, hash]] : [];
  });
}

function recordFiles(entries: FileEntry[], p: string) {
  const state = loadState(p);
  for (const [f, hash] of entries) state.processedFiles[f] = hash;
  saveState(p, state);
}

function clearState(p: string) {
  try { fs.unlinkSync(stateFile(p)); } catch {}
}

// --- Helpers ---

function readFile(filePath: string): string {
  try {
    const buf = fs.readFileSync(filePath);
    if (buf.byteLength > 50_000) return `[File too large: ${buf.byteLength} bytes]`;
    return buf.toString("utf-8");
  } catch (e) {
    return `[Error: ${e}]`;
  }
}

function writeFile(filePath: string, content: string): string {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf-8");
  return `Written to ${filePath}`;
}

function listFiles(dir: string): string[] {
  const results: string[] = [];
  const IGNORE = new Set(["node_modules", ".next", ".git", "dist", ".turbo"]);
  function walk(current: string) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (IGNORE.has(entry.name)) continue;
      const full = path.join(current, entry.name);
      entry.isDirectory() ? walk(full) : results.push(full);
    }
  }
  walk(dir);
  return results;
}

function git(cmd: string, cwd: string): string {
  try { return execSync(cmd, { cwd, encoding: "utf-8" }).trim(); }
  catch { return ""; }
}

function getChangedFiles(cwd: string, commits: number | null): string[] {
  let output: string;
  if (commits !== null) {
    output = git(`git diff HEAD~${commits} --name-only`, cwd);
  } else {
    output = git("git status --porcelain", cwd)
      .split("\n").filter(Boolean).map((l) => l.slice(3).trim()).join("\n");
  }
  const paths = output.split("\n").map((f) => f.trim()).filter(Boolean)
    .map((f) => path.join(cwd, f));

  // Expand directories (e.g. untracked `?? app/locales/`) into individual files
  const files: string[] = [];
  for (const p of paths) {
    try {
      const stat = fs.statSync(p);
      if (stat.isFile()) files.push(p);
      else if (stat.isDirectory()) files.push(...listFiles(p));
    } catch {}
  }
  return files;
}

function formatFileBlock(filePath: string): string {
  return `\n--- ${filePath} ---\n${readFile(filePath)}\n`;
}

// --- Tools ---

const allTools: Anthropic.Tool[] = [
  {
    name: "list_files",
    description: "List all files in a directory (ignores node_modules, .next, .git, dist)",
    input_schema: {
      type: "object",
      properties: { directory: { type: "string" } },
      required: ["directory"],
      additionalProperties: false,
    },
  },
  {
    name: "read_file",
    description: "Read the contents of a file",
    input_schema: {
      type: "object",
      properties: { file_path: { type: "string" } },
      required: ["file_path"],
      additionalProperties: false,
    },
  },
  {
    name: "write_file",
    description: "Write content to a file",
    input_schema: {
      type: "object",
      properties: {
        file_path: { type: "string" },
        content:   { type: "string" },
      },
      required: ["file_path", "content"],
      additionalProperties: false,
    },
  },
];

const writeOnlyTools: Anthropic.Tool[] = [allTools[2]];

function executeTool(name: string, input: Record<string, string>): string {
  switch (name) {
    case "list_files":  return JSON.stringify(listFiles(input.directory));
    case "read_file":   return readFile(input.file_path);
    case "write_file":  return writeFile(input.file_path, input.content);
    default:            return `Unknown tool: ${name}`;
  }
}

// --- Review ---

const PREVIEW_LINES = 50;

async function reviewContent(label: string, content: string): Promise<"accept" | "skip" | string> {
  const lines = content.split("\n");
  const preview = lines.slice(0, PREVIEW_LINES).join("\n");
  const truncated = lines.length > PREVIEW_LINES;

  const hr = "─".repeat(60);
  console.log(`\n${hr}`);
  console.log(`  Review: ${label}`);
  console.log(hr);
  console.log(preview);
  if (truncated) console.log(`\n  ... (${lines.length - PREVIEW_LINES} more lines)`);
  console.log(hr);

  const choice = await selectMenu("Accept this?", ["Accept", "Request changes", "Skip"], 0);
  if (choice === 0) return "accept";
  if (choice === 2) return "skip";

  const feedback = await textPrompt("What should be changed?");
  return feedback || "skip";
}

// --- Agent loop ---

async function runAgent(client: Anthropic, system: string, userMessage: string, tools: Anthropic.Tool[], review = false) {
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: userMessage }];

  while (true) {
    const response = await client.messages.create({ model, max_tokens: 8096, system, tools, messages });

    for (const block of response.content) {
      if (block.type === "text" && block.text.trim()) console.log(block.text);
    }

    if (response.stop_reason !== "tool_use") break;

    const toolUses = response.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
    messages.push({ role: "assistant", content: response.content });

    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const tool of toolUses) {
      const input = tool.input as Record<string, string>;

      if (review && tool.name === "write_file") {
        const label = path.basename(input.file_path);
        const result = await reviewContent(label, input.content);
        if (result === "accept") {
          console.log(`  > write_file(${JSON.stringify({ file_path: input.file_path })})`);
          toolResults.push({ type: "tool_result", tool_use_id: tool.id, content: writeFile(input.file_path, input.content) });
        } else if (result === "skip") {
          toolResults.push({ type: "tool_result", tool_use_id: tool.id, content: "User skipped this write — do not write this file." });
        } else {
          // Feedback: return to agent without writing so it can revise
          toolResults.push({ type: "tool_result", tool_use_id: tool.id, content: `User requested changes: ${result}\nPlease revise and call write_file again with the updated content.` });
        }
      } else {
        console.log(`  > ${tool.name}(${JSON.stringify(tool.input)})`);
        toolResults.push({ type: "tool_result", tool_use_id: tool.id, content: executeTool(tool.name, input) });
      }
    }

    messages.push({ role: "user", content: toolResults });
  }
}

// --- JSONC comment injection ---

async function generateJsoncComments(
  client: Anthropic,
  sourceFile: string,
  lingoContext: string,
  feedback = "",
): Promise<Record<string, string>> {
  const content = readFile(sourceFile);
  const feedbackBlock = feedback ? `\nUser feedback on previous attempt:\n${feedback}\nPlease revise accordingly.\n` : "";
  const response = await client.messages.create({
    model,
    max_tokens: 4096,
    messages: [{
      role: "user",
      content: `You are generating translator notes for a JSONC localization file.

Localization context:
${lingoContext}

Source file (${path.basename(sourceFile)}):
${content}
${feedbackBlock}
For each key, write a short one-line translator note that tells the translator:
- What UI element or context the string appears in
- Any ambiguity, idiom, or special meaning to watch out for
- Length or tone constraints if relevant

Return ONLY a flat JSON object mapping each key to its note. No nesting, no explanation.
Example: {"nav.home": "Navigation item in top header bar", "checkout.submit": "Button — triggers payment, keep short"}`,
    }],
  });

  const text = response.content.find((b): b is Anthropic.TextBlock => b.type === "text")?.text ?? "{}";
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return {};
  try { return JSON.parse(match[0]); } catch { return {}; }
}

function injectJsoncComments(filePath: string, comments: Record<string, string>): void {
  const lines = fs.readFileSync(filePath, "utf-8").split("\n");
  const result: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const keyMatch = line.match(/^(\s*)"([^"]+)"\s*:/);
    if (keyMatch) {
      const indent = keyMatch[1];
      const key = keyMatch[2];
      // Remove existing comment line immediately above this key
      if (result.length > 0 && result[result.length - 1].trimStart().startsWith("//")) {
        result.pop();
      }
      if (comments[key]) {
        result.push(`${indent}// ${comments[key]}`);
      }
    }
    result.push(line);
  }

  fs.writeFileSync(filePath, result.join("\n"), "utf-8");
}

function parseSections(content: string): Record<string, string> {
  const sections: Record<string, string> = {};
  const parts = content.split(/^(## .+)$/m);
  for (let i = 1; i < parts.length; i += 2) {
    sections[parts[i].trim()] = parts[i + 1]?.trim() ?? "";
  }
  return sections;
}

function printUpdateSummary(before: string, after: string): void {
  const prev = parseSections(before);
  const next = parseSections(after);
  const allKeys = new Set([...Object.keys(prev), ...Object.keys(next)]);
  const lines: string[] = [];

  for (const key of allKeys) {
    const label = key.replace("## ", "");
    if (!prev[key]) {
      lines.push(`  + ${label} (new section)`);
    } else if (!next[key]) {
      lines.push(`  - ${label} (removed)`);
    } else if (prev[key] !== next[key]) {
      const pluralize = (n: number, word: string) => `${n} ${word}${n !== 1 ? "s" : ""}`;
      if (label === "Tricky Terms") {
        const countRows = (s: string) => s.split("\n").filter(l => l.startsWith("| ") && !l.includes("---") && !l.includes("Term |")).length;
        const added = countRows(next[key]) - countRows(prev[key]);
        const suffix = added > 0 ? ` (+${pluralize(added, "term")})` : "";
        lines.push(`  ~ ${label}${suffix}`);
      } else if (label === "Files") {
        const countFiles = (s: string) => (s.match(/^### /gm) ?? []).length;
        const added = countFiles(next[key]) - countFiles(prev[key]);
        const suffix = added > 0 ? ` (+${pluralize(added, "file")})` : "";
        lines.push(`  ~ ${label}${suffix}`);
      } else {
        lines.push(`  ~ ${label}`);
      }
    }
  }

  if (lines.length) {
    console.log("\n  Summary:");
    for (const l of lines) console.log(l);
  }
}

async function updateI18nProvider(i18nPath: string, contextPath: string): Promise<void> {
  const context = readFile(contextPath);
  const i18nRaw = fs.readFileSync(i18nPath, "utf-8");
  const i18n = JSON.parse(i18nRaw);

  const newProvider = {
    id: "anthropic",
    model: "claude-haiku-4-5",
    prompt: `Translate from {source} to {target}.\n\n${context}`,
  };

  if (i18n.provider) {
    console.log("\n  Existing provider in i18n.json:");
    console.log(`    id: ${i18n.provider.id}, model: ${i18n.provider.model}`);
    const choice = await selectMenu("Provider already set — overwrite with updated context?", ["Update", "Keep existing"], 1);
    if (choice === 1) return;
  }

  i18n.provider = newProvider;
  fs.writeFileSync(i18nPath, JSON.stringify(i18n, null, 2), "utf-8");
  console.log("  > updated provider in i18n.json");
}

async function runJsoncInjection(client: Anthropic, files: string[], contextPath: string, review = false): Promise<void> {
  if (files.length === 0) return;
  const injected: FileEntry[] = [];
  const lingoContext = readFile(contextPath);
  for (const file of files) {
    let comments: Record<string, string> = {};
    let extraContext = "";

    while (true) {
      console.log(`  > generating comments for ${path.basename(file)}${extraContext ? " (revised)" : ""}`);
      comments = await generateJsoncComments(client, file, lingoContext, extraContext);
      if (Object.keys(comments).length === 0) break;

      if (!review) break;

      const preview = Object.entries(comments)
        .map(([k, v]) => `  "${k}": "${v}"`)
        .join("\n");
      const result = await reviewContent(`comments for ${path.basename(file)}`, preview);
      if (result === "accept") break;
      if (result === "skip") { comments = {}; break; }
      extraContext = result; // feedback → re-generate
    }

    if (Object.keys(comments).length > 0) {
      injectJsoncComments(file, comments);
      injected.push([file, fileHash(file)]);
    }
  }
  if (injected.length > 0) recordFiles(injected, contextPath);
}

// --- Main ---

async function run() {
  if (!fs.existsSync(targetDir)) {
    die(`  ✗ Target folder not found: ${targetDir}`);
  }

  const i18nPath = path.join(targetDir, "i18n.json");
  if (!fs.existsSync(i18nPath)) {
    die(`  ! No i18n.json found — is this a lingo project?`, `    Run: npx lingo.dev@latest init`);
  }

  const client = new Anthropic();
  const hasContext   = fs.existsSync(outPath);
  const isUpdateMode = hasContext && commitCount === null;
  const isCommitMode = hasContext && commitCount !== null;
  const isFreshMode  = !hasContext;

  const i18nContent = readFile(i18nPath);
  const i18nBlock   = `\n--- i18n.json ---\n${i18nContent}\n`;

  // Parse i18n.json to extract source locale, targets, and bucket file patterns
  let sourceLocale = "en";
  let targetLocales: string[] = [];
  let bucketIncludes: string[] = [];
  let jsoncSourceFiles: string[] = [];
  try {
    const i18n = JSON.parse(i18nContent);
    // Support both {locale: {source, targets}} and flat {locale, locales}
    sourceLocale  = i18n.locale?.source ?? i18n.locale ?? "en";
    targetLocales = (i18n.locale?.targets ?? i18n.locales ?? []).filter((l: string) => l !== sourceLocale);
    bucketIncludes = Object.values(i18n.buckets ?? {})
      .flatMap((b: any) => b.include ?? [])
      .map((p: string) => p.replace("[locale]", sourceLocale));
    // Detect jsonc source files from ANY bucket whose include paths end in .jsonc
    jsoncSourceFiles = Object.values(i18n.buckets ?? {})
      .flatMap((b: any) => b.include ?? [])
      .filter((p: string) => p.endsWith(".jsonc"))
      .map((p: string) => path.resolve(targetDir, p.replace("[locale]", sourceLocale)))
      .filter((f: string) => fs.existsSync(f));
  } catch {}

  // Resolve bucket glob patterns to actual file paths
  function matchesBucket(filePath: string): boolean {
    return bucketIncludes.some((pattern) => {
      const abs = path.resolve(targetDir, pattern);
      return filePath === abs || filePath.endsWith(pattern.replace("[locale]", sourceLocale));
    });
  }

  const printDone = () => console.log(fs.existsSync(outPath) ? `\n  ✓ Done → ${outPath}` : `\n  ! Output file was not created`);

  console.log(`  Target folder : ${targetDir}`);
  console.log(`  Output        : ${outPath}`);
  console.log(`  Model         : ${model}`);
  console.log(`  Source locale : ${sourceLocale}`);
  if (targetLocales.length) console.log(`  Targets       : ${targetLocales.join(", ")}`);

  const freshSystem = `You are a localization context agent. Generate lingo-context.md so an AI translator produces accurate, consistent translations.

Read: i18n.json (provided) → source bucket files → package.json + README. Stop there unless something is still unclear.

Rules:
- Every rule must be actionable. Bad: "be careful with tone". Good: "use tú not usted — never vos".
- App section: what it does and who uses it. No marketing language.
- Language sections: named pitfalls only, no generic advice. Include pronoun register (tú/usted/vos), script/dialect notes, and length warnings.
- Tricky Terms: flag every ambiguous, idiomatic, or domain-specific term. For tech terms, name the wrong translation risk explicitly (e.g. "ship" — mistranslated as mail/send, means deploy/launch).

Structure (use exactly):

## App
## Tone & Voice
## Audience
## Languages
Source: ${sourceLocale}
Targets: ${targetLocales.join(", ") || "none specified"}
### <locale>
- <rule>

## Tricky Terms
| Term | Risk | Guidance |
|------|------|----------|

## Files
### <filename>
What / Tone / Priority

Write the file as your final action.`;

  const freshMessage = (prompt: string) => [
    `Instructions:\n${prompt}`,
    i18nBlock,
    `Target folder: ${targetDir}`,
    `Output file: ${outPath}`,
    `\nExplore the project and write lingo-context.md.`,
  ].join("\n");

  const modeLabel = isCommitMode ? `last ${commitCount} commit(s)` : "uncommitted";
  const logFile   = (f: string) => console.log(`    ~ ${path.relative(targetDir, f)}`);

  // Resolve bucket include patterns to existing files on disk — handles exact paths and single * globs
  function resolveBucketFiles(): string[] {
    const results: string[] = [];
    for (const p of bucketIncludes) {
      if (p.includes("*")) {
        // Single-level glob: split at the * segment and list the directory
        const dir = path.resolve(targetDir, path.dirname(p));
        const ext = path.extname(p);
        try {
          for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            if (entry.isFile() && (!ext || entry.name.endsWith(ext))) {
              results.push(path.join(dir, entry.name));
            }
          }
        } catch {}
      } else {
        const abs = path.resolve(targetDir, p);
        try { if (fs.statSync(abs).isFile()) results.push(abs); } catch {}
      }
    }
    return results;
  }

  // --- Update / Commit mode: check for changes BEFORE asking for instructions ---
  let earlyChangedFiles: FileEntry[] | null = null;
  if (isUpdateMode || isCommitMode) {
    const state = loadState(outPath);
    const gitChanged = getChangedFiles(targetDir, commitCount);

    // Always include all resolved bucket files — filterNewFiles skips anything already up to date.
    // This ensures files that are committed (not in git status) or newly added to a bucket
    // are never silently skipped.
    const candidates = [...new Set([...gitChanged.filter(matchesBucket), ...resolveBucketFiles()])];

    earlyChangedFiles = filterNewFiles(candidates, state);

    if (earlyChangedFiles.length === 0) {
      console.log(`  ✓ No new changes (${modeLabel}) — lingo-context.md is up to date.`);
      const choice = await selectMenu("Regenerate anyway?", ["No, exit", "Yes, regenerate"], 0);
      if (choice === 0) return;

      // Only now ask what to focus on
      const override = values.prompt ?? await textPrompt("What should the full regeneration cover?", "blank for default");
      const regen = override || "Generate a comprehensive lingo-context.md for this project.";
      clearState(outPath);
      await runAgent(client, freshSystem, freshMessage(regen), allTools, true);
      const bucketFiles = resolveBucketFiles();
      recordFiles(bucketFiles.map((f) => [f, fileHash(f)]), outPath);
      await runJsoncInjection(client, jsoncSourceFiles, outPath, true);
      await updateI18nProvider(i18nPath, outPath);
      return printDone();
    }
  }

  // --- Dry run: print plan and exit ---
  if (dryRun) {
    if (isFreshMode) {
      console.log(`  Mode          : Fresh scan (would generate lingo-context.md)`);
      if (jsoncSourceFiles.length) {
        console.log(`  JSONC inject  : ${jsoncSourceFiles.length} file(s)`);
        jsoncSourceFiles.forEach(logFile);
      }
    } else if (earlyChangedFiles && earlyChangedFiles.length > 0) {
      console.log(`  Mode          : Update (${earlyChangedFiles.length} file(s) from ${modeLabel})`);
      earlyChangedFiles.forEach(([f]) => logFile(f));
      const jsonc = earlyChangedFiles.map(([f]) => f).filter((f) => jsoncSourceFiles.includes(f));
      if (jsonc.length) {
        console.log(`  JSONC inject  : ${jsonc.length} file(s)`);
        jsonc.forEach(logFile);
      }
    } else {
      console.log(`  Mode          : Up to date — nothing to do`);
    }
    console.log(`\n  dry-run — no files written`);
    return;
  }

  // Get instructions: --prompt flag or ask interactively
  let instructions = values.prompt;
  if (!instructions) {
    const question = hasContext
      ? "What changed or what should the update cover?"
      : "What should the context summary include?";
    const defaultInstr = hasContext
      ? "Update lingo-context.md to reflect any recent changes."
      : "Generate a comprehensive lingo-context.md for this project.";
    instructions = await textPrompt(question, "blank for default");
    if (!instructions) instructions = defaultInstr;
  }

  // --- Fresh mode ---
  if (isFreshMode) {
    console.log(`  Mode          : Fresh scan\n`);
    clearState(outPath);
    await runAgent(client, freshSystem, freshMessage(instructions), allTools, true);
    const bucketFiles = resolveBucketFiles();
    recordFiles(bucketFiles.map((f) => [f, fileHash(f)]), outPath);
    await runJsoncInjection(client, jsoncSourceFiles, outPath, true);
  }

  // --- Update / Commit mode: process each changed file separately ---
  if ((isUpdateMode || isCommitMode) && earlyChangedFiles && earlyChangedFiles.length > 0) {
    const changedFiles = earlyChangedFiles;
    console.log(`  Mode          : Update (${changedFiles.length} new/changed file(s) from ${modeLabel})\n`);

    const updateSystem = `You are a localization context updater. One file at a time.

Given: existing lingo-context.md + one changed source file. Update the context to reflect it.

Rules:
- Touch only what this file changes. Leave all other sections as-is.
- Tricky Terms: scan every string. Add any term that is ambiguous, idiomatic, or has a wrong-translation risk:
  - Tech verbs with non-obvious meaning (ship = deploy not mail, run = execute not jog, push = git push not shove)
  - Idioms that fail literally ("off to the races", "bang your head against the wall")
  - Pronoun/register traps — if the file uses a pronoun register, note it and enforce consistency (e.g. tú throughout — never vos)
  - Cultural references that don't map across regions
- Language section: if a new consistency rule emerges from this file, add it.

Write the full updated lingo-context.md using write_file.`;

    const beforeContext = readFile(outPath);

    for (let i = 0; i < changedFiles.length; i++) {
      const [filePath, hash] = changedFiles[i];
      const fileName = path.relative(targetDir, filePath);
      console.log(`\n  (${i + 1}/${changedFiles.length}) ${fileName} — analysing...`);

      const currentContext = readFile(outPath);
      const updateMessage = [
        `Instructions:\n${instructions}`,
        `\n--- Existing context ---\n${currentContext}`,
        i18nBlock,
        `\n--- File to process ---${formatFileBlock(filePath)}`,
        `\nUpdate the context file at: ${outPath}`,
      ].join("\n");

      await runAgent(client, updateSystem, updateMessage, writeOnlyTools, true);
      recordFiles([[filePath, hash]], outPath);
    }

    recordFiles([[i18nPath, fileHash(i18nPath)]], outPath);
    printUpdateSummary(beforeContext, readFile(outPath));

    // Re-inject comments for any jsonc files that changed
    const changedJsonc = changedFiles.map(([f]) => f).filter((f) => jsoncSourceFiles.includes(f));
    await runJsoncInjection(client, changedJsonc, outPath, true);
  }

  await updateI18nProvider(i18nPath, outPath);
  printDone();
}

run().catch((e) => die(`  ✗ ${e.message}`));

