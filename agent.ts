import Anthropic from "@anthropic-ai/sdk";
import fs from "fs";
import path from "path";
import { parseArgs } from "util";
import { execSync } from "child_process";

// --- CLI ---

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  options: {
    see:     { type: "string",  short: "s", default: "see.md" },
    out:     { type: "string",  short: "o", default: "context.md" },
    model:   { type: "string",  short: "m", default: "claude-haiku-4-5" },
    commits: { type: "string",  short: "c" }, // e.g. --commits 3
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
  -s, --see         Instructions file  (default: see.md)
  -o, --out         Output file        (default: context.md)
  -m, --model       Claude model       (default: claude-haiku-4-5)
  -c, --commits <n> Use files changed in last N commits instead of uncommitted
  -h, --help        Show this help

Modes:
  Fresh   context.md absent → full codebase scan via agent tools
  Update  context.md exists → only changed files sent to LLM (uncommitted)
  Commits --commits <n>     → only files changed in last N commits sent to LLM

Examples:
  ctx
  ctx ./lingo-app
  ctx ./lingo-app --out docs/context.md
  ctx --commits 3
`);
  process.exit(0);
}

const targetDir  = path.resolve(positionals[0] ?? process.cwd());
const seePath    = path.resolve(values.see!);
const outPath    = path.resolve(values.out!);
const model      = values.model!;
const commitCount = values.commits ? parseInt(values.commits, 10) : null;

// --- Helpers ---

function readFile(filePath: string): string {
  try {
    const size = fs.statSync(filePath).size;
    if (size > 50_000) return `[File too large: ${size} bytes]`;
    return fs.readFileSync(filePath, "utf-8");
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
  try {
    return execSync(cmd, { cwd, encoding: "utf-8" }).trim();
  } catch {
    return "";
  }
}

function getChangedFiles(cwd: string, commits: number | null): string[] {
  let output: string;
  if (commits !== null) {
    // Files changed in last N commits
    output = git(`git diff HEAD~${commits} --name-only`, cwd);
  } else {
    // Uncommitted changes (staged + unstaged)
    output = git("git status --porcelain", cwd);
    output = output
      .split("\n")
      .filter(Boolean)
      .map((line) => line.slice(3).trim()) // strip status prefix
      .join("\n");
  }
  return output
    .split("\n")
    .map((f) => f.trim())
    .filter(Boolean)
    .map((f) => path.join(cwd, f))
    .filter((f) => fs.existsSync(f) && fs.statSync(f).isFile());
}

function formatFileBlock(filePath: string): string {
  const content = readFile(filePath);
  return `\n--- ${filePath} ---\n${content}\n`;
}

// --- Tool definitions (used in fresh mode only) ---

const allTools: Anthropic.Tool[] = [
  {
    name: "list_files",
    description: "List all files in a directory (ignores node_modules, .next, .git, dist)",
    input_schema: {
      type: "object",
      properties: {
        directory: { type: "string", description: "Path to the directory" },
      },
      required: ["directory"],
      additionalProperties: false,
    },
  },
  {
    name: "read_file",
    description: "Read the contents of a file",
    input_schema: {
      type: "object",
      properties: {
        file_path: { type: "string", description: "Path to the file" },
      },
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
        file_path: { type: "string", description: "Path to the output file" },
        content:   { type: "string", description: "Content to write" },
      },
      required: ["file_path", "content"],
      additionalProperties: false,
    },
  },
];

const writeOnlyTools: Anthropic.Tool[] = [allTools[2]]; // just write_file

function executeTool(name: string, input: Record<string, string>): string {
  switch (name) {
    case "list_files":  return JSON.stringify(listFiles(input.directory));
    case "read_file":   return readFile(input.file_path);
    case "write_file":  return writeFile(input.file_path, input.content);
    default:            return `Unknown tool: ${name}`;
  }
}

// --- Agent loop ---

async function runAgent(
  client: Anthropic,
  system: string,
  userMessage: string,
  tools: Anthropic.Tool[]
) {
  const messages: Anthropic.MessageParam[] = [
    { role: "user", content: userMessage },
  ];

  while (true) {
    const response = await client.messages.create({
      model,
      max_tokens: 8096,
      system,
      tools,
      messages,
    });

    for (const block of response.content) {
      if (block.type === "text" && block.text.trim()) console.log(block.text);
    }

    if (response.stop_reason !== "tool_use") break;

    const toolUses = response.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use"
    );

    messages.push({ role: "assistant", content: response.content });

    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const tool of toolUses) {
      console.log(`🔧 ${tool.name}(${JSON.stringify(tool.input)})`);
      const result = executeTool(tool.name, tool.input as Record<string, string>);
      toolResults.push({ type: "tool_result", tool_use_id: tool.id, content: result });
    }

    messages.push({ role: "user", content: toolResults });
  }
}

// --- Main ---

async function run() {
  if (!fs.existsSync(seePath)) {
    console.error(`❌ Instructions file not found: ${seePath}`);
    process.exit(1);
  }
  if (!fs.existsSync(targetDir)) {
    console.error(`❌ Target folder not found: ${targetDir}`);
    process.exit(1);
  }

  const client      = new Anthropic();
  const instructions = readFile(seePath);
  const hasContext  = fs.existsSync(outPath);
  const isUpdateMode = hasContext && commitCount === null;
  const isCommitMode = hasContext && commitCount !== null;
  const isFreshMode  = !hasContext;

  // Pre-load known important files
  const i18nPath = path.join(targetDir, "i18n.json");
  const i18nBlock = fs.existsSync(i18nPath)
    ? `\n--- i18n.json ---\n${readFile(i18nPath)}\n`
    : "";

  console.log(`📖 Instructions : ${seePath}`);
  console.log(`📁 Target folder: ${targetDir}`);
  console.log(`📝 Output       : ${outPath}`);
  console.log(`🤖 Model        : ${model}`);

  // --- Fresh mode ---
  if (isFreshMode) {
    console.log(`🆕 Mode         : Fresh scan\n`);

    const system = `You are a codebase analysis agent.
Use list_files and read_file to explore the target folder.
Write a thorough but concise context summary using write_file.
Always write the output file as your final action.`;

    const userMessage = [
      `Instructions:\n${instructions}`,
      i18nBlock,
      `Target folder: ${targetDir}`,
      `Output file: ${outPath}`,
      `\nExplore the codebase and write the context file.`,
    ].join("\n");

    await runAgent(client, system, userMessage, allTools);
  }

  // --- Update mode (uncommitted changes) ---
  if (isUpdateMode) {
    const changedFiles = getChangedFiles(targetDir, null);
    if (changedFiles.length === 0) {
      console.log("✅ No uncommitted changes found — context.md is up to date.");
      return;
    }
    console.log(`♻️  Mode         : Update (${changedFiles.length} uncommitted file(s))\n`);

    const changedBlocks = changedFiles.map(formatFileBlock).join("\n");

    const system = `You are a codebase context updater.
You receive an existing context summary and a set of changed files.
Update the context to reflect the changes. Keep unchanged sections intact.
Write the full updated context using write_file.`;

    const userMessage = [
      `Instructions:\n${instructions}`,
      `\n--- Existing context (${outPath}) ---\n${readFile(outPath)}`,
      i18nBlock,
      `\n--- Changed files (uncommitted) ---${changedBlocks}`,
      `\nUpdate the context file at: ${outPath}`,
    ].join("\n");

    await runAgent(client, system, userMessage, writeOnlyTools);
  }

  // --- Commit mode ---
  if (isCommitMode) {
    const changedFiles = getChangedFiles(targetDir, commitCount);
    if (changedFiles.length === 0) {
      console.log(`✅ No files changed in last ${commitCount} commit(s).`);
      return;
    }
    console.log(`🔖 Mode         : Commits (last ${commitCount}, ${changedFiles.length} file(s))\n`);

    const changedBlocks = changedFiles.map(formatFileBlock).join("\n");

    const system = `You are a codebase context updater.
You receive an existing context summary and files changed in recent commits.
Update the context to reflect the changes. Keep unchanged sections intact.
Write the full updated context using write_file.`;

    const userMessage = [
      `Instructions:\n${instructions}`,
      `\n--- Existing context (${outPath}) ---\n${readFile(outPath)}`,
      i18nBlock,
      `\n--- Files changed in last ${commitCount} commit(s) ---${changedBlocks}`,
      `\nUpdate the context file at: ${outPath}`,
    ].join("\n");

    await runAgent(client, system, userMessage, writeOnlyTools);
  }

  console.log(fs.existsSync(outPath)
    ? `\n✅ Done → ${outPath}`
    : `\n⚠️  Output file was not created`
  );
}

run().catch((e) => {
  console.error("❌", e.message);
  process.exit(1);
});
