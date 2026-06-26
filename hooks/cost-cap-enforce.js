#!/usr/bin/env node
'use strict';

// cost-cap-enforce.js
// PostToolUse hook: reads token usage from the tool-result estimate and
// atomically updates this instance's cost cap and a shared overnight budget.
// Active ONLY when process.env.CLAUDE_INSTANCE_ID is set (unattended runs).
//
// Soft warning: $4.00 -> optional Telegram message, keep going.
// Hard stop:    $5.00 per instance or $20.00 total -> write a STOP-NOW flag.
//
// This hook can't abort an in-flight tool call directly, but it writes a
// CLAUDE_HOME/instances/<id>/STOP-NOW flag that the Stop / PreToolUse hooks
// read on the next iteration. Thresholds are configurable at the top of the file.

const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');

const INSTANCE_ID = process.env.CLAUDE_INSTANCE_ID;

// No-op if not in overnight mode
if (!INSTANCE_ID) {
  process.exit(0);
}

const HOME = os.homedir();
const CLAUDE_HOME = path.join(HOME, '.claude');
const INSTANCE_DIR = path.join(CLAUDE_HOME, 'instances', INSTANCE_ID);
const COST_CAP_FILE = path.join(INSTANCE_DIR, 'cost-cap.json');
const BUDGET_FILE = path.join(CLAUDE_HOME, 'overnight-budget.json');
const LOCK_FILE = path.join(CLAUDE_HOME, 'overnight-budget.lock');
const STOP_FLAG = path.join(INSTANCE_DIR, 'STOP-NOW');
// Use local-time YYYY-MM-DD to match morning-summary's lookup date
const TODAY = new Date().toLocaleDateString('sv-SE');
const LOG_FILE = path.join(CLAUDE_HOME, 'overnight-logs', `${TODAY}.jsonl`);

function logEvent(event, data = {}) {
  const entry = {
    ts: new Date().toISOString(),
    instance: INSTANCE_ID,
    event,
    ...data,
  };
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    fs.appendFileSync(LOG_FILE, JSON.stringify(entry) + '\n', 'utf8');
  } catch {
    /* swallow log errors — hook must not crash */
  }
}

function readStdinJson() {
  try {
    const raw = fs.readFileSync(0, 'utf8');
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function sleepSync(ms) {
  // Sync sleep without burning CPU: use SharedArrayBuffer + Atomics.wait
  // Falls back to short busy-wait if SAB unavailable.
  try {
    const sab = new SharedArrayBuffer(4);
    const view = new Int32Array(sab);
    Atomics.wait(view, 0, 0, ms);
  } catch {
    const until = Date.now() + ms;
    while (Date.now() < until) { /* fallback */ }
  }
}

function acquireLock(maxWaitMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    try {
      const fd = fs.openSync(LOCK_FILE, 'wx');
      fs.writeSync(fd, String(process.pid));
      return fd;
    } catch (err) {
      if (err.code === 'EEXIST') {
        let ageMs = 0;
        try {
          ageMs = Date.now() - fs.statSync(LOCK_FILE).mtimeMs;
        } catch { /* lock vanished mid-check */ }
        if (ageMs > 30000) {
          try {
            fs.unlinkSync(LOCK_FILE);
          } catch { /* race */ }
          continue;
        }
        sleepSync(50 + Math.floor(Math.random() * 150));
      } else {
        throw err;
      }
    }
  }
  throw new Error(`Could not acquire ${LOCK_FILE} within ${maxWaitMs}ms`);
}

function releaseLock(fd) {
  try {
    fs.closeSync(fd);
  } catch { /* ignore */ }
  try {
    fs.unlinkSync(LOCK_FILE);
  } catch { /* ignore */ }
}

function writeJsonAtomic(filePath, obj) {
  // Atomic write: tmp file + rename. Rename is atomic on POSIX and Windows
  // (when target is on same volume), preventing partial-write corruption.
  const tmp = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
  fs.renameSync(tmp, filePath);
}

function estimateCostUsd(tokenUsage, model, pricing) {
  // Conservative model-key matching:
  // 1. Exact key match (e.g. pricing["sonnet-4-6"] when model === "sonnet-4-6")
  // 2. Family match by tier word (opus/sonnet/haiku), prefer longest/most-specific key
  // 3. Fallback to sonnet rates (mid-tier safe default)
  const modelStr = String(model || '').toLowerCase();
  const keys = Object.keys(pricing).filter((k) => !k.startsWith('_'));

  let chosen = keys.find((k) => k.toLowerCase() === modelStr);

  if (!chosen) {
    const tiers = ['opus', 'sonnet', 'haiku'];
    const tier = tiers.find((t) => modelStr.includes(t));
    if (tier) {
      const tierKeys = keys.filter((k) => k.toLowerCase().includes(tier));
      // Pick the most specific key (longest) within the matching tier
      tierKeys.sort((a, b) => b.length - a.length);
      chosen = tierKeys[0];
    }
  }

  const rates =
    pricing[chosen] ||
    pricing['sonnet-4-6'] ||
    { input: 0.003, output: 0.015, cache_read: 0.0003 };

  const inTok = Number(tokenUsage.input_tokens || 0);
  const outTok = Number(tokenUsage.output_tokens || 0);
  const cacheReadTok = Number(tokenUsage.cache_read_input_tokens || 0);
  const cost =
    (inTok / 1000) * rates.input +
    (outTok / 1000) * rates.output +
    (cacheReadTok / 1000) * (rates.cache_read || rates.input * 0.1);
  return Math.max(0, cost);
}

function sendTelegramAlert(message) {
  // Returns a Promise; caller MUST await to guarantee delivery before process.exit.
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    logEvent('telegram_skipped', { reason: 'TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID not set' });
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const body = JSON.stringify({ chat_id: chatId, text: message, parse_mode: 'Markdown' });
    const opts = {
      hostname: 'api.telegram.org',
      path: `/bot${token}/sendMessage`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: 5000,
    };
    const req = https.request(opts, (res) => {
      res.resume();
      res.on('end', resolve);
    });
    req.on('error', (err) => {
      logEvent('telegram_error', { error: err.message });
      resolve();
    });
    req.on('timeout', () => {
      logEvent('telegram_timeout', {});
      req.destroy();
      resolve();
    });
    req.write(body);
    req.end();
  });
}

