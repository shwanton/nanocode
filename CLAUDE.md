# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository Purpose

Minimal Claude Code alternative - a single Python file (~250 lines), zero dependencies. Educational reference implementation demonstrating the core agentic loop with tool use. Built using Claude Code, then used to build itself.

## Run

```bash
export ANTHROPIC_API_KEY="your-key"
python nanocode.py
```

No build step or dependencies required.

## Architecture

Single file (`nanocode.py`) implementing a deterministic message-reducer agentic loop:

1. User input → append to messages
2. Call Anthropic API with tools
3. For each tool call: execute and collect results
4. Append assistant response + tool results to messages
5. Loop until no tool calls remain (terminal condition)

### Tool System

Six tools exposed via JSON schemas:
- **read** - File with line numbers, optional offset/limit
- **write** - Create/overwrite file
- **edit** - String replacement (old must be unique, or use `all=true`)
- **glob** - Pattern match, sorted by mtime (newest first)
- **grep** - Regex search, capped at 50 results
- **bash** - Shell command, 30-second timeout

### API Config

- Model: `claude-opus-4-5`
- Max tokens: 8192
- System prompt: `"Concise coding assistant. cwd: {cwd}"`

## Code Structure

| Lines | Section |
|-------|---------|
| 1-17 | Config & ANSI colors |
| 20-82 | Tool implementations |
| 84-151 | Tool schema generation |
| 154-173 | API client (urllib) |
| 176-181 | Terminal utilities |
| 184-255 | REPL and agentic loop |

## Key Patterns

**Edit tool requires exact match** - whitespace sensitive:
```python
if old not in text:
    return "error: old_string not found"
if count > 1 and not args.get("all"):
    return f"error: old_string appears {count} times, must be unique"
```

**Errors returned as context** - not raised, enabling self-correction:
```python
def run_tool(name, args):
    try:
        return TOOLS[name][2](args)
    except Exception as err:
        return f"error: {err}"
```

**Tool schema from definition** - optional params marked with `?`:
```python
{"path": "string", "offset": "number?", "limit": "number?"}
```

## Commands

- `/c` - Clear conversation
- `/q` or `exit` - Quit
