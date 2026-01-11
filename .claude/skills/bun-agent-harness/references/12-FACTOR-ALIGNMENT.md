# 12-Factor Agent Alignment

How this agent harness maps to 12-factor agent principles for production-grade systems.

## Factor Mapping

### Factor 1: Natural Language to Tool Calls

**Principle**: The LLM's primary job is converting natural language intent into structured tool calls.

**Implementation**:
```typescript
// Tool schema defines the contract
const editFile: Tool = {
  name: "edit_file",
  description: "Edit file using string replacement...",
  parameters: {
    type: "object",
    properties: { path: {...}, old_str: {...}, new_str: {...} },
    required: ["path", "old_str", "new_str"]
  }
};

// LLM output → structured call
{ tool_calls: [{ function: { name: "edit_file", arguments: "{...}" } }] }
```

The LLM transforms "add a hello world function to main.ts" into a precise `edit_file` call.

---

### Factor 2: Own Your Prompts

**Principle**: System prompts are code. Version, test, and iterate on them.

**Implementation**:
```typescript
// Prompt is explicit, testable, versionable
function buildSystemPrompt(): string {
  return `You are a coding agent...
RULES:
1. ALWAYS read files before editing...`;
}

// Test prompt behavior
test("prompt encourages reading before editing", () => {
  const prompt = buildSystemPrompt();
  expect(prompt).toContain("read files before editing");
});
```

No framework magic. The prompt is your code.

---

### Factor 3: Own Your Context Window

**Principle**: Context assembly is the main lever for agent quality.

**Implementation**:
```typescript
// Direct message array manipulation
const messages: ChatCompletionMessageParam[] = [
  { role: "system", content: systemPrompt },
  { role: "user", content: userMessage },
];

// Full control over what goes in
function addRelevantContext(messages, task) {
  // Add project structure
  messages.push({ role: "user", content: `Project files:\n${listFiles(".")}` });
  
  // Add relevant file contents
  for (const file of getRelevantFiles(task)) {
    messages.push({ role: "user", content: `File ${file}:\n${readFile(file)}` });
  }
}
```

You decide what the LLM sees. No hidden context injection.

---

### Factor 4: Tools Are Structured Outputs

**Principle**: Tool calls are just a special case of structured JSON output.

**Implementation**:
```typescript
// OpenAI function calling is structured output
const response = await client.chat.completions.create({
  tools: [{
    type: "function",
    function: {
      name: "edit_file",
      parameters: { /* JSON Schema */ }
    }
  }]
});

// Response is guaranteed to match schema
const args = JSON.parse(response.choices[0].message.tool_calls[0].function.arguments);
// args.path, args.old_str, args.new_str are typed
```

The schema constrains LLM output. Invalid tool calls are impossible.

---

### Factor 5: Unify Execution State

**Principle**: All agent state lives in the context window.

**Implementation**:
```typescript
// State = messages array
const agentState = {
  messages: [
    { role: "system", content: "..." },
    { role: "user", content: "Create hello.ts" },
    { role: "assistant", content: null, tool_calls: [...] },
    { role: "tool", content: '{"path": "hello.ts", "action": "created"}' },
    { role: "assistant", content: "Done! Created hello.ts..." }
  ]
};

// Serialize/restore trivially
await Bun.write("agent-state.json", JSON.stringify(agentState));
const restored = JSON.parse(await Bun.file("agent-state.json").text());
```

No hidden state. Everything is in the message array.

---

### Factor 6: Launch/Pause/Resume

**Principle**: Agent execution should be interruptible and resumable.

**Implementation**:
```typescript
// Save state at any point
async function pauseAgent(state: AgentState): Promise<void> {
  await Bun.write(`agent-${state.id}.json`, JSON.stringify(state));
}

// Resume from saved state
async function resumeAgent(id: string): Promise<AgentResult> {
  const state = JSON.parse(await Bun.file(`agent-${id}.json`).text());
  return runAgentLoop(state.config, state.messages);
}
```

---

### Factor 7: Contact Humans with Tools

**Principle**: Human approval is a tool call like any other.

