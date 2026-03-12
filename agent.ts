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
    prompt:  { type: "string",  short: "p" },
    out:     { type: "string",  short: "o", default: "context.md" },
    model:   { type: "string",  short: "m", default: "claude-haiku-4-5" },
    commits: { type: "string",  short: "c" },
    help:    { type: "boolean", short: "h", default: false },
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
  -o, --out         Output file        (default: context.md)
  -m, --model       Claude model       (default: claude-haiku-4-5)
  -c, --commits <n> Use files changed in last N commits instead of uncommitted
  -h, --help        Show this help

Modes:
  Fresh   context.md absent → full codebase scan via agent tools
  Update  context.md exists → only changed files sent to LLM (uncommitted)
  Commits --commits <n>     → only files changed in last N commits sent to LLM

Examples:
  ctx ./lingo-app -p "summarize the codebase"
  ctx ./lingo-app -p "focus on the auth system"
  ctx ./lingo-app --out docs/context.md
  ctx --commits 3
`);
  process.exit(0);
}

const targetDir   = path.resolve(positionals[0] ?? process.cwd());
const outPath     = path.resolve(values.out!);
const model       = values.model!;
const commitCount = values.commits ? parseInt(values.commits, 10) : null;

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
  return output.split("\n").map((f) => f.trim()).filter(Boolean)
    .map((f) => path.join(cwd, f))
    .filter((f) => { try { return fs.statSync(f).isFile(); } catch { return false; } });
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

// --- Agent loop ---

async function runAgent(client: Anthropic, system: string, userMessage: string, tools: Anthropic.Tool[]) {
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
      console.log(`🔧 ${tool.name}(${JSON.stringify(tool.input)})`);
      toolResults.push({ type: "tool_result", tool_use_id: tool.id, content: executeTool(tool.name, tool.input as Record<string, string>) });
    }

    messages.push({ role: "user", content: toolResults });
  }
}

// --- Main ---

async function run() {
  if (!fs.existsSync(targetDir)) {
    console.error(`❌ Target folder not found: ${targetDir}`);
    process.exit(1);
  }

  const client = new Anthropic();
  const hasContext   = fs.existsSync(outPath);
  const isUpdateMode = hasContext && commitCount === null;
  const isCommitMode = hasContext && commitCount !== null;
  const isFreshMode  = !hasContext;

  const i18nContent = readFile(path.join(targetDir, "i18n.json"));
  const i18nBlock   = i18nContent.startsWith("[Error") ? "" : `\n--- i18n.json ---\n${i18nContent}\n`;

  const printDone = () => console.log(fs.existsSync(outPath) ? `\n✅ Done → ${outPath}` : `\n⚠️  Output file was not created`);

  console.log(`📁 Target folder: ${targetDir}`);
  console.log(`📝 Output       : ${outPath}`);
  console.log(`🤖 Model        : ${model}`);

  const freshSystem = `You are a codebase analysis agent.
Use list_files and read_file to explore the target folder.
Write a thorough but concise context summary using write_file.
Always write the output file as your final action.`;

  const freshMessage = (prompt: string) => [
    `Instructions:\n${prompt}`,
    i18nBlock,
    `Target folder: ${targetDir}`,
    `Output file: ${outPath}`,
    `\nExplore the codebase and write the context file.`,
  ].join("\n");

  // --- Update / Commit mode: check for changes BEFORE asking for instructions ---
  let earlyChangedFiles: FileEntry[] | null = null;
  if (isUpdateMode || isCommitMode) {
    const state = loadState(outPath);
    earlyChangedFiles = filterNewFiles(getChangedFiles(targetDir, commitCount), state);
    const modeLabel = isCommitMode ? `last ${commitCount} commit(s)` : "uncommitted";

    if (earlyChangedFiles.length === 0) {
      console.log(`✅ No new changes (${modeLabel}) — context.md is up to date.`);
      const choice = await selectMenu("Regenerate anyway?", ["No, exit", "Yes, regenerate"], 0);
      if (choice === 0) return;

      // Only now ask what to focus on
      const override = values.prompt ?? await textPrompt("What should the full regeneration cover?", "blank for default");
      const regen = override || "Generate a comprehensive context summary of this codebase.";
      clearState(outPath);
      await runAgent(client, freshSystem, freshMessage(regen), allTools);
      const allFiles = listFiles(targetDir);
      recordFiles(allFiles.map((f) => [f, fileHash(f)]), outPath);
      return printDone();
    }
  }

  // Get instructions: --prompt flag or ask interactively
  let instructions = values.prompt;
  if (!instructions) {
    const question = hasContext
      ? "What changed or what should the update cover?"
      : "What should the context summary include?";
    const defaultInstr = hasContext
      ? "Update the context to reflect any recent changes."
      : "Generate a comprehensive context summary of this codebase.";
    instructions = await textPrompt(question, "blank for default");
    if (!instructions) instructions = defaultInstr;
  }

  // --- Fresh mode ---
  if (isFreshMode) {
    console.log(`🆕 Mode         : Fresh scan\n`);
    clearState(outPath);
    await runAgent(client, freshSystem, freshMessage(instructions), allTools);
    // Snapshot all files so update mode only re-processes truly changed ones
    const allFiles = listFiles(targetDir);
    const entries: FileEntry[] = allFiles.map((f) => [f, fileHash(f)]);
    recordFiles(entries, outPath);
  }

  // --- Update / Commit mode: run with already-computed changed files ---
  if ((isUpdateMode || isCommitMode) && earlyChangedFiles && earlyChangedFiles.length > 0) {
    const changedFiles = earlyChangedFiles;
    const modeLabel = isCommitMode ? `last ${commitCount} commit(s)` : "uncommitted";
    const icon = isCommitMode ? "🔖" : "♻️ ";
    console.log(`${icon} Mode         : Update (${changedFiles.length} new/changed file(s) from ${modeLabel})\n`);

    const updateSystem = `You are a codebase context updater.
You receive an existing context summary and changed files.
Update the context to reflect the changes. Keep unchanged sections intact.
Write the full updated context using write_file.`;

    const updateMessage = [
      `Instructions:\n${instructions}`,
      `\n--- Existing context ---\n${readFile(outPath)}`,
      i18nBlock,
      `\n--- Changed files (${modeLabel}) ---${changedFiles.map(([f]) => formatFileBlock(f)).join("")}`,
      `\nUpdate the context file at: ${outPath}`,
    ].join("\n");

    await runAgent(client, updateSystem, updateMessage, writeOnlyTools);
    recordFiles(changedFiles, outPath);
  }

  printDone();
}

run().catch((e) => { console.error("❌", e.message); process.exit(1); });