function writeStopFlag(reason) {
  try {
    fs.writeFileSync(STOP_FLAG, JSON.stringify({
      ts: new Date().toISOString(),
      reason,
      instance: INSTANCE_ID,
    }, null, 2), 'utf8');
  } catch (err) {
    logEvent('stop_flag_write_error', { error: err.message });
  }
}

async function main() {
  const stdin = readStdinJson();
  const toolResult = stdin.tool_response || stdin.toolResult || {};
  const usage = toolResult.usage || stdin.usage || {};
  const model = stdin.model || toolResult.model || process.env.CLAUDE_MODEL;

  // Skip if we have no usage data
  if (!usage.input_tokens && !usage.output_tokens) {
    process.exit(0);
  }

  const pendingTelegram = [];
  let fd;
  try {
    fd = acquireLock();

    const budget = JSON.parse(fs.readFileSync(BUDGET_FILE, 'utf8'));
    const costCap = JSON.parse(fs.readFileSync(COST_CAP_FILE, 'utf8'));
    const pricing = budget.model_pricing_usd_per_1k_tokens || {};

    const callCost = estimateCostUsd(usage, model, pricing);
    const newInstanceTotal = (costCap.current_session_usd || 0) + callCost;
    const newGlobalTotal = (budget.shared_state.current_total_usd || 0) + callCost;

    costCap.current_session_usd = Number(newInstanceTotal.toFixed(4));
    budget.shared_state.current_total_usd = Number(newGlobalTotal.toFixed(4));
    budget.shared_state.last_alert_iso = budget.shared_state.last_alert_iso || null;

    writeJsonAtomic(COST_CAP_FILE, costCap);
    writeJsonAtomic(BUDGET_FILE, budget);

    logEvent('cost_accumulated', {
      call_cost_usd: callCost,
      instance_total_usd: newInstanceTotal,
      global_total_usd: newGlobalTotal,
      model: model || 'unknown',
      input_tokens: usage.input_tokens,
      output_tokens: usage.output_tokens,
    });

    const softWarn = Number(costCap.soft_warning_usd || 4.0);
    const hardCap = Number(costCap.cap_usd || 5.0);
    const totalCap = Number(budget.total_cap_usd || 20.0);

    if (newInstanceTotal >= hardCap) {
      writeStopFlag(`Per-instance cap reached: $${newInstanceTotal.toFixed(2)} / $${hardCap}`);
      pendingTelegram.push(sendTelegramAlert(
        `🚨 *Overnight HARD STOP*\n` +
        `Instance: \`${INSTANCE_ID}\`\n` +
        `Cost: $${newInstanceTotal.toFixed(2)} / $${hardCap}\n` +
        `Global: $${newGlobalTotal.toFixed(2)} / $${totalCap}`
      ));
      logEvent('hard_stop_triggered', { reason: 'per_instance_cap' });
    } else if (newGlobalTotal >= totalCap) {
      writeStopFlag(`Total budget reached: $${newGlobalTotal.toFixed(2)} / $${totalCap}`);
      pendingTelegram.push(sendTelegramAlert(
        `🚨 *Overnight TOTAL CAP STOP*\n` +
        `Instance: \`${INSTANCE_ID}\`\n` +
        `Global: $${newGlobalTotal.toFixed(2)} / $${totalCap}\n` +
        `All instances should stop.`
      ));
      logEvent('hard_stop_triggered', { reason: 'global_cap' });
    } else if (newInstanceTotal >= softWarn) {
      const lastAlert = costCap.last_soft_warning_iso || 0;
      const minutesSince = (Date.now() - new Date(lastAlert).getTime()) / 60000;
      if (!lastAlert || minutesSince > 15) {
        pendingTelegram.push(sendTelegramAlert(
          `⚠️ *Overnight soft warning*\n` +
          `Instance: \`${INSTANCE_ID}\`\n` +
          `Cost: $${newInstanceTotal.toFixed(2)} / $${hardCap}`
        ));
        costCap.last_soft_warning_iso = new Date().toISOString();
        writeJsonAtomic(COST_CAP_FILE, costCap);
        logEvent('soft_warning_sent', { instance_total_usd: newInstanceTotal });
      }
    }
  } catch (err) {
    logEvent('hook_error', { error: err.message, stack: err.stack });
  } finally {
    if (fd !== undefined) releaseLock(fd);
  }

  // Wait for all Telegram alerts to flush before exiting.
  // Especially critical for HARD STOP — the user must see it.
  try {
    await Promise.all(pendingTelegram);
  } catch { /* never throw out of hook */ }

  process.exit(0);
}

main().catch((err) => {
  logEvent('hook_unhandled_error', { error: err.message });
  process.exit(0); // Always exit 0 — hook must not crash Claude Code.
});
