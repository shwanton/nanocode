# Agent Loop Implementation

Deep dive into the agent loop architecture, control flow, and production considerations.

## Core Loop Pattern

The agent loop is a **reducer over messages**—each iteration transforms the message array by appending LLM responses and tool results until the LLM responds without tool calls.

```typescript
type AgentState = ChatCompletionMessageParam[];

function agentReducer(
  state: AgentState,
  event: LLMResponse | ToolResult
): AgentState {
  return [...state, event];
}
```

This stateless reducer pattern enables:
- **Serialization**: Save/restore agent state as JSON
- **Replay**: Debug by replaying message sequence
- **Branching**: Fork agent state for parallel exploration

## Complete Loop Implementation

```typescript
interface AgentConfig {
  client: OpenAI;
  model: string;
  tools: Tool[];
  systemPrompt: string;
  maxIterations?: number;
  onToolCall?: (name: string, args: unknown) => void;
  onToolResult?: (name: string, result: unknown) => void;
}

async function runAgentLoop(
  config: AgentConfig,
  userMessage: string
): Promise<AgentResult> {
  const {
    client,
    model,
    tools,
    systemPrompt,
    maxIterations = 20,
    onToolCall,
    onToolResult,
  } = config;

  const toolSchemas = tools.map(t => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));

  const messages: ChatCompletionMessageParam[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userMessage },
  ];

  let iterations = 0;
  const toolCalls: ToolCallRecord[] = [];

  while (iterations < maxIterations) {
    iterations++;

    const response = await client.chat.completions.create({
      model,
      messages,
      tools: toolSchemas,
      tool_choice: "auto",
    });

    const choice = response.choices[0];
    messages.push(choice.message);

    // Terminal condition: no tool calls
    if (!choice.message.tool_calls?.length) {
      return {
        success: true,
        content: choice.message.content ?? "",
        iterations,
        toolCalls,
        messages,
      };
    }

    // Execute tool calls
    for (const call of choice.message.tool_calls) {
      const name = call.function.name;
      const args = JSON.parse(call.function.arguments);

      onToolCall?.(name, args);

      const tool = tools.find(t => t.name === name);
      let result: unknown;

      if (!tool) {
        result = { error: `Unknown tool: ${name}` };
      } else {
        try {
          result = await tool.handler(args);
        } catch (error) {
          result = { error: String(error) };
        }
      }

      onToolResult?.(name, result);

      toolCalls.push({ name, args, result });
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: JSON.stringify(result),
      });
    }
  }

  return {
    success: false,
    content: `Agent stopped after ${maxIterations} iterations`,
    iterations,
    toolCalls,
    messages,
  };
}
```

## Termination Conditions

The loop terminates when:

1. **No tool calls**: LLM responds with content only (success)
2. **Max iterations**: Prevents infinite loops (configurable)
3. **Stop signal**: External abort (e.g., user cancellation)
4. **Fatal error**: Unrecoverable LLM or tool failure

```typescript
// Add abort signal support
async function runAgentLoop(
  config: AgentConfig,
  userMessage: string,
  signal?: AbortSignal
): Promise<AgentResult> {
  // ...
  while (iterations < maxIterations) {
    if (signal?.aborted) {
      return {
        success: false,
        content: "Agent aborted by user",
        // ...
      };
    }
    // ...
  }
}
```

## Parallel Tool Execution

When the LLM returns multiple tool calls, execute them in parallel:

```typescript
// Sequential (default, safer)
for (const call of choice.message.tool_calls) {
  const result = await executeToolCall(call);
  messages.push({ role: "tool", tool_call_id: call.id, content: result });
}

// Parallel (faster, requires independent tools)
const results = await Promise.all(
  choice.message.tool_calls.map(async (call) => {
    const result = await executeToolCall(call);
    return { id: call.id, result };
  })
);

for (const { id, result } of results) {
  messages.push({ role: "tool", tool_call_id: id, content: result });
}
```

**Caution**: Only parallelize when tools are independent. File edits must be sequential.

## Error Recovery

Compact errors into context for self-correction:

```typescript
async function executeToolWithRecovery(
  tool: Tool,
  args: Record<string, unknown>,
  maxRetries = 2
): Promise<unknown> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await tool.handler(args);
    } catch (error) {
      lastError = error as Error;
      
      // Don't retry on validation errors
      if (error instanceof ValidationError) {
        break;
      }
      
      // Exponential backoff for transient errors
      if (attempt < maxRetries) {
        await sleep(100 * Math.pow(2, attempt));
      }
    }
  }

  return {
    error: lastError?.message ?? "Unknown error",
    attempts: maxRetries + 1,
    suggestion: getSuggestionForError(lastError),
  };
}

function getSuggestionForError(error: Error | null): string {
  if (error?.message.includes("not found")) {
    return "Re-read the file to verify its contents";
  }
  if (error?.message.includes("permission")) {
    return "Check file permissions";
  }
  return "Verify arguments and retry";
}
```

## Context Window Management

For long-running agents, implement context compaction:

```typescript
const MAX_MESSAGES = 50;
const SUMMARY_THRESHOLD = 40;

async function compactContext(
  messages: ChatCompletionMessageParam[],
  client: OpenAI
): Promise<ChatCompletionMessageParam[]> {
  if (messages.length < SUMMARY_THRESHOLD) {
    return messages;
  }

  const systemMessage = messages[0];
  const recentMessages = messages.slice(-10);
  const oldMessages = messages.slice(1, -10);

  // Summarize old context
  const summary = await client.chat.completions.create({
    model: "gpt-4o-mini", // Use fast model for summarization
    messages: [
      {
        role: "system",
        content: "Summarize this conversation context concisely. Focus on: files modified, key decisions made, current task state.",
      },
      ...oldMessages,
    ],
    max_tokens: 500,
  });

  return [
    systemMessage,
    {
      role: "assistant",
      content: `[Previous context summary]\n${summary.choices[0].message.content}`,
    },
    ...recentMessages,
  ];
}
```

## Streaming Responses

For better UX, stream the final response:

```typescript
async function* runAgentLoopStreaming(
  config: AgentConfig,
  userMessage: string
): AsyncGenerator<AgentEvent> {
  // ... setup ...

  while (iterations < maxIterations) {
    const stream = await client.chat.completions.create({
      model,
      messages,
      tools: toolSchemas,
      stream: true,
    });

    let content = "";
    let toolCalls: ToolCall[] = [];

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta;
      
      if (delta?.content) {
        content += delta.content;
        yield { type: "content", content: delta.content };
      }
      
      if (delta?.tool_calls) {
        // Accumulate tool call deltas
        // (complex, see OpenAI streaming docs)
      }
    }

    if (toolCalls.length === 0) {
      yield { type: "done", content };
      return;
    }

    for (const call of toolCalls) {
      yield { type: "tool_call", name: call.name, args: call.args };
      const result = await executeToolCall(call);
      yield { type: "tool_result", name: call.name, result };
      messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result) });
    }
  }
}
```

## Observability

Add structured logging for debugging and monitoring:

```typescript
interface AgentLogger {
  iteration(n: number): void;
  llmRequest(messages: unknown[]): void;
  llmResponse(response: unknown): void;
  toolCall(name: string, args: unknown): void;
  toolResult(name: string, result: unknown): void;
  error(error: Error): void;
}

const jsonLogger: AgentLogger = {
  iteration: (n) => console.log(JSON.stringify({ event: "iteration", n })),
  llmRequest: (messages) => console.log(JSON.stringify({ event: "llm_request", message_count: messages.length })),
  // ...
};
```

## Testing the Loop

```typescript
import { describe, it, expect, mock } from "bun:test";

describe("Agent Loop", () => {
  it("terminates on final answer", async () => {
    const mockClient = {
      chat: {
        completions: {
          create: mock(() => ({
            choices: [{ message: { content: "Done!" } }],
          })),
        },
      },
    };

    const result = await runAgentLoop(
      { client: mockClient as any, /* ... */ },
      "Hello"
    );

    expect(result.success).toBe(true);
    expect(result.iterations).toBe(1);
  });

  it("executes tools and continues", async () => {
    // ...
  });

  it("respects max iterations", async () => {
    // ...
  });
});
```
