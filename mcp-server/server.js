#!/usr/bin/env node
// CHIEF MCP Server — shared task queue for OpenClaw + Codex
// Transport: Streamable HTTP on port 8899

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { z } from "zod";
import { randomUUID } from "crypto";
import { execSync } from "child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TASKS_PATH = path.join(__dirname, "..", "tasks.json");
const RESULTS_DIR = path.join(__dirname, "..", "results");
const WORKSPACE = "/Users/angelabusheska/.openclaw/workspace";
const PORT = parseInt(process.env.PORT || "8899");
const USAGE_PATH = path.join(__dirname, "..", "usage.json");

// ── Helpers ──────────────────────────────────────────────────
function loadTasks() {
  if (!fs.existsSync(TASKS_PATH)) return [];
  return JSON.parse(fs.readFileSync(TASKS_PATH, "utf-8"));
}

function saveTasks(tasks) {
  fs.writeFileSync(TASKS_PATH, JSON.stringify(tasks, null, 2));
  try {
    execSync('git add tasks.json results/ 2>/dev/null; git commit -m "task update" 2>/dev/null; git push 2>/dev/null', {
      cwd: path.join(__dirname, ".."), stdio: "pipe", timeout: 15000,
    });
  } catch {}
}

// ── Usage tracking ───────────────────────────────────────────
function loadUsage() {
  if (!fs.existsSync(USAGE_PATH)) return { codex: { calls: 0, lastCall: null, tasksClaimed: 0, tasksCompleted: 0, history: [] }, openclaw: { calls: 0, lastCall: null, tasksClaimed: 0, tasksCompleted: 0, history: [] } };
  return JSON.parse(fs.readFileSync(USAGE_PATH, "utf-8"));
}

function trackCall(agent, toolName) {
  const usage = loadUsage();
  if (!usage[agent]) usage[agent] = { calls: 0, lastCall: null, tasksClaimed: 0, tasksCompleted: 0, history: [] };
  usage[agent].calls++;
  usage[agent].lastCall = new Date().toISOString();
  usage[agent].history.push({ tool: toolName, time: new Date().toISOString() });
  // Keep last 100 entries
  if (usage[agent].history.length > 100) usage[agent].history = usage[agent].history.slice(-100);
  fs.writeFileSync(USAGE_PATH, JSON.stringify(usage, null, 2));
  return usage;
}

function trackTaskEvent(agent, event) {
  const usage = loadUsage();
  if (!usage[agent]) usage[agent] = { calls: 0, lastCall: null, tasksClaimed: 0, tasksCompleted: 0, history: [] };
  if (event === "claim") usage[agent].tasksClaimed++;
  if (event === "complete") usage[agent].tasksCompleted++;
  fs.writeFileSync(USAGE_PATH, JSON.stringify(usage, null, 2));
}

// Detect caller — if session was created by a codex tool call, tag it
function detectAgent(toolName) {
  // Codex uses get_codex_tasks; openclaw agents use get_tasks with assignee filter
  if (toolName === "get_codex_tasks") return "codex";
  return "openclaw";
}

function genId() {
  return "task-" + Date.now().toString(36) + randomUUID().slice(0, 4);
}

