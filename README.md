<p align="center">
  <img src="https://raw.githubusercontent.com/bhavya031/ctx/master/demo.gif" width="100%" alt="ctx demo" />
</p>

<p align="center">
  <strong>ctx — AI context engine for lingo.dev</strong>
</p>

<p align="center">
  Your AI translator knows grammar. ctx teaches it your product.
</p>

<br />

<p align="center">
  <a href="#the-problem">Problem</a> •
  <a href="#how-it-works">How It Works</a> •
  <a href="#agentic-pipeline">Agentic Pipeline</a> •
  <a href="#install">Install</a> •
  <a href="#usage">Usage</a> •
  <a href="#jsonc-translator-notes">JSONC Notes</a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/built%20with-Bun-f9f1e1?logo=bun&style=flat-square" alt="Built with Bun" />
  <img src="https://img.shields.io/badge/powered%20by-Claude-blueviolet?logo=anthropic&style=flat-square" alt="Powered by Claude" />
  <img src="https://img.shields.io/badge/works%20with-lingo.dev-orange?style=flat-square" alt="Works with lingo.dev" />
</p>

---

## The Problem

lingo.dev is great at translating strings. What it can't do on its own is understand *your* product — the tone, the audience, the domain jargon, the idiomatic phrases that break when translated literally.

> "ship" → translated as "enviar" (to mail/send) instead of "lanzar" (to launch/deploy)
> "fly solo" → translated literally instead of "trabajar solo"
> tú vs vos inconsistency across files because no one wrote down the register rule

