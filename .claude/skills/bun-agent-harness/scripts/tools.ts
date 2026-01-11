/**
 * Tool definitions for the agent harness
 * 
 * Each tool has:
 * - name: Unique identifier
 * - description: LLM-readable purpose (detailed for better tool selection)
 * - parameters: JSON Schema for arguments
 * - handler: Async function that executes the tool
 */

import type { ChatCompletionTool } from "openai/resources/chat/completions";
import { resolve, dirname } from "path";
import { existsSync, mkdirSync, readdirSync, statSync } from "fs";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface Tool {
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
  handler: (args: Record<string, unknown>) => Promise<unknown>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Path Resolution
// ─────────────────────────────────────────────────────────────────────────────

function resolvePath(path: string): string {
  if (path.startsWith("~")) {
    path = path.replace("~", process.env.HOME ?? "");
  }
  return resolve(process.cwd(), path);
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool: read_file
// ─────────────────────────────────────────────────────────────────────────────

const readFile: Tool = {
  name: "read_file",
  description: `Read the complete contents of a file at the specified path. 
Returns the file path and its full text content. 
Use this to understand existing code before making edits.
The path can be absolute or relative to the current working directory.`,
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Path to the file to read (absolute or relative)",
      },
    },
    required: ["path"],
  },
  handler: async ({ path }) => {
    const fullPath = resolvePath(path as string);
    
    if (!existsSync(fullPath)) {
      return { path: fullPath, error: "File not found" };
    }
    
    try {
      const content = await Bun.file(fullPath).text();
      return { path: fullPath, content };
    } catch (error) {
      return { path: fullPath, error: String(error) };
    }
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Tool: list_files
// ─────────────────────────────────────────────────────────────────────────────

const listFiles: Tool = {
  name: "list_files",
  description: `List all files and directories at the specified path.
Returns an array of entries with name and type (file or dir).
Use this to explore project structure before reading specific files.`,
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Directory path to list (defaults to current directory)",
      },
    },
    required: ["path"],
  },
  handler: async ({ path }) => {
    const fullPath = resolvePath((path as string) || ".");
    
    if (!existsSync(fullPath)) {
      return { path: fullPath, error: "Directory not found" };
    }
    
    try {
      const entries = readdirSync(fullPath).map((name) => {
        const entryPath = `${fullPath}/${name}`;
        const stat = statSync(entryPath);
        return {
          name,
          type: stat.isDirectory() ? "dir" : "file",
          size: stat.isFile() ? stat.size : undefined,
        };
      });
      
      return { path: fullPath, entries };
    } catch (error) {
      return { path: fullPath, error: String(error) };
    }
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Tool: edit_file
// ─────────────────────────────────────────────────────────────────────────────

const editFile: Tool = {
  name: "edit_file",
  description: `Edit a file using string replacement.
- To CREATE a new file: use old_str="" and put the full content in new_str
- To EDIT existing file: put the EXACT text to replace in old_str, replacement in new_str
- To DELETE text: put text to remove in old_str, use new_str=""

IMPORTANT: old_str must match EXACTLY including whitespace and newlines.
If edit fails with "not_found", re-read the file to get the exact text.
Only the first occurrence of old_str is replaced.`,
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Path to the file to edit or create",
      },
      old_str: {
        type: "string",
        description: "Exact text to find and replace (empty string to create new file)",
      },
      new_str: {
        type: "string",
        description: "Text to replace old_str with",
      },
    },
    required: ["path", "old_str", "new_str"],
  },
  handler: async ({ path, old_str, new_str }) => {
    const fullPath = resolvePath(path as string);
    const oldStr = old_str as string;
    const newStr = new_str as string;
    
    // Create new file
    if (oldStr === "") {
      try {
        // Ensure parent directory exists
        const dir = dirname(fullPath);
        if (!existsSync(dir)) {
          mkdirSync(dir, { recursive: true });
        }
        
        await Bun.write(fullPath, newStr);
        return { path: fullPath, action: "created", bytes: newStr.length };
      } catch (error) {
        return { path: fullPath, action: "error", error: String(error) };
      }
    }
    
    // Edit existing file
    if (!existsSync(fullPath)) {
      return { 
        path: fullPath, 
        action: "not_found", 
        error: "File does not exist. Use empty old_str to create." 
      };
    }
    
    try {
      const content = await Bun.file(fullPath).text();
      
      if (!content.includes(oldStr)) {
        // Provide helpful context for debugging
        const preview = content.slice(0, 200);
        return { 
          path: fullPath, 
          action: "not_found", 
          error: "old_str not found in file. Re-read the file for exact text.",
          preview: preview + (content.length > 200 ? "..." : ""),
        };
      }
      
      // Replace first occurrence only
      const newContent = content.replace(oldStr, newStr);
      await Bun.write(fullPath, newContent);
      
      return { 
        path: fullPath, 
        action: "edited",
        replaced: oldStr.length,
        inserted: newStr.length,
      };
    } catch (error) {
      return { path: fullPath, action: "error", error: String(error) };
    }
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Tool: bash (optional, commented by default for safety)
// ─────────────────────────────────────────────────────────────────────────────

const bash: Tool = {
  name: "bash",
  description: `Execute a shell command and return stdout/stderr.
Use for: running tests, installing packages, git operations, build commands.
Avoid: destructive operations without user confirmation.`,
  parameters: {
    type: "object",
    properties: {
      command: {
        type: "string",
        description: "The shell command to execute",
      },
    },
    required: ["command"],
  },
  handler: async ({ command }) => {
    try {
      const proc = Bun.spawn(["bash", "-c", command as string], {
        stdout: "pipe",
        stderr: "pipe",
      });
      
      const stdout = await new Response(proc.stdout).text();
      const stderr = await new Response(proc.stderr).text();
      await proc.exited;
      
      return {
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        exitCode: proc.exitCode,
      };
    } catch (error) {
      return { error: String(error), exitCode: 1 };
    }
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Tool Registry
// ─────────────────────────────────────────────────────────────────────────────

// Core tools - minimal set for coding agent
export const tools: Tool[] = [
  readFile,
  listFiles,
  editFile,
  // Uncomment to enable bash:
  // bash,
];

// Build tool name → handler map
const toolRegistry = new Map<string, Tool["handler"]>(
  tools.map((t) => [t.name, t.handler])
);

// ─────────────────────────────────────────────────────────────────────────────
// Exports
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Generate OpenAI-compatible tool schemas
 */
export function getToolSchemas(): ChatCompletionTool[] {
  return tools.map((tool) => ({
    type: "function" as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }));
}

/**
 * Execute a tool by name with given arguments
 */
export async function executeToolCall(
  name: string,
  args: Record<string, unknown>
): Promise<unknown> {
  const handler = toolRegistry.get(name);
  
  if (!handler) {
    return { error: `Unknown tool: ${name}` };
  }
  
  try {
    return await handler(args);
  } catch (error) {
    return { 
      error: String(error),
      suggestion: "Check arguments and retry",
    };
  }
}
