# TODO System for Agent Persistence

Claude Code's reliability comes from explicit TODO tracking with context window reinjection. This document covers implementation patterns for persistent task state.

## Why TODOs Matter

Without explicit task tracking, agents suffer from:
- **Task drift**: LLM forgets original goal mid-execution
- **Context loss**: Summarization drops critical details
- **Retry failure**: No recovery point after errors

Claude Code solves this with TODO tools that externalize task state to filesystem, then reinject on each turn.

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    Agent Loop                           │
├─────────────────────────────────────────────────────────┤
│  1. Load TODO state from .agent/todo.json               │
│  2. Inject into system prompt                           │
│  3. LLM generates response + optional TodoWrite         │
│  4. Execute tools (including TodoWrite)                 │
│  5. Persist updated TODO state                          │
│  6. Loop until task complete                            │
└─────────────────────────────────────────────────────────┘
```

## TODO Data Model

```typescript
interface TodoItem {
  id: string;
  content: string;
  status: "pending" | "in_progress" | "completed" | "blocked";
  priority: "high" | "medium" | "low";
  createdAt: string;
  updatedAt: string;
  metadata?: Record<string, unknown>;
}

interface TodoState {
  version: 1;
  items: TodoItem[];
  currentTask?: string;
  context?: string;
}
```

## TODO Tools

### todo_read

```typescript
const todoRead: Tool = {
  name: "todo_read",
  description: "Read current TODO list and task state",
  parameters: { type: "object", properties: {}, required: [] },
  handler: async () => {
    const path = ".agent/todo.json";
    if (!existsSync(path)) {
      return { items: [], message: "No TODOs yet" };
    }
    const state: TodoState = JSON.parse(await Bun.file(path).text());
    return state;
  }
};
```

### todo_write

```typescript
const todoWrite: Tool = {
  name: "todo_write",
  description: `Update TODO list. Actions:
- add: Create new TODO item
- update: Change status/content of existing item  
- remove: Delete completed item
- set_current: Mark item as active task`,
  parameters: {
    type: "object",
    properties: {
      action: { 
        type: "string", 
        enum: ["add", "update", "remove", "set_current"] 
      },
      id: { type: "string", description: "Item ID (for update/remove)" },
      content: { type: "string", description: "TODO content (for add/update)" },
      status: { type: "string", enum: ["pending", "in_progress", "completed", "blocked"] },
      priority: { type: "string", enum: ["high", "medium", "low"] }
    },
    required: ["action"]
  },
  handler: async ({ action, id, content, status, priority }) => {
    const path = ".agent/todo.json";
    
    // Load or initialize state
    let state: TodoState = existsSync(path)
      ? JSON.parse(await Bun.file(path).text())
      : { version: 1, items: [] };

    const now = new Date().toISOString();

    switch (action) {
      case "add":
        const newItem: TodoItem = {
          id: `todo-${Date.now()}`,
          content: content ?? "",
          status: "pending",
          priority: (priority as TodoItem["priority"]) ?? "medium",
          createdAt: now,
          updatedAt: now
        };
        state.items.push(newItem);
        return { action: "added", item: newItem };

      case "update":
        const item = state.items.find(i => i.id === id);
        if (!item) return { error: "Item not found", id };
        if (content) item.content = content;
        if (status) item.status = status as TodoItem["status"];
        if (priority) item.priority = priority as TodoItem["priority"];
        item.updatedAt = now;
        return { action: "updated", item };

      case "remove":
        const idx = state.items.findIndex(i => i.id === id);
        if (idx === -1) return { error: "Item not found", id };
        const removed = state.items.splice(idx, 1)[0];
        return { action: "removed", item: removed };

      case "set_current":
        state.currentTask = id;
        return { action: "set_current", currentTask: id };
    }

    // Persist
    await Bun.write(path, JSON.stringify(state, null, 2));
    return state;
  }
};
```

## System Prompt Injection

Inject TODO state into every LLM call:

```typescript
function buildSystemPromptWithTodos(basPrompt: string): string {
  const todoPath = ".agent/todo.json";
  
  if (!existsSync(todoPath)) {
    return basePrompt;
  }

  const state: TodoState = JSON.parse(
    readFileSync(todoPath, "utf-8")
  );

  const todoSection = formatTodosForPrompt(state);
  
  return `${basePrompt}

## Current Task State

${todoSection}

IMPORTANT: Update TODO status as you complete items using todo_write.
If you're blocked, mark the item as blocked and explain why.`;
}

