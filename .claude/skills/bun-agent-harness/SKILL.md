---
name: bun-agent-harness
description: Build a Claude Code-style coding agent in TypeScript with Bun runtime and local LLM via LM Studio. Use when creating agentic coding assistants, building tool-calling loops, implementing string-replace file editing, or connecting to OpenAI-compatible local models. Triggers include bun agent, local llm agent, lm studio agent, coding agent typescript, tool calling loop, agentic harness, string replace editor.
---

# Bun Agent Harness

Build a minimal, production-ready coding agent in TypeScript using Bun runtime and local LLMs via LM Studio's OpenAI-compatible API.

## Quick Start

```bash
# Initialize project
mkdir my-agent && cd my-agent
bun init -y

# Install dependencies
bun add openai

# Copy the agent scaffold
cp scripts/agent.ts src/
cp scripts/tools.ts src/

# Configure LM Studio endpoint
export OPENAI_BASE_URL="http://localhost:1234/v1"
export OPENAI_API_KEY="lm-studio"

# Run
bun run src/agent.ts
```

## Core Architecture

The agent is a deterministic loop with strategically placed LLM steps:

```
while not done:
  context = assemble_messages()
  response = llm.chat(context)
  if response.tool_calls:
    results = execute_tools(response.tool_calls)
    context.append(results)
  else:
    output_to_user(response)
    break
```

### Key Components

| Component | Purpose | Implementation |
|-----------|---------|----------------|
| Tool Registry | Maps tool names → functions | `Map<string, ToolHandler>` |
| Message History | Accumulates context | `ChatCompletionMessageParam[]` |
| Tool Executor | Runs tools, captures results | Deterministic TypeScript |
| LLM Client | OpenAI-compatible API calls | `openai` package |

## Three Essential Tools

A functional coding agent requires exactly three tools:

### 1. read_file
```typescript
const readFile: Tool = {
  name: "read_file",
  description: "Read the complete contents of a file",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Absolute or relative file path" }
    },
    required: ["path"]
  },
  handler: async ({ path }) => {
    const content = await Bun.file(path).text();
    return { path, content };
  }
};
```

### 2. list_files
```typescript
const listFiles: Tool = {
  name: "list_files", 
  description: "List files and directories at a path",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Directory path to list" }
    },
    required: ["path"]
  },
  handler: async ({ path }) => {
    const entries = [];
    for await (const entry of new Bun.Glob("*").scan({ cwd: path })) {
      const stat = await Bun.file(`${path}/${entry}`).exists();
      entries.push({ name: entry, type: stat ? "file" : "dir" });
    }
    return { path, entries };
  }
};
```

### 3. edit_file (String Replace)
```typescript
const editFile: Tool = {
  name: "edit_file",
  description: "Edit a file using string replacement. Empty old_str creates new file.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path" },
      old_str: { type: "string", description: "Text to find (empty = create file)" },
      new_str: { type: "string", description: "Replacement text" }
    },
    required: ["path", "old_str", "new_str"]
  },
  handler: async ({ path, old_str, new_str }) => {
    if (old_str === "") {
      await Bun.write(path, new_str);
      return { path, action: "created" };
    }
    const content = await Bun.file(path).text();
    if (!content.includes(old_str)) {
      return { path, action: "not_found", error: "old_str not in file" };
    }
    await Bun.write(path, content.replace(old_str, new_str));
    return { path, action: "edited" };
  }
};
```

**Critical**: String-replace is the proven primitive. Models are trained on this pattern—full-file rewrites cause reliability failures.

## System Prompt Template

```typescript
const SYSTEM_PROMPT = `You are a coding agent with filesystem access.

Available tools:
${tools.map(t => `- ${t.name}: ${t.description}`).join('\n')}

RULES:
1. Read files before editing to understand current state
2. Use edit_file with precise old_str matches
3. For new files, use empty old_str
4. Explain your changes after making them
5. If edit fails, re-read the file and retry with correct old_str

Current working directory: ${process.cwd()}`;
```

## LM Studio Configuration

