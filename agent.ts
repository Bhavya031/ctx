#!/usr/bin/env bun
import Anthropic from "@anthropic-ai/sdk";
import fs from "fs";
import path from "path";
import { values, positionals, selectMenu, textPrompt, die } from "./src/cli.ts";
import { loadState, clearState, fileHash, filterNewFiles, recordFiles } from "./src/state.ts";
import { readFile, listFiles, getChangedFiles, formatFileBlock } from "./src/files.ts";
import { allTools, writeOnlyTools, runAgent } from "./src/agent-loop.ts";
import { runJsoncInjection } from "./src/jsonc.ts";
import { printUpdateSummary, updateI18nProvider } from "./src/i18n.ts";

const targetDir   = path.resolve(positionals[0] ?? process.cwd());
const outPath     = path.resolve(targetDir, values.out!);
const model       = values.model!;
const commitCount = values.commits ? parseInt(values.commits, 10) : null;
const dryRun      = values["dry-run"]!;

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

  let sourceLocale = "en";
  let targetLocales: string[] = [];
  let bucketIncludes: string[] = [];
  let jsoncSourceFiles: string[] = [];
  try {
    const i18n = JSON.parse(i18nContent);
    sourceLocale  = i18n.locale?.source ?? i18n.locale ?? "en";
    targetLocales = (i18n.locale?.targets ?? i18n.locales ?? []).filter((l: string) => l !== sourceLocale);
    bucketIncludes = Object.values(i18n.buckets ?? {})
      .flatMap((b: any) => b.include ?? [])
      .map((p: string) => p.replace("[locale]", sourceLocale));
    jsoncSourceFiles = Object.values(i18n.buckets ?? {})
      .flatMap((b: any) => b.include ?? [])
      .filter((p: string) => p.endsWith(".jsonc"))
      .map((p: string) => path.resolve(targetDir, p.replace("[locale]", sourceLocale)))
      .filter((f: string) => fs.existsSync(f));
  } catch {}

  function matchesBucket(filePath: string): boolean {
    return bucketIncludes.some((pattern) => {
      const abs = path.resolve(targetDir, pattern);
      return filePath === abs || filePath.endsWith(pattern);
    });
  }

  function resolveBucketFiles(): string[] {
    const results: string[] = [];
    for (const p of bucketIncludes) {
      if (p.includes("*")) {
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

  const agent = (system: string, message: string, tools: Anthropic.Tool[], review = false) =>
    runAgent(client, model, system, message, tools, listFiles, review);

  const printDone = () => console.log(fs.existsSync(outPath) ? `\n  ✓ Done → ${outPath}` : `\n  ! Output file was not created`);
  const modeLabel = isCommitMode ? `last ${commitCount} commit(s)` : "uncommitted";
  const logFile   = (f: string) => console.log(`    ~ ${path.relative(targetDir, f)}`);

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

  // --- Update / Commit mode: detect changes BEFORE asking for instructions ---
  let earlyChangedFiles: ReturnType<typeof filterNewFiles> | null = null;
  if (isUpdateMode || isCommitMode) {
    const state = loadState(outPath);
    const gitChanged = getChangedFiles(targetDir, commitCount);
    const candidates = [...new Set([...gitChanged.filter(matchesBucket), ...resolveBucketFiles()])];
    earlyChangedFiles = filterNewFiles(candidates, state);

    if (earlyChangedFiles.length === 0) {
      console.log(`  ✓ No new changes (${modeLabel}) — lingo-context.md is up to date.`);
      const choice = await selectMenu("Regenerate anyway?", ["No, exit", "Yes, regenerate"], 0);
      if (choice === 0) return;

      const override = values.prompt ?? await textPrompt("What should the full regeneration cover?", "blank for default");
      const regen = override || "Generate a comprehensive lingo-context.md for this project.";
      clearState(outPath);
      await agent(freshSystem, freshMessage(regen), allTools, true);
      recordFiles(resolveBucketFiles().map((f) => [f, fileHash(f)]), outPath);
      await runJsoncInjection(client, model, jsoncSourceFiles, outPath, true);
      await updateI18nProvider(i18nPath, outPath);
      return printDone();
    }
  }

  // --- Dry run ---
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
      if (jsonc.length) { console.log(`  JSONC inject  : ${jsonc.length} file(s)`); jsonc.forEach(logFile); }
    } else {
      console.log(`  Mode          : Up to date — nothing to do`);
    }
    console.log(`\n  dry-run — no files written`);
    return;
  }

  // Get instructions
  let instructions = values.prompt;
  if (!instructions) {
    const question = hasContext ? "What changed or what should the update cover?" : "What should the context summary include?";
    const defaultInstr = hasContext ? "Update lingo-context.md to reflect any recent changes." : "Generate a comprehensive lingo-context.md for this project.";
    instructions = await textPrompt(question, "blank for default");
    if (!instructions) instructions = defaultInstr;
  }

  // --- Fresh mode ---
  if (isFreshMode) {
    console.log(`  Mode          : Fresh scan\n`);
    clearState(outPath);
    await agent(freshSystem, freshMessage(instructions), allTools, true);
    recordFiles(resolveBucketFiles().map((f) => [f, fileHash(f)]), outPath);
    await runJsoncInjection(client, model, jsoncSourceFiles, outPath, true);
  }

  // --- Update / Commit mode ---
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

      await agent(updateSystem, updateMessage, writeOnlyTools, true);
      recordFiles([[filePath, hash]], outPath);
    }

    recordFiles([[i18nPath, fileHash(i18nPath)]], outPath);
    printUpdateSummary(beforeContext, readFile(outPath));

    const changedJsonc = changedFiles.map(([f]) => f).filter((f) => jsoncSourceFiles.includes(f));
    await runJsoncInjection(client, model, changedJsonc, outPath, true);
  }

  await updateI18nProvider(i18nPath, outPath);
  printDone();
}

run().catch((e) => die(`  ✗ ${e.message}`));
