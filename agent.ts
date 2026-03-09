import Anthropic from "@anthropic-ai/sdk";
import fs from "fs";
import path from "path";
import { parseArgs } from "util";

// --- CLI ---

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  options: {
    see:    { type: "string",  short: "s", default: "see.md" },
    out:    { type: "string",  short: "o", default: "context.md" },
    model:  { type: "string",  short: "m", default: "claude-haiku-4-5" },
    help:   { type: "boolean", short: "h", default: false },
  },
  allowPositionals: true,
});

if (values.help) {
  console.log(`
Usage: ctx [folder] [options]

Arguments:
  folder          Folder to analyse (default: current directory)

Options:
  -s, --see       Instructions file (default: see.md)
  -o, --out       Output file       (default: context.md)
  -m, --model     Claude model      (default: claude-haiku-4-5)
  -h, --help      Show this help

Examples:
  ctx
  ctx ./lingo-app
  ctx ./lingo-app --out docs/context.md
  ctx --see instructions.md --model claude-sonnet-4-6
`);
  process.exit(0);
}

const targetDir = path.resolve(positionals[0] ?? process.cwd());
const seePath   = path.resolve(values.see!);
const outPath   = path.resolve(values.out!);
const model     = values.model!;

// --- Tools ---

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

// --- Tool definitions ---

const tools: Anthropic.Tool[] = [
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
    description: "Write content to a file (creates parent dirs if needed)",
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

function executeTool(name: string, input: Record<string, string>): string {
  switch (name) {
    case "list_files":  return JSON.stringify(listFiles(input.directory));
    case "read_file":   return readFile(input.file_path);
    case "write_file":  return writeFile(input.file_path, input.content);
    default:            return `Unknown tool: ${name}`;
  }
}

// --- Main ---

async function run() {
  if (!fs.existsSync(seePath)) {
    console.error(`❌ Instructions file not found: ${seePath}`);
    console.error(`   Create it or point to one with --see <path>`);
    process.exit(1);
  }

  if (!fs.existsSync(targetDir)) {
    console.error(`❌ Target folder not found: ${targetDir}`);
    process.exit(1);
  }

  const instructions = readFile(seePath);

  console.log(`📖 Instructions : ${seePath}`);
  console.log(`📁 Target folder: ${targetDir}`);
  console.log(`📝 Output       : ${outPath}`);
  console.log(`🤖 Model        : ${model}`);
  console.log();

  const client = new Anthropic();

  const systemPrompt = `You are a codebase analysis agent.
Use list_files and read_file to explore the target folder.
Then write a thorough but concise context summary using write_file.
Always write the output file as your final action.`;

  const userMessage = `Instructions from ${seePath}:\n\n${instructions}\n\nTarget folder: ${targetDir}\nOutput file: ${outPath}\n\nGo.`;

  const messages: Anthropic.MessageParam[] = [
    { role: "user", content: userMessage },
  ];

  while (true) {
    const response = await client.messages.create({
      model,
      max_tokens: 8096,
      system: systemPrompt,
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

  console.log(fs.existsSync(outPath)
    ? `\n✅ Done → ${outPath}`
    : `\n⚠️  Output file was not created`
  );
}

run().catch((e) => {
  console.error("❌", e.message);
  process.exit(1);
});
