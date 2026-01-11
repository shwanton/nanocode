#!/usr/bin/env bun
/**
 * Minimal Claude Code-style agent harness
 * 
 * Usage:
 *   bun run agent.ts
 *   bun run agent.ts --test
 * 
 * Environment:
 *   OPENAI_BASE_URL - LM Studio endpoint (default: http://localhost:1234/v1)
 *   OPENAI_API_KEY  - API key (default: "lm-studio")
 *   MODEL           - Model name (default: "local-model")
 */

import OpenAI from "openai";
import type { ChatCompletionMessageParam, ChatCompletionTool } from "openai/resources/chat/completions";
import { tools, executeToolCall, getToolSchemas } from "./tools";

// ─────────────────────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────────────────────

const client = new OpenAI({
  baseURL: process.env.OPENAI_BASE_URL ?? "http://localhost:1234/v1",
  apiKey: process.env.OPENAI_API_KEY ?? "lm-studio",
});

const MODEL = process.env.MODEL ?? "local-model";
const MAX_ITERATIONS = 20;

// ─────────────────────────────────────────────────────────────────────────────
// System Prompt
// ─────────────────────────────────────────────────────────────────────────────

function buildSystemPrompt(): string {
  const toolDescriptions = tools
    .map((t) => `- ${t.name}: ${t.description}`)
    .join("\n");

  return `You are a coding agent with filesystem access.

Available tools:
${toolDescriptions}

RULES:
1. ALWAYS read files before editing to understand current state
2. Use edit_file with EXACT old_str matches (whitespace matters)
3. For new files, use empty old_str: ""
4. If edit fails (not_found), re-read the file and retry with correct old_str
5. Explain your changes after completing the task
6. Use list_files to explore unfamiliar directories

Current working directory: ${process.cwd()}

Think step by step. Read before you write. Verify your edits.`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Agent Loop
// ─────────────────────────────────────────────────────────────────────────────

async function runAgent(userMessage: string): Promise<string> {
  const messages: ChatCompletionMessageParam[] = [
    { role: "system", content: buildSystemPrompt() },
    { role: "user", content: userMessage },
  ];

  const toolSchemas = getToolSchemas();
  let iterations = 0;

  while (iterations < MAX_ITERATIONS) {
    iterations++;

    const response = await client.chat.completions.create({
      model: MODEL,
      messages,
      tools: toolSchemas,
      tool_choice: "auto",
    });

    const choice = response.choices[0];
    const assistantMessage = choice.message;

    // Append assistant response to history
    messages.push(assistantMessage);

    // Check for tool calls
    if (!assistantMessage.tool_calls?.length) {
      // No tools requested - agent is done
      return assistantMessage.content ?? "(no response)";
    }

    // Execute each tool call
    console.log(`\n[iter ${iterations}] Executing ${assistantMessage.tool_calls.length} tool(s)...`);

    for (const toolCall of assistantMessage.tool_calls) {
      const name = toolCall.function.name;
      const args = JSON.parse(toolCall.function.arguments);

      console.log(`  → ${name}(${JSON.stringify(args)})`);

      const result = await executeToolCall(name, args);
      
      console.log(`  ← ${truncate(JSON.stringify(result), 100)}`);

      // Append tool result to history
      messages.push({
        role: "tool",
        tool_call_id: toolCall.id,
        content: JSON.stringify(result),
      });
    }
  }

  return `[Agent stopped after ${MAX_ITERATIONS} iterations]`;
}

// ─────────────────────────────────────────────────────────────────────────────
// REPL Interface
// ─────────────────────────────────────────────────────────────────────────────

const COLORS = {
  you: "\x1b[94m",
  agent: "\x1b[93m",
  reset: "\x1b[0m",
};

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + "..." : s;
}

async function repl() {
  console.log("Agent ready. Type your request (Ctrl+C to exit).\n");

  const reader = Bun.stdin.stream().getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  process.stdout.write(`${COLORS.you}You:${COLORS.reset} `);

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value);
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      const input = line.trim();
      if (!input) {
        process.stdout.write(`${COLORS.you}You:${COLORS.reset} `);
        continue;
      }

      if (input.toLowerCase() === "exit" || input.toLowerCase() === "quit") {
        console.log("Goodbye!");
        process.exit(0);
      }

      try {
        const response = await runAgent(input);
        console.log(`\n${COLORS.agent}Agent:${COLORS.reset} ${response}\n`);
      } catch (error) {
        console.error(`\n[Error] ${error}`);
      }

      process.stdout.write(`${COLORS.you}You:${COLORS.reset} `);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Test Mode
// ─────────────────────────────────────────────────────────────────────────────

async function runTests() {
  console.log("Running agent tests...\n");

  const tests = [
    "Create a file called test-output.txt with the text 'Hello from agent'",
    "Read test-output.txt and tell me what it contains",
    "Edit test-output.txt to change 'Hello' to 'Greetings'",
    "List all files in the current directory",
  ];

  for (const test of tests) {
    console.log(`\n${"─".repeat(60)}`);
    console.log(`Test: ${test}`);
    console.log("─".repeat(60));
    
    try {
      const result = await runAgent(test);
      console.log(`\nResult: ${result}`);
    } catch (error) {
      console.error(`Error: ${error}`);
    }
  }

  // Cleanup
  try {
    await Bun.$`rm -f test-output.txt`;
  } catch {}

  console.log("\n\nTests complete.");
}

// ─────────────────────────────────────────────────────────────────────────────
// Entry Point
// ─────────────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);

if (args.includes("--test")) {
  await runTests();
} else {
  await repl();
}