**Implementation**:
```typescript
const askHuman: Tool = {
  name: "ask_human",
  description: "Ask the user for clarification or approval",
  parameters: {
    type: "object",
    properties: {
      question: { type: "string", description: "Question to ask" },
      options: { type: "array", items: { type: "string" } }
    },
    required: ["question"]
  },
  handler: async ({ question, options }) => {
    console.log(`\n[Agent needs input]: ${question}`);
    if (options) console.log(`Options: ${options.join(", ")}`);
    
    const answer = await prompt("Your answer: ");
    return { answer };
  }
};
```

Human-in-the-loop as a first-class tool.

---

### Factor 8: Own Your Control Flow

**Principle**: Don't let frameworks control when/how the LLM is called.

**Implementation**:
```typescript
// You control the loop
while (iterations < maxIterations) {
  const response = await client.chat.completions.create({...});
  
  // You decide when to stop
  if (shouldStop(response)) break;
  
  // You decide how to handle tool calls
  if (response.tool_calls) {
    // Sequential, parallel, filtered—your choice
    await handleToolCalls(response.tool_calls);
  }
}
```

No magic. No hidden retry logic. No framework decisions.

---

### Factor 9: Compact Errors into Context

**Principle**: Errors become context for self-correction.

**Implementation**:
```typescript
handler: async ({ path, old_str, new_str }) => {
  const content = await Bun.file(path).text();
  
  if (!content.includes(old_str)) {
    // Error becomes helpful context
    return {
      action: "not_found",
      error: "old_str not found in file",
      preview: content.slice(0, 200), // Show actual content
      suggestion: "Re-read the file for exact text"
    };
  }
  // ...
}
```

Errors teach the LLM what went wrong.

---

### Factor 10: Small, Focused Agents

**Principle**: Do one thing well. Compose for complexity.

**Implementation**:
```typescript
// This agent: edit files
const codingAgent = {
  tools: [readFile, listFiles, editFile],
  systemPrompt: "You are a coding agent..."
};

// Different agent: run tests
const testAgent = {
  tools: [bash, readFile],
  systemPrompt: "You run and analyze test results..."
};

// Compose in orchestrator
async function developFeature(spec: string) {
  const plan = await planningAgent.run(spec);
  const code = await codingAgent.run(plan);
  const results = await testAgent.run(code);
  return { plan, code, results };
}
```

---

### Factor 11: Trigger from Anywhere

**Principle**: Agents should be callable via CLI, HTTP, events, etc.

**Implementation**:
```typescript
// CLI
if (process.argv.includes("--cli")) {
  await repl();
}

// HTTP server
if (process.argv.includes("--server")) {
  Bun.serve({
    port: 3000,
    async fetch(req) {
      const { message } = await req.json();
      const result = await runAgent(message);
      return Response.json({ result });
    }
  });
}

// Direct function call
export { runAgent };
```

---

### Factor 12: Stateless Reducer

**Principle**: Agent step = pure function of context.

**Implementation**:
```typescript
// Each step is a pure function
type AgentStep = (messages: Message[]) => Promise<Message[]>;

const step: AgentStep = async (messages) => {
  const response = await llm(messages);
  const newMessages = [...messages, response];
  
  if (response.tool_calls) {
    for (const call of response.tool_calls) {
      const result = await executeTool(call);
      newMessages.push({ role: "tool", content: result });
    }
  }
  
  return newMessages;
};

// Agent = fold over steps
const finalState = await foldSteps(initialMessages, step);
```

No hidden state mutations. Pure transformations.

---

## Summary Table

| Factor | This Implementation |
|--------|---------------------|
| 1. NL → Tool Calls | OpenAI function calling with typed schemas |
| 2. Own Prompts | `buildSystemPrompt()` function, no framework |
| 3. Own Context | Direct `messages[]` array manipulation |
| 4. Tools = Structured | JSON Schema validation on tool params |
| 5. Unified State | All state in message array, serializable |
| 6. Pause/Resume | JSON serialize/deserialize agent state |
| 7. Human Tools | `ask_human` tool for approvals |
| 8. Own Control Flow | Explicit while loop, your termination logic |
| 9. Compact Errors | Error responses include suggestions |
| 10. Small Agents | 3 tools, single purpose |
| 11. Trigger Anywhere | CLI, HTTP, function export |
| 12. Stateless Reducer | Pure step function over messages |