function formatTodosForPrompt(state: TodoState): string {
  if (state.items.length === 0) {
    return "No pending TODOs.";
  }

  const current = state.currentTask 
    ? state.items.find(i => i.id === state.currentTask)
    : null;

  let output = "";

  if (current) {
    output += `**Current Task**: ${current.content}\n\n`;
  }

  const pending = state.items.filter(i => i.status !== "completed");
  if (pending.length > 0) {
    output += "**Pending TODOs**:\n";
    for (const item of pending) {
      const marker = item.id === state.currentTask ? "→" : "-";
      const statusIcon = {
        pending: "○",
        in_progress: "◐",
        completed: "●",
        blocked: "⊘"
      }[item.status];
      output += `${marker} [${statusIcon}] ${item.content} (${item.priority})\n`;
    }
  }

  return output;
}
```

## Context Window Reinjection Pattern

The key insight: TODO state survives context compaction because it's regenerated from filesystem on each turn.

```typescript
async function agentLoopWithTodos(userMessage: string) {
  const messages: ChatCompletionMessageParam[] = [];
  
  while (true) {
    // Regenerate system prompt with current TODOs
    const systemPrompt = buildSystemPromptWithTodos(BASE_PROMPT);
    
    // Always fresh system message
    messages[0] = { role: "system", content: systemPrompt };
    
    // ... rest of loop
  }
}
```

Even if the conversation history is truncated/summarized, the TODO state is restored from `.agent/todo.json`.

## File-Based Plan Persistence

For larger projects, use a full `PLAN.md`:

```typescript
const PLAN_TEMPLATE = `# Project Plan

## Goal
{{goal}}

## Current Phase
{{phase}}

## Completed Steps
{{completed}}

## Next Steps
{{next_steps}}

## Blockers
{{blockers}}

## Notes
{{notes}}
`;

const updatePlan: Tool = {
  name: "update_plan",
  description: "Update project plan with progress",
  parameters: {
    type: "object",
    properties: {
      section: { type: "string", enum: ["phase", "completed", "next_steps", "blockers", "notes"] },
      content: { type: "string" }
    },
    required: ["section", "content"]
  },
  handler: async ({ section, content }) => {
    const path = ".agent/PLAN.md";
    let plan = existsSync(path) 
      ? await Bun.file(path).text()
      : PLAN_TEMPLATE;
    
    // Update section (simplified - real impl needs proper parsing)
    plan = plan.replace(
      new RegExp(`## ${section}\\n[\\s\\S]*?(?=\\n## |$)`, "i"),
      `## ${section}\n${content}\n\n`
    );
    
    await Bun.write(path, plan);
    return { updated: section };
  }
};
```

## Checkpoint and Recovery

Save full agent state for recovery:

```typescript
interface AgentCheckpoint {
  id: string;
  timestamp: string;
  messages: ChatCompletionMessageParam[];
  todoState: TodoState;
  workingDirectory: string;
  metadata?: Record<string, unknown>;
}

async function saveCheckpoint(
  messages: ChatCompletionMessageParam[],
  metadata?: Record<string, unknown>
): Promise<string> {
  const checkpoint: AgentCheckpoint = {
    id: `cp-${Date.now()}`,
    timestamp: new Date().toISOString(),
    messages,
    todoState: await loadTodoState(),
    workingDirectory: process.cwd(),
    metadata
  };

  const path = `.agent/checkpoints/${checkpoint.id}.json`;
  await Bun.write(path, JSON.stringify(checkpoint, null, 2));
  
  return checkpoint.id;
}

async function restoreCheckpoint(id: string): Promise<AgentCheckpoint> {
  const path = `.agent/checkpoints/${id}.json`;
  return JSON.parse(await Bun.file(path).text());
}
```

## Integration with Agent Loop

```typescript
const TOOLS_WITH_TODOS = [
  readFile,
  listFiles,
  editFile,
  todoRead,
  todoWrite,
];

async function runAgentWithTodos(initialMessage: string) {
  // Initialize TODO with initial task
  await executeToolCall("todo_write", {
    action: "add",
    content: initialMessage,
    priority: "high"
  });
  await executeToolCall("todo_write", {
    action: "set_current",
    id: "todo-" + Date.now()
  });

  return runAgentLoop({
    tools: TOOLS_WITH_TODOS,
    systemPrompt: buildSystemPromptWithTodos(BASE_PROMPT),
    // ...
  }, initialMessage);
}
```

## Best Practices

1. **Atomicity**: Each TODO represents a single, verifiable action
2. **Hierarchy**: Use subtasks for complex multi-step operations
3. **Status hygiene**: Mark items in_progress before starting, completed after
4. **Blocking clarity**: When blocked, include what's needed to unblock
5. **Pruning**: Remove completed items after successful verification
6. **Checkpoints**: Save checkpoint before destructive operations

## Example Session

```
User: Add authentication to the Express app

Agent:
1. todo_write(add, "Add authentication to Express app")
2. todo_write(add, "Install passport and passport-jwt")
3. todo_write(add, "Create auth middleware")
4. todo_write(add, "Add login/logout routes")
5. todo_write(add, "Protect existing routes")
6. todo_write(set_current, "todo-1234")

[System prompt now includes TODO list]

Agent:
7. bash("npm install passport passport-jwt")
8. todo_write(update, "todo-1234", status="completed")
9. todo_write(set_current, "todo-1235")
10. edit_file("src/middleware/auth.ts", "", "...middleware code...")
...
```

The agent maintains explicit task state throughout, surviving any context window manipulation.