// ── Register tools on a server instance ──────────────────────
function registerTools(s) {
  s.tool("get_tasks", "Get tasks from the queue. Filter by status and/or assignee.", {
    status: z.enum(["pending", "in-progress", "done", "failed", "all"]).optional(),
    assignee: z.string().optional(),
  }, async ({ status, assignee }) => {
    let tasks = loadTasks();
    if (status && status !== "all") tasks = tasks.filter(t => t.status === status);
    if (assignee) tasks = tasks.filter(t => t.assignee === assignee);
    return { content: [{ type: "text", text: JSON.stringify(tasks, null, 2) }] };
  });

  s.tool("add_task", "Add a new task to the queue.", {
    title: z.string().describe("Task description"),
    priority: z.enum(["high", "medium", "low"]).optional(),
    assignee: z.string().optional().describe("Agent: codex, smartypants, scout, deepdive, connector, architect"),
    tags: z.array(z.string()).optional(),
  }, async ({ title, priority, assignee, tags }) => {
    const tasks = loadTasks();
    const task = { id: genId(), title, priority: priority || "medium", status: "pending", assignee: assignee || null, created: new Date().toISOString(), started: null, completed: null, result: null, tags: tags || [] };
    tasks.unshift(task);
    saveTasks(tasks);
    return { content: [{ type: "text", text: `Task created: ${task.id} — "${title}"` }] };
  });

  s.tool("claim_task", "Claim a pending task. Sets status to in-progress.", {
    task_id: z.string().describe("Task ID to claim"),
    agent: z.string().describe("Agent name claiming this task"),
  }, async ({ task_id, agent }) => {
    const tasks = loadTasks();
    const task = tasks.find(t => t.id === task_id);
    if (!task) return { content: [{ type: "text", text: `Not found: ${task_id}` }] };
    if (task.status !== "pending") return { content: [{ type: "text", text: `Already ${task.status}` }] };
    task.status = "in-progress"; task.assignee = agent; task.started = new Date().toISOString();
    saveTasks(tasks);
    trackCall(agent, "claim_task"); trackTaskEvent(agent, "claim");
    return { content: [{ type: "text", text: `Claimed: "${task.title}" → ${agent}` }] };
  });

  s.tool("complete_task", "Mark a task as done with a result summary.", {
    task_id: z.string(),
    result: z.string().describe("What was accomplished"),
  }, async ({ task_id, result }) => {
    const tasks = loadTasks();
    const task = tasks.find(t => t.id === task_id);
    if (!task) return { content: [{ type: "text", text: `Not found: ${task_id}` }] };
    task.status = "done"; task.completed = new Date().toISOString(); task.result = result;
    saveTasks(tasks);
    trackCall(task.assignee || "unknown", "complete_task"); trackTaskEvent(task.assignee || "unknown", "complete");
    return { content: [{ type: "text", text: `Done: "${task.title}"` }] };
  });

  s.tool("fail_task", "Mark a task as failed.", {
    task_id: z.string(),
    reason: z.string(),
  }, async ({ task_id, reason }) => {
    const tasks = loadTasks();
    const task = tasks.find(t => t.id === task_id);
    if (!task) return { content: [{ type: "text", text: `Not found: ${task_id}` }] };
    task.status = "failed"; task.result = reason; task.completed = new Date().toISOString();
    saveTasks(tasks);
    return { content: [{ type: "text", text: `Failed: "${task.title}" — ${reason}` }] };
  });

  s.tool("read_file", "Read a file from the workspace.", {
    path: z.string().describe("Path relative to workspace root"),
  }, async ({ path: fp }) => {
    const full = path.resolve(WORKSPACE, fp);
    if (!full.startsWith(WORKSPACE)) return { content: [{ type: "text", text: "Access denied" }] };
    if (!fs.existsSync(full)) return { content: [{ type: "text", text: `Not found: ${fp}` }] };
    return { content: [{ type: "text", text: fs.readFileSync(full, "utf-8").slice(0, 50000) }] };
  });

  s.tool("write_file", "Write a file to the results directory.", {
    filename: z.string(),
    content: z.string(),
  }, async ({ filename, content }) => {
    const safe = path.basename(filename);
    fs.mkdirSync(RESULTS_DIR, { recursive: true });
    fs.writeFileSync(path.join(RESULTS_DIR, safe), content);
    return { content: [{ type: "text", text: `Written: results/${safe} (${content.length} bytes)` }] };
  });

  s.tool("get_codex_tasks", "Get pending tasks assigned to codex. Codex should use this.", {}, async () => {
    trackCall("codex", "get_codex_tasks");
    const tasks = loadTasks().filter(t => t.assignee === "codex" && t.status === "pending");
    return { content: [{ type: "text", text: tasks.length === 0 ? "No pending codex tasks." : JSON.stringify(tasks, null, 2) }] };
  });

  s.tool("get_usage", "Get MCP usage stats for all agents.", {}, async () => {
    const usage = loadUsage();
    return { content: [{ type: "text", text: JSON.stringify(usage, null, 2) }] };
  });

  s.tool("list_agents", "List available agents and what they handle.", {}, async () => {
    return { content: [{ type: "text", text: JSON.stringify([
      { name: "smartypants", role: "Core Assistant", handles: "orchestration, research, data, ops" },
      { name: "codex", role: "Code Agent (OpenAI)", handles: "pure coding, PRs, tests, refactors" },
      { name: "scout", role: "Deal Sourcer", handles: "founder discovery, startup research" },
      { name: "deepdive", role: "Research Agent", handles: "deep research, peer-reviewed studies" },
      { name: "connector", role: "Outreach Agent", handles: "networking, warm intros" },
      { name: "architect", role: "App Builder", handles: "SwiftUI, web apps, UI/UX" },
    ], null, 2) }] };
  });
}

// ── Express App ──────────────────────────────────────────────
const app = express();
// Don't parse JSON for /mcp — the transport handles it
app.use((req, res, next) => {
  if (req.path === "/mcp") return next();
  express.json()(req, res, next);
});

const sessions = {};

app.post("/mcp", async (req, res) => {
  try {
    const sessionId = req.headers["mcp-session-id"] || randomUUID();
    if (!sessions[sessionId]) {
      const srv = new McpServer({ name: "chief", version: "1.0.0" });
      registerTools(srv);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => sessionId });
      await srv.connect(transport);
      sessions[sessionId] = { server: srv, transport };
    }
    await sessions[sessionId].transport.handleRequest(req, res);
  } catch (e) {
    if (!res.headersSent) res.status(500).json({ error: e.message });
  }
});

app.get("/mcp", async (req, res) => {
  const sid = req.headers["mcp-session-id"];
  if (sessions[sid]) {
    await sessions[sid].transport.handleRequest(req, res);
  } else {
    res.status(400).json({ error: "No session" });
  }
});

app.delete("/mcp", async (req, res) => {
  const sid = req.headers["mcp-session-id"];
  if (sessions[sid]) { await sessions[sid].transport.close(); delete sessions[sid]; }
  res.status(200).end();
});

app.get("/health", (req, res) => {
  const tasks = loadTasks();
  res.json({
    status: "ok", server: "chief-mcp",
    tasks: { total: tasks.length, pending: tasks.filter(t => t.status === "pending").length, inProgress: tasks.filter(t => t.status === "in-progress").length },
  });
});

app.listen(PORT, () => {
  console.log(`⚡ CHIEF MCP Server running on port ${PORT}`);
  console.log(`   Endpoint: http://localhost:${PORT}/mcp`);
  console.log(`   Health:   http://localhost:${PORT}/health`);
});
