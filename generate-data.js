#!/usr/bin/env node
// generate-data.js — Pulls live session data from OpenClaw Gateway → data.json
// Run: node generate-data.js
// Runs automatically via cron every 5 minutes.

const fs = require("fs");
const path = require("path");
const http = require("http");

const GATEWAY = "http://127.0.0.1:18789";
const TOKEN = "5895d9ae3f0d369fa7e5a71dbd0841b14eb3f7c0eae0e2fd";
const OUT = path.join(__dirname, "data.json");

// ── API helper ───────────────────────────────────────────────
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
        try {
          const j = JSON.parse(data);
          resolve(j.ok ? j.result : j);
        } catch {
          resolve(null);
        }
      });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

// ── Agent icon/role mapping ──────────────────────────────────
const AGENT_META = {
  "agent:main:main": { icon: "😏", name: "Smartypants", role: "Core Assistant" },
  default: { icon: "🤖", name: null, role: "Sub-Agent" },
};

function agentMeta(session) {
  const key = session.sessionKey || "";
  const known = AGENT_META[key];
  if (known) return known;

  // Try to extract a readable name from the session key or label
  const label = session.label || key;
  if (label.includes("deal") || label.includes("scout"))
    return { icon: "🔭", name: "Scout", role: "Deal Sourcer" };
  if (label.includes("research") || label.includes("deep"))
    return { icon: "🔬", name: "DeepDive", role: "Research Agent" };
  if (label.includes("outreach") || label.includes("connect"))
    return { icon: "🤝", name: "Connector", role: "Outreach Agent" };
  if (label.includes("build") || label.includes("architect") || label.includes("continuum"))
    return { icon: "🏗️", name: "Architect", role: "App Builder" };
  if (label.includes("chief"))
    return { icon: "📊", name: "CHIEF Updater", role: "Dashboard Refresh" };

  return { ...AGENT_META.default, name: label || "Agent" };
}

function statusFromSession(s) {
  if (s.state === "error") return "error";
  if (s.state === "running" || s.state === "active" || s.state === "busy") return "running";
  if (s.state === "completed" || s.state === "done") return "done";
  return "idle";
}

function relTimeStr(ms) {
  if (!ms || ms < 0) return "—";
  const m = Math.floor(ms / 60_000);
  if (m < 1) return "<1m";
  if (m < 60) return m + "m";
  const h = Math.floor(m / 60);
  if (h < 24) return h + "h " + (m % 60) + "m";
  return Math.floor(h / 24) + "d";
}

// ── Main ─────────────────────────────────────────────────────
async function main() {
  const NOW = new Date().toISOString();
  let sessions = [];
  let feed = [];

  try {
    // Fetch sessions with last 1 message for activity context
    const result = await invoke("sessions_list", {
      limit: 50,
      messageLimit: 1,
    });

    // tools/invoke wraps the result — dig into it
    const details = result?.details || result;
    if (details && Array.isArray(details.sessions)) {
      sessions = details.sessions;
    } else if (result?.content?.[0]?.text) {
      // Fallback: parse from text content
      try {
        const parsed = JSON.parse(result.content[0].text);
        sessions = parsed.sessions || [];
      } catch {}
    } else if (Array.isArray(result)) {
      sessions = result;
    }
  } catch (e) {
    console.error("⚠️  Failed to reach gateway:", e.message);
    // Fall back to existing data.json if available
    if (fs.existsSync(OUT)) {
      console.log("   Using existing data.json");
      process.exit(0);
    }
  }

  // ── Build agent cards ──────────────────────────────────────
  const agents = sessions.map((s) => {
    const key = s.key || s.sessionKey || s.id;
    const meta = agentMeta({ ...s, sessionKey: key });
    const status = s.abortedLastRun ? "error" : statusFromSession(s);
    const lastMsg = s.messages?.[0] || s.lastMessages?.[0];
    const updatedAt = s.updatedAt ? new Date(s.updatedAt).toISOString() : null;

    // Extract cost from last message usage if available
    const msgCost = lastMsg?.usage?.cost?.total || 0;
    const msgInput = lastMsg?.usage?.input || 0;
    const msgOutput = lastMsg?.usage?.output || 0;
    const msgCacheRead = lastMsg?.usage?.cacheRead || 0;

    // Extract text from content array or string
    let lastText = null;
    if (lastMsg?.content) {
      if (typeof lastMsg.content === "string") {
        lastText = lastMsg.content;
      } else if (Array.isArray(lastMsg.content)) {
        const textPart = lastMsg.content.find((c) => c.type === "text");
        lastText = textPart?.text || null;
      }
    }

    return {
      id: key,
      name: meta.name || s.displayName || key,
      role: meta.role,
      status,
      icon: meta.icon,
      task: s.kind === "subagent" ? "Sub-agent task" : s.displayName || s.kind || "—",
      model: s.model || "—",
      started: updatedAt,
      lastMessage: lastText
        ? lastText.slice(0, 120).replace(/\n/g, " ")
        : null,
      tokens: {
        input: s.totalTokens || msgInput + msgCacheRead,
        output: msgOutput,
      },
      cost: msgCost,
      sessionKey: key,
      kind: s.kind,
      channel: s.channel || s.lastChannel,
      contextWindow: s.contextTokens || 0,
    };
  });

  // ── Build activity feed from last messages ─────────────────
  sessions.forEach((s) => {
    const key = s.key || s.sessionKey;
    const meta = agentMeta({ ...s, sessionKey: key });
    const lastMsg = s.messages?.[0] || s.lastMessages?.[0];
    if (lastMsg) {
      let msgText = "";
      if (typeof lastMsg.content === "string") msgText = lastMsg.content;
      else if (Array.isArray(lastMsg.content)) {
        const tp = lastMsg.content.find((c) => c.type === "text");
        msgText = tp?.text || "";
      }
      feed.push({
        time: lastMsg.timestamp || lastMsg.createdAt || NOW,
        agent: meta.name || s.label || key,
        icon: meta.icon,
        event: msgText.slice(0, 100).replace(/\n/g, " ") || "Activity",
      });
    }
  });

  // Sort feed by time descending
  feed.sort((a, b) => new Date(b.time) - new Date(a.time));
  feed = feed.slice(0, 20);

  // ── System stats ───────────────────────────────────────────
  const system = {
    totalAgents: agents.length,
    running: agents.filter((a) => a.status === "running").length,
    idle: agents.filter((a) => a.status === "idle").length,
    errored: agents.filter((a) => a.status === "error").length,
    completed: agents.filter((a) => a.status === "done").length,
    totalCost: agents.reduce((s, a) => s + (a.cost || 0), 0),
    totalTokens: agents.reduce(
      (s, a) => s + (a.tokens?.input || 0) + (a.tokens?.output || 0),
      0
    ),
  };

  // ── Write ──────────────────────────────────────────────────
  const data = { generated: NOW, system, agents, feed };
  fs.writeFileSync(OUT, JSON.stringify(data, null, 2));
  console.log(`✅ CHIEF data refreshed → ${OUT}`);
  console.log(
    `   ${system.totalAgents} sessions | ${system.running} running | $${system.totalCost.toFixed(2)} total cost`
  );
}

main().catch((e) => {
  console.error("❌ CHIEF generate failed:", e.message);
  process.exit(1);
});
