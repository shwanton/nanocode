#!/usr/bin/env bun
/**
 * nanocode.ts - minimal claude code alternative in TypeScript
 *
 * A single-file (~300 lines), minimal coding agent using Bun runtime.
 * Supports local LLMs via LM Studio or cloud APIs via OpenAI-compatible endpoints.
 *
 * Usage:
 *   bun run nanocode.ts
 *
 * Environment:
 *   OPENAI_BASE_URL - API endpoint (default: http://localhost:1234/v1)
 *   OPENAI_API_KEY  - API key (default: "lm-studio")
 *   MODEL           - Model name (default: "local-model")
 */

import { globSync } from "glob";
import { existsSync, readdirSync, statSync, readFileSync, writeFileSync } from "fs";
import { resolve, dirname } from "path";
import { mkdirSync } from "fs";

// ─────────────────────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────────────────────

const API_URL = process.env.OPENAI_BASE_URL ?? "http://localhost:1234/v1";
const API_KEY = process.env.OPENAI_API_KEY ?? "lm-studio";
const MODEL = process.env.MODEL ?? "local-model";

// ANSI colors
const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const BLUE = "\x1b[34m";
const CYAN = "\x1b[36m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";

// ─────────────────────────────────────────────────────────────────────────────
// Tool Implementations
// ─────────────────────────────────────────────────────────────────────────────

function read(args: { path: string; offset?: number; limit?: number }): string {
  const content = readFileSync(args.path, "utf-8");
  const lines = content.split("\n");
  const offset = args.offset ?? 0;
  const limit = args.limit ?? lines.length;
  const selected = lines.slice(offset, offset + limit);
  return selected.map((line, idx) => `${String(offset + idx + 1).padStart(4)}| ${line}`).join("\n");
}