LM Studio exposes an OpenAI-compatible API on `http://localhost:1234/v1`.

```typescript
import OpenAI from "openai";

const client = new OpenAI({
  baseURL: process.env.OPENAI_BASE_URL ?? "http://localhost:1234/v1",
  apiKey: process.env.OPENAI_API_KEY ?? "lm-studio",
});
```

### Model Selection

For local inference, prioritize models with strong tool-calling:

| Model | Tool Calling | Speed | Notes |
|-------|-------------|-------|-------|
| Qwen2.5-Coder-32B | Excellent | Slow | Best for complex edits |
| DeepSeek-Coder-V2 | Good | Medium | Balanced choice |
| Codestral-22B | Good | Medium | Strong at code |
| Llama-3.1-70B | Fair | Slow | Needs explicit prompting |

## Agent Loop Implementation

See [references/AGENT-LOOP.md](references/AGENT-LOOP.md) for the complete 150-line implementation.

Key patterns:

```typescript
async function runAgent(userMessage: string) {
  const messages: ChatCompletionMessageParam[] = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: userMessage }
  ];

  while (true) {
    const response = await client.chat.completions.create({
      model: "local-model",
      messages,
      tools: toolSchemas,
      tool_choice: "auto"
    });

    const choice = response.choices[0];
    messages.push(choice.message);

    if (!choice.message.tool_calls?.length) {
      return choice.message.content;
    }

    for (const call of choice.message.tool_calls) {
      const result = await executeToolCall(call);
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: JSON.stringify(result)
      });
    }
  }
}
```

## 12-Factor Agent Principles Applied

This implementation follows key 12-factor agent patterns:

1. **Own your prompts** — System prompt is explicit, not framework-hidden
2. **Own your context window** — Direct message array manipulation
3. **Tools are structured outputs** — OpenAI function calling schema
4. **Stateless reducer** — Each loop iteration is pure function of messages
5. **Small, focused agents** — Three tools, single responsibility

See [references/12-FACTOR-ALIGNMENT.md](references/12-FACTOR-ALIGNMENT.md) for detailed mapping.

## Extension Points

### Adding TODO Persistence

Claude Code's reliability comes from TODO reinjection. See [references/TODO-SYSTEM.md](references/TODO-SYSTEM.md).

### Multi-Turn Context Compaction

For long sessions, implement summarization:

```typescript
if (messages.length > 50) {
  const summary = await summarizeContext(messages.slice(0, -10));
  messages = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "assistant", content: `Previous context: ${summary}` },
    ...messages.slice(-10)
  ];
}
```

### Bash Tool (Optional)

```typescript
const bash: Tool = {
  name: "bash",
  description: "Execute a shell command",
  parameters: {
    type: "object",
    properties: {
      command: { type: "string" }
    },
    required: ["command"]
  },
  handler: async ({ command }) => {
    const proc = Bun.spawn(["bash", "-c", command]);
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    return { stdout, stderr, exitCode: proc.exitCode };
  }
};
```

## Error Handling

Compact errors into context for self-correction:

```typescript
try {
  result = await tool.handler(args);
} catch (error) {
  result = { 
    error: error.message,
    suggestion: "Re-read the file and check your old_str matches exactly"
  };
}
```

## Testing

```bash
# Run agent in test mode
bun run src/agent.ts --test

# Example prompts to validate:
# "Create hello.ts with a hello world function"
# "Read package.json and add a test script"
# "List all files in src/ and summarize"
```

## Bundled Resources

| File | Purpose |
|------|---------|
| [scripts/agent.ts](scripts/agent.ts) | Complete agent implementation |
| [scripts/tools.ts](scripts/tools.ts) | Tool definitions and handlers |
| [references/AGENT-LOOP.md](references/AGENT-LOOP.md) | Detailed loop implementation |
| [references/12-FACTOR-ALIGNMENT.md](references/12-FACTOR-ALIGNMENT.md) | Principle mapping |
| [references/TODO-SYSTEM.md](references/TODO-SYSTEM.md) | Persistence patterns |