lingo.dev solves this with [`lingo-context.md`](https://lingo.dev/en/translator-context) — a global context file it injects into every translation prompt. But writing it by hand takes hours, and keeping it current as your codebase grows is easy to forget.

**ctx automates that entirely.** It reads your project, understands your product, and generates a precise, structured `lingo-context.md`. Then it keeps it in sync as your source files change — file by file, cheaply, only processing what actually changed.

After generating the context, ctx also writes it directly into your `i18n.json` provider prompt so lingo.dev uses it on the next run — no manual copy-paste.

---

## How It Works

```
your lingo.dev project
├── i18n.json              ← ctx reads this: locales, bucket paths, provider config
├── lingo-context.md       ← ctx generates and maintains this
└── app/locales/
    ├── en.tsx             ← source locale files ctx reads and analyses
    ├── en.jsonc           ← ctx injects per-key translator notes here
    └── en/
        └── getting-started.md
```

ctx reads `i18n.json` to discover your bucket files, analyses only the source locale, and writes a context file that covers:

- **App** — what the product does, factual, no marketing copy
- **Tone & Voice** — explicit dos and don'ts the translator must follow
- **Audience** — who reads these strings and in what context
- **Languages** — per-language pitfalls: pronoun register, dialect, length warnings
- **Tricky Terms** — every ambiguous, idiomatic, or domain-specific term with exact guidance
- **Files** — per-file rules for files that need them

Once written, ctx injects the full context into `i18n.json` as the provider prompt so lingo.dev carries it into every translation automatically.

---

## Agentic Pipeline

ctx runs as a multi-step agentic pipeline. Each step is a separate Claude call with a focused job — not one big prompt trying to do everything.

```
ctx run
  │
  ├── Step 1: Fresh scan (first run only)
  │     Claude agent explores the project using tools:
  │     list_files → read_file → write_file
  │     Reads: i18n.json + bucket files + package.json + README
  │     Writes: lingo-context.md
  │
  ├── Step 2: Per-file update (subsequent runs)
  │     For each changed source file — one Claude call per file:
  │     Reads: current lingo-context.md + one changed file
  │     Updates: only the sections affected by that file
  │     Records: file hash so it won't re-process unless content changes
  │
  ├── Step 3: JSONC comment injection (for .jsonc buckets)
  │     One Claude call per .jsonc source file:
  │     Reads: lingo-context.md + source file
  │     Writes: per-key // translator notes inline in the file
  │     lingo.dev reads these natively during translation
  │
  └── Step 4: Provider sync
        Writes the full lingo-context.md into i18n.json provider.prompt
        so lingo.dev uses it automatically — no manual step needed
```

**Why per-file?** Sending all changed files in one prompt crushes context and produces shallow analysis. Processing one file at a time keeps the window focused — Claude can deeply scan every string for tricky terms rather than skimming.

**Human in the loop:** Before writing anything, ctx shows a preview and waits for approval. You can request changes and the agent revises with full context, or skip a step entirely.

---

## Install

**Requirements:** [Bun](https://bun.sh) and an Anthropic API key.

```bash
git clone https://github.com/bhavya031/ctx
cd ctx
bun install
bun link
```

```bash
export ANTHROPIC_API_KEY=your_key_here
```

---

## Usage

```bash
# Run in your lingo.dev project
ctx ./my-app

# With a focus prompt
ctx ./my-app -p "B2B SaaS, formal tone, legal/compliance domain"

# Preview what would run without writing anything
ctx ./my-app --dry-run

# Use files changed in last 3 commits
ctx ./my-app --commits 3
```

**Options:**

| Flag | Short | Default | Description |
|------|-------|---------|-------------|
| `--prompt` | `-p` | interactive | What the agent should focus on |
| `--out` | `-o` | `lingo-context.md` | Output file path |
| `--model` | `-m` | `claude-haiku-4-5` | Claude model to use |
| `--commits` | `-c` | — | Use files changed in last N commits |
| `--dry-run` | `-d` | `false` | Preview what would run, write nothing |
| `--help` | `-h` | — | Show help |

---

## Modes

| Mode | Trigger | What runs |
|------|---------|-----------|
| **Fresh** | No `lingo-context.md` yet | Full agent scan — explores project, writes context from scratch |
| **Update** | Context exists, files changed | Per-file update — one agent call per changed bucket file |
| **Commits** | `--commits <n>` | Same as update but diffs against last N commits instead of uncommitted |

On every update run, ctx prints what changed:

```
  (1/3) app/locales/en.tsx — analysing...
  (2/3) app/locales/en.jsonc — analysing...
  (3/3) app/locales/en/getting-started.md — analysing...

  Summary:
  ~ Tricky Terms (+3 terms)
  ~ Languages
  ~ Files (+1 file)
```

State is tracked via content hashes in `~/.ctx/state/` — only genuinely new or changed files are processed.

---

## JSONC Translator Notes

For `.jsonc` bucket files, ctx injects per-key translator notes directly into the source:

```jsonc
{
  // Navigation item in the top header — keep under 12 characters
  "nav.dashboard": "Dashboard",

  // Button that triggers payment — not just "submit", implies money changing hands
  "checkout.pay": "Pay now",

  // Shown when session expires — urgent but not alarming, avoid exclamation marks
  "auth.session_expired": "Your session has ended"
}
```

lingo.dev reads these `//` comments natively and passes them to the LLM alongside the string. Notes are generated from `lingo-context.md` so they stay consistent with your global rules. Only changed `.jsonc` files get re-annotated on update runs.

---

## Review Before Writing

ctx never writes silently. Every write — context file or JSONC comments — shows a preview first:

```
────────────────────────────────────────────────────────────
  Review: lingo-context.md
────────────────────────────────────────────────────────────
## App
A B2B SaaS tool for managing compliance workflows...

## Tone & Voice
Formal, precise. Use "you" not "we"...
  ... (42 more lines)
────────────────────────────────────────────────────────────
❯ Accept
  Request changes
  Skip
```

Choose **Request changes**, describe what's wrong, and the agent revises with full context and shows you the result again.

---

## Requirements

- [Bun](https://bun.sh) v1.0+
- `ANTHROPIC_API_KEY`
- A lingo.dev project with `i18n.json`

---

*Built for the lingo.dev hackathon.*