function write(args: { path: string; content: string }): string {
  const dir = dirname(args.path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(args.path, args.content);
  return "ok";
}

function edit(args: { path: string; old: string; new: string; all?: boolean }): string {
  const text = readFileSync(args.path, "utf-8");
  if (!text.includes(args.old)) {
    return "error: old_string not found";
  }
  const count = text.split(args.old).length - 1;
  if (!args.all && count > 1) {
    return `error: old_string appears ${count} times, must be unique (use all=true)`;
  }
  const replacement = args.all ? text.replaceAll(args.old, args.new) : text.replace(args.old, args.new);
  writeFileSync(args.path, replacement);
  return "ok";
}

function glob(args: { pat: string; path?: string }): string {
  const basePath = args.path ?? ".";
  const pattern = `${basePath}/${args.pat}`.replace("//", "/");
  const files = globSync(pattern);
  // Sort by mtime, newest first
  const sorted = files
    .filter((f) => existsSync(f))
    .sort((a, b) => {
      try {
        const statA = statSync(a);
        const statB = statSync(b);
        return statB.mtimeMs - statA.mtimeMs;
      } catch {
        return 0;
      }
    });
  return sorted.join("\n") || "none";
}

function grep(args: { pat: string; path?: string }): string {
  const basePath = args.path ?? ".";
  const pattern = new RegExp(args.pat);
  const hits: string[] = [];

  function searchDir(dir: string) {
    try {
      const entries = readdirSync(dir);
      for (const entry of entries) {
        if (entry.startsWith(".")) continue;
        const fullPath = `${dir}/${entry}`;
        try {
          const stat = statSync(fullPath);
          if (stat.isDirectory()) {
            searchDir(fullPath);
          } else if (stat.isFile()) {
            const content = readFileSync(fullPath, "utf-8");
            const lines = content.split("\n");
            for (let i = 0; i < lines.length && hits.length < 50; i++) {
              if (pattern.test(lines[i])) {
                hits.push(`${fullPath}:${i + 1}:${lines[i].trim()}`);
              }
            }
          }
        } catch {}
      }
    } catch {}
  }

  searchDir(basePath);
  return hits.slice(0, 50).join("\n") || "none";
}

async function bash(args: { cmd: string }): Promise<string> {
  try {
    const proc = Bun.spawn(["bash", "-c", args.cmd], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    await proc.exited;
    return (stdout + stderr).trim() || "(empty)";
  } catch (err) {
    return `error: ${err}`;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool Definitions
// ─────────────────────────────────────────────────────────────────────────────

type ToolFn = (args: Record<string, unknown>) => string | Promise<string>;

interface ToolDef {
  description: string;
  schema: Record<string, string>;
  fn: ToolFn;
}

const TOOLS: Record<string, ToolDef> = {
  read: {
    description: "Read file with line numbers (file path, not directory)",
    schema: { path: "string", offset: "number?", limit: "number?" },
    fn: (args) => read(args as { path: string; offset?: number; limit?: number }),
  },
  write: {
    description: "Write content to file",
    schema: { path: "string", content: "string" },
    fn: (args) => write(args as { path: string; content: string }),
  },
  edit: {
    description: "Replace old with new in file (old must be unique unless all=true)",
    schema: { path: "string", old: "string", new: "string", all: "boolean?" },
    fn: (args) => edit(args as { path: string; old: string; new: string; all?: boolean }),
  },
  glob: {
    description: "Find files by pattern, sorted by mtime",
    schema: { pat: "string", path: "string?" },
    fn: (args) => glob(args as { pat: string; path?: string }),
  },
  grep: {
    description: "Search files for regex pattern",
    schema: { pat: "string", path: "string?" },
    fn: (args) => grep(args as { pat: string; path?: string }),
  },
  bash: {
    description: "Run shell command",
    schema: { cmd: "string" },
    fn: (args) => bash(args as { cmd: string }),
  },
};

function runTool(name: string, args: Record<string, unknown>): string | Promise<string> {
  try {
    const tool = TOOLS[name];
    if (!tool) return `error: unknown tool ${name}`;
    return tool.fn(args);
  } catch (err) {
    return `error: ${err}`;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Schema Generation (OpenAI format)
// ─────────────────────────────────────────────────────────────────────────────

interface ToolSchema {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: {
      type: "object";
      properties: Record<string, { type: string }>;
      required: string[];
    };
  };
}

function makeSchema(): ToolSchema[] {
  return Object.entries(TOOLS).map(([name, { description, schema }]) => {
    const properties: Record<string, { type: string }> = {};
    const required: string[] = [];

    for (const [paramName, paramType] of Object.entries(schema)) {
      const isOptional = paramType.endsWith("?");
      const baseType = paramType.replace("?", "");
      properties[paramName] = { type: baseType === "number" ? "integer" : baseType };
      if (!isOptional) required.push(paramName);
    }

    return {
      type: "function" as const,
      function: {
        name,
        description,
        parameters: {
          type: "object" as const,
          properties,
          required,
        },
      },
    };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// API Client (OpenAI-compatible)
// ─────────────────────────────────────────────────────────────────────────────

interface Message {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

interface APIResponse {
  choices: Array<{
    message: {
      role: "assistant";
      content: string | null;
      tool_calls?: ToolCall[];
    };
  }>;
}

async function callAPI(messages: Message[], systemPrompt: string): Promise<APIResponse> {
  const fullMessages: Message[] = [{ role: "system", content: systemPrompt }, ...messages];

  const response = await fetch(`${API_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${API_KEY}`,
    },
    body: JSON.stringify({
      model: MODEL,
      messages: fullMessages,
      tools: makeSchema(),
      tool_choice: "auto",
      max_tokens: 8192,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`API error ${response.status}: ${text}`);
  }

  return response.json();
}

// ─────────────────────────────────────────────────────────────────────────────
// Terminal Utilities
// ─────────────────────────────────────────────────────────────────────────────

function separator(): string {
  const cols = process.stdout.columns ?? 80;
  return `${DIM}${"─".repeat(Math.min(cols, 80))}${RESET}`;
}

function renderMarkdown(text: string): string {
  return text.replace(/\*\*(.+?)\*\*/g, `${BOLD}$1${RESET}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// REPL and Agentic Loop
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`${BOLD}nanocode.ts${RESET} | ${DIM}${MODEL} | ${process.cwd()}${RESET}\n`);

  const messages: Message[] = [];
  const systemPrompt = `Concise coding assistant. cwd: ${process.cwd()}`;

  const reader = Bun.stdin.stream().getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    try {
      console.log(separator());
      process.stdout.write(`${BOLD}${BLUE}❯${RESET} `);

      // Read line from stdin
      let line = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          console.log();
          process.exit(0);
        }
        buffer += decoder.decode(value);
        const newlineIdx = buffer.indexOf("\n");
        if (newlineIdx !== -1) {
          line = buffer.slice(0, newlineIdx).trim();
          buffer = buffer.slice(newlineIdx + 1);
          break;
        }
      }

      console.log(separator());

      if (!line) continue;
      if (line === "/q" || line === "exit") break;
      if (line === "/c") {
        messages.length = 0;
        console.log(`${GREEN}⏺ Cleared conversation${RESET}`);
        continue;
      }

      messages.push({ role: "user", content: line });

      // Agentic loop: keep calling API until no more tool calls
      while (true) {
        const response = await callAPI(messages, systemPrompt);
        const assistantMessage = response.choices[0].message;
        const toolCalls = assistantMessage.tool_calls ?? [];

        // Display text content
        if (assistantMessage.content) {
          console.log(`\n${CYAN}⏺${RESET} ${renderMarkdown(assistantMessage.content)}`);
        }

        // Process tool calls
        const toolResults: Message[] = [];

        for (const call of toolCalls) {
          const toolName = call.function.name;
          const toolArgs = JSON.parse(call.function.arguments);
          const argPreview = String(Object.values(toolArgs)[0]).slice(0, 50);
          console.log(`\n${GREEN}⏺ ${toolName.charAt(0).toUpperCase() + toolName.slice(1)}${RESET}(${DIM}${argPreview}${RESET})`);

          const result = await runTool(toolName, toolArgs);
          const resultStr = String(result);
          const resultLines = resultStr.split("\n");
          let preview = resultLines[0].slice(0, 60);
          if (resultLines.length > 1) {
            preview += ` ... +${resultLines.length - 1} lines`;
          } else if (resultLines[0].length > 60) {
            preview += "...";
          }
          console.log(`  ${DIM}⎿  ${preview}${RESET}`);

          toolResults.push({
            role: "tool",
            tool_call_id: call.id,
            content: resultStr,
          });
        }

        // Append assistant message to history
        messages.push({
          role: "assistant",
          content: assistantMessage.content,
          tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
        });

        // Append tool results
        if (toolResults.length === 0) break;
        messages.push(...toolResults);
      }

      console.log();
    } catch (err) {
      if (err instanceof Error && err.message.includes("stream closed")) {
        break;
      }
      console.log(`${RED}⏺ Error: ${err}${RESET}`);
    }
  }
}

main().catch(console.error);
