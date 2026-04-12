#!/usr/bin/env node
// dispatch.js — Reads tasks.json, spawns agents for pending tasks
// Called by OpenClaw cron every 15 minutes via agentTurn.
// The agent (Smartypants) runs this, reads pending tasks, and uses sessions_spawn.

const fs = require("fs");
const path = require("path");
const http = require("http");

const GATEWAY = "http://127.0.0.1:18789";
const TOKEN = "5895d9ae3f0d369fa7e5a71dbd0841b14eb3f7c0eae0e2fd";
const TASKS_PATH = path.join(__dirname, "tasks.json");

function invoke(tool, args = {}) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ tool, args, sessionKey: "main" });
    const url = new URL("/tools/invoke", GATEWAY);
    const req = http.request(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${TOKEN}`,
        "Content-Length": Buffer.byteLength(body),
      },
    }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try { resolve(JSON.parse(data)); } catch { resolve(null); }
      });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

function loadTasks() {
  if (!fs.existsSync(TASKS_PATH)) return [];
  return JSON.parse(fs.readFileSync(TASKS_PATH, "utf-8"));
}

function saveTasks(tasks) {
  fs.writeFileSync(TASKS_PATH, JSON.stringify(tasks, null, 2));
}

// Model selection based on task tags/priority
function pickModel(task) {
  if (task.priority === "high" || task.tags?.includes("research")) {
    return "anthropic/claude-sonnet-4-20250514";
  }
  return "anthropic/claude-sonnet-4-20250514";
}

async function main() {
  const tasks = loadTasks();
  const pending = tasks.filter((t) => t.status === "pending");

  if (pending.length === 0) {
    console.log("✅ No pending tasks");
    return;
  }

  console.log(`📋 ${pending.length} pending task(s) found`);

  // Process up to 3 tasks at a time
  const batch = pending.slice(0, 3);

  for (const task of batch) {
    console.log(`🚀 Dispatching: ${task.title}`);

    const prompt = [
      `You are an agent working for Angela Busheska (startup founder, medical longevity).`,
      ``,
      `## Task`,
      `${task.title}`,
      ``,
      `## Instructions`,
      `- Do thorough work. Angela values depth over speed.`,
      `- Save your output to: /Users/angelabusheska/.openclaw/workspace/chief/results/${task.id}.md`,
      `- Use real citations if doing research.`,
      `- Be specific and actionable.`,
      `- When done, write a 2-3 sentence summary as your final message.`,
      task.tags?.includes("research")
        ? `- Use web_search for current information. Prefer studies from 2020-2026.`
        : "",
      task.tags?.includes("deals")
        ? `- Search for founders, check LinkedIn patterns, university startup programs. Focus on pre-seed/seed.`
        : "",
    ].filter(Boolean).join("\n");

    try {
      const result = await invoke("sessions_spawn", {
        task: prompt,
        label: `chief:${task.id}`,
        model: pickModel(task),
        runTimeoutSeconds: 300,
        cleanup: "keep",
      });

      // Mark as in-progress
      task.status = "in-progress";
      task.started = new Date().toISOString();
      task.assignee = `agent:${task.id}`;
      console.log(`   ✅ Spawned → ${task.assignee}`);
    } catch (e) {
      console.error(`   ❌ Failed to spawn: ${e.message}`);
    }
  }

  saveTasks(tasks);

  // Git push updated tasks
  try {
    const { execSync } = require("child_process");
    execSync('git add tasks.json && git commit -m "chore: tasks dispatched" && git push', {
      cwd: __dirname,
      stdio: "pipe",
    });
    console.log("📤 Pushed task updates");
  } catch {}
}

main().catch(console.error);
