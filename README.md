<p align="center">
  <img src="https://raw.githubusercontent.com/bhavya031/ctx/master/demo.gif" width="100%" alt="ctx demo" />
</p>

<p align="center">
  <strong>ctx — AI context engine for lingo.dev translations</strong>
</p>

<p align="center">
  Give your AI translator the institutional knowledge a human translator would have.
</p>

<br />

<p align="center">
  <a href="#the-problem">Problem</a> •
  <a href="#how-it-works">How It Works</a> •
  <a href="#install">Install</a> •
  <a href="#usage">Usage</a> •
  <a href="#modes">Modes</a> •
  <a href="#jsonc-translator-notes">JSONC Notes</a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/built%20with-Bun-f9f1e1?logo=bun&style=flat-square" alt="Built with Bun" />
  <img src="https://img.shields.io/badge/powered%20by-Claude-blueviolet?logo=anthropic&style=flat-square" alt="Powered by Claude" />
  <img src="https://img.shields.io/badge/works%20with-lingo.dev-orange?style=flat-square" alt="Works with lingo.dev" />
</p>

---

## The Problem

lingo.dev translates your strings — but it doesn't know what your product does, who it's for, or how it should sound. Without context, translations are technically correct but tonally wrong. "Submit" becomes "Enviar" when it should be "Pagar". Marketing copy gets translated literally. Idiomatic phrases land flat.

The fix is [`lingo-context.md`](https://lingo.dev/en/translator-context) — a global context file lingo.dev injects into every translation prompt. But writing it by hand is tedious, and keeping it up to date as your codebase evolves is even harder.

**ctx generates and maintains your `lingo-context.md` automatically.** It reads your source locale files, understands your product, and produces a context file that tells the translator exactly what matters — tone, audience, tricky terms, per-file rules.

---

## How It Works

```
your project
├── i18n.json              ← ctx reads this to find your locales and bucket files
├── lingo-context.md       ← ctx writes and maintains this
└── locales/
    ├── en.json            ← ctx reads your source locale files
    └── en.jsonc           ← ctx injects per-key translator notes here
```

**Three modes:**

| Mode | When | What happens |
|------|------|-------------|
| **Fresh** | No `lingo-context.md` yet | Agent explores your project, reads source files, writes full context |
| **Update** | `lingo-context.md` exists | Only changed source files are sent to LLM — fast and cheap |
| **Commits** | `--commits <n>` | Uses files changed in last N commits instead of uncommitted changes |

Every run shows you a preview of what's about to be written and asks for approval. Request changes and the agent revises inline — the full project context goes with every revision.

---

## Install

**Requirements:** [Bun](https://bun.sh) and an Anthropic API key.

```bash
git clone https://github.com/yourusername/ctx
cd ctx
bun install
bun link
```

Set your API key:

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

# See what would run without writing anything
ctx ./my-app --dry-run

# Use files changed in last 3 commits
ctx ./my-app --commits 3

# Custom output path
ctx ./my-app --out docs/lingo-context.md
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

### Fresh scan

Run `ctx` in a project with no `lingo-context.md`. The agent explores your project — reads `i18n.json`, source locale files, `package.json`, and `README` — then writes a full context file structured as:

- **App** — what the product does, who it's for
- **Tone & Voice** — explicit dos and don'ts
- **Audience** — who reads these strings
- **Languages** — per-language pitfalls (specific, not generic)
- **Tricky Terms** — every string with ambiguity, idiom, or mistranslation risk
- **Files** — per-file rules where needed

### Update mode

Run `ctx` again after making changes. Only your changed source locale files are sent to the LLM — not the full codebase. The agent receives the existing `lingo-context.md` and the diff, updates what changed, and leaves everything else intact.

After writing, ctx prints a summary of what changed:

```
  Summary:
  ~ Tricky Terms (+2 terms)
  ~ Files (+1 file)
  ~ Tone & Voice
```

State is tracked via content hashes in `~/.ctx/state/` so only genuinely new or changed files trigger updates.

### Commit mode

```bash
ctx ./my-app --commits 3
```

Same as update mode but uses `git diff HEAD~3` instead of uncommitted changes. Useful in CI or after a batch of commits.

---

## JSONC Translator Notes

For buckets using `.jsonc` files, ctx injects per-key translator notes directly into the source file:

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

lingo.dev reads these comments during translation and passes them to the LLM alongside the string. No extra config needed — lingo.dev natively supports JSONC.

Notes are generated from your `lingo-context.md` so they're consistent with your global tone and audience. On update runs, only changed `.jsonc` files get re-annotated.

---

## Review Before Writing

ctx never writes silently. Before updating `lingo-context.md` or injecting JSONC comments, it shows you a preview and asks:

```
────────────────────────────────────────────────────────────
  Review: lingo-context.md
────────────────────────────────────────────────────────────
## App
A B2B SaaS platform for managing compliance workflows...

## Tone & Voice
Formal, precise. Use "you" not "we"...
...
────────────────────────────────────────────────────────────
❯ Accept
  Request changes
  Skip
```

Choosing **Request changes** opens a prompt. Your feedback is sent back to the agent with the full project context — it revises and shows you the result again. Repeat until it's right.

---

## Requirements

- [Bun](https://bun.sh) v1.0+
- Anthropic API key (`ANTHROPIC_API_KEY`)
- A [lingo.dev](https://lingo.dev) project with `i18n.json`

---

## Built for lingo.dev

ctx is designed around how lingo.dev actually works:

- Reads `i18n.json` to find bucket file patterns and locale configuration
- Supports both `{locale: {source, targets}}` and flat `{locale, locales}` schema formats
- Filters changed files to source locale bucket files only — no noise
- Expands untracked directories from `git status` (handles new locale folders correctly)
- Validates that `i18n.json` exists before running and exits with a helpful message if not

---

*Built for the lingo.dev hackathon.*
