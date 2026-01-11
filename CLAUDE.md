# Repository Overview: nanocode

## What It Does
**nanocode** is a minimal, single-file alternative to Claude Code (Anthropic's official CLI). It's a conversational AI coding assistant that runs locally with **zero external dependencies**. The project implements a full agentic loop where Claude can iteratively use tools to interact with the filesystem and run commands.

## Tech Stack
| Component | Technology |
|-----------|------------|
| Language | Python 3 (pure, no dependencies) |
| AI Model | Anthropic Claude API (`claude-opus-4-5`) |
| HTTP | `urllib` (stdlib) |
| Shell | `subprocess` (stdlib) |

## Main Entry Points

**Running the app:**
```bash
export ANTHROPIC_API_KEY="your-key"
python nanocode.py
```

**Interactive commands:**
- `/c` — Clear conversation history
- `/q` or `exit` — Quit

## Project Structure
```
nanocode/
├── nanocode.py      # Entire application (~250 lines)
├── README.md        # Documentation
└── screenshot.png   # UI example
```

## Core Tools Implemented
1. **read** — Read files with line numbers and offset/limit
2. **write** — Write content to files
3. **edit** — Replace text in files
4. **glob** — Find files by pattern
5. **grep** — Search files with regex
6. **bash** — Execute shell commands (30s timeout)

The entire implementation is ~250 lines of pure Python demonstrating a complete AI agent pattern: tool schema generation → API calls → agentic loop → terminal UI with ANSI colors and markdown rendering.
