# nanocode

Minimal Claude Code alternative. Single file, zero/minimal dependencies, ~250-300 lines.

Built using Claude Code, then used to build itself.

![screenshot](screenshot.png)

## Versions

| Version | File | Runtime | LLM Provider |
|---------|------|---------|--------------|
| Python | `nanocode.py` | Python 3 | Anthropic API |
| TypeScript | `nanocode.ts` | Bun | OpenAI-compatible (LM Studio, OpenAI, etc.) |

## Features

- Full agentic loop with tool use
- Tools: `read`, `write`, `edit`, `glob`, `grep`, `bash`
- Conversation history
- Colored terminal output

---

## Python Version

Zero dependencies, uses Anthropic API directly.

```bash
export ANTHROPIC_API_KEY="your-key"
python nanocode.py
```

---

## TypeScript Version

Uses Bun runtime with OpenAI-compatible APIs (local LLMs or cloud).

### Installation

```bash
bun install
```

### With LM Studio (default)

1. Download [LM Studio](https://lmstudio.ai) and load a model
2. Start the local server (default: `http://localhost:1234/v1`)
3. Run:

```bash
bun run nanocode.ts
```

### With OpenAI

```bash
OPENAI_BASE_URL="https://api.openai.com/v1" \
OPENAI_API_KEY="sk-..." \
MODEL="gpt-4o" \
bun run nanocode.ts
```

### With Other Providers

```bash
# Ollama
OPENAI_BASE_URL="http://localhost:11434/v1" \
MODEL="qwen2.5-coder" \
bun run nanocode.ts

# Together AI, Groq, etc.
OPENAI_BASE_URL="https://api.together.xyz/v1" \
OPENAI_API_KEY="..." \
MODEL="meta-llama/Llama-3-70b-chat-hf" \
bun run nanocode.ts
```

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `OPENAI_BASE_URL` | `http://localhost:1234/v1` | API endpoint |
| `OPENAI_API_KEY` | `lm-studio` | API key |
| `MODEL` | `local-model` | Model name |

### Recommended Local Models

| Model | Tool Calling | Notes |
|-------|-------------|-------|
| Qwen2.5-Coder-32B | Excellent | Best for complex edits |
| DeepSeek-Coder-V2 | Good | Balanced choice |
| Codestral-22B | Good | Strong at code |

---

## Commands

- `/c` - Clear conversation
- `/q` or `exit` - Quit

## Tools

| Tool | Description |
|------|-------------|
| `read` | Read file with line numbers, offset/limit |
| `write` | Write content to file |
| `edit` | Replace string in file (must be unique, or `all=true`) |
| `glob` | Find files by pattern, sorted by mtime |
| `grep` | Search files for regex |
| `bash` | Run shell command |

## Example

```
────────────────────────────────────────
❯ what files are here?
────────────────────────────────────────

⏺ Glob(**/*.py)
  ⎿  nanocode.py

⏺ There's one Python file: nanocode.py
```

## Architecture

Deterministic message-reducer agentic loop:

1. User input → append to messages
2. Call LLM API with tools
3. For each tool call: execute and collect results
4. Append assistant response + tool results to messages
5. Loop until no tool calls remain

## License

MIT
