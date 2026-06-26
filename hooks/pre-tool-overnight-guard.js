#!/usr/bin/env node
'use strict';

// pre-tool-overnight-guard.js
// PreToolUse hook: blocks dangerous commands and production paths during
// unattended runs. Active ONLY when process.env.CLAUDE_INSTANCE_ID is set.
// Reads an allowlist + blocklist (YAML); the blocklist wins over the allowlist.
//
// Decision:
// - exit 0  -> allow
// - exit 2  -> block (Claude Code shows the reason to the user)

const fs = require('fs');
const path = require('path');
const os = require('os');

const INSTANCE_ID = process.env.CLAUDE_INSTANCE_ID;
if (!INSTANCE_ID) {
  process.exit(0); // Not in overnight mode — let everything through.
}

const HOME = os.homedir();
const CLAUDE_HOME = path.join(HOME, '.claude');
const BLOCKLIST_FILE = path.join(CLAUDE_HOME, 'instances', 'overnight-blocklist.yaml');
const STOP_FLAG = path.join(CLAUDE_HOME, 'instances', INSTANCE_ID, 'STOP-NOW');
// Use local-time YYYY-MM-DD to match other overnight hooks
const TODAY = new Date().toLocaleDateString('sv-SE');
const LOG_FILE = path.join(CLAUDE_HOME, 'overnight-logs', `${TODAY}.jsonl`);

function logEvent(event, data = {}) {
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    fs.appendFileSync(
      LOG_FILE,
      JSON.stringify({ ts: new Date().toISOString(), instance: INSTANCE_ID, event, ...data }) + '\n',
      'utf8'
    );
  } catch { /* swallow */ }
}

function readStdinJson() {
  try {
    const raw = fs.readFileSync(0, 'utf8');
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function blockAndExit(reason, detail = {}) {
  logEvent('overnight_guard_blocked', { reason, ...detail });
  process.stderr.write(
    `[overnight-guard] BLOCKED: ${reason}\n` +
    `Allowed in unattended runs: fix-bug, add-tests, refactor-existing, update-docs, lint-fix, flaky-test-investigation.
` +
    `Blocked: new-feature, deploy, migration, auth-change, payment-flow, secret-changes.
` +
    `If this is a false positive, do not retry — leave it for a supervised daytime run.
`
  );
  process.exit(2);
}

// Minimalistic YAML parser — only handles the simple shape used in our blocklist/allowlist
// files (lists of strings under top-level keys). Avoids adding a yaml dependency.
function parseSimpleYaml(text) {
  const result = {};
  let currentKey = null;
  let currentList = null;
  let inBlockScalar = false;

  for (const rawLine of text.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    if (!line.trim() || line.trim().startsWith('#')) continue;

    if (inBlockScalar && line.startsWith('  ')) continue;
    inBlockScalar = false;

    const topMatch = line.match(/^([a-zA-Z_][a-zA-Z0-9_]*):\s*(.*)$/);
    if (topMatch && !line.startsWith(' ')) {
      currentKey = topMatch[1];
      const inlineValue = topMatch[2];
      if (inlineValue === '' || inlineValue === undefined) {
        result[currentKey] = [];
        currentList = result[currentKey];
      } else if (inlineValue === '|' || inlineValue === '>') {
        result[currentKey] = '';
        currentList = null;
        inBlockScalar = true;
      } else {
        result[currentKey] = inlineValue.replace(/^"|"$/g, '');
        currentList = null;
      }
      continue;
    }
    const listMatch = line.match(/^\s+-\s+(.+)$/);
    if (listMatch && currentList) {
      let value = listMatch[1].trim();
      // Strip surrounding quotes
      value = value.replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1');
      currentList.push(value);
    }
  }
  return result;
}

function loadBlocklist() {
  try {
    return parseSimpleYaml(fs.readFileSync(BLOCKLIST_FILE, 'utf8'));
  } catch (err) {
    logEvent('blocklist_load_error', { error: err.message });
    return { blocked_commands: [], blocked_file_patterns: [], blocked_content_patterns: [] };
  }
}

// Convert a shell-glob-style pattern (with `*` wildcards) to a RegExp.
// IMPORTANT: not anchored — must catch compound commands like `cd /tmp && vercel --prod`.
// Used for both command patterns and file path patterns; file paths are anchored via the
// caller (matchesAnyFile).
function globToRegex(glob, anchored = false) {
  const escaped = glob
    .replace(/[.+^${}()|\\]/g, '\\$&')
    .replace(/\*/g, '.*');
  return new RegExp(anchored ? '^' + escaped + '$' : escaped, 'i');
}

// Command matching: tokenize on shell separators so that compound commands
// (`cd /tmp && vercel --prod`, `true; rm -rf /`, `bash -c 'supabase db push'`)
// are each individually checked against blocked patterns.
function matchesAnyCommand(cmd, patterns) {
  if (!cmd) return false;
  // Split on common shell control operators and eval/bash-c wrappers.
  const tokens = String(cmd)
    .split(/(?:&&|\|\||;|\||\bxargs\b|\beval\b|\bbash\s+-c\b|\bsh\s+-c\b|\bcmd\s+\/c\b|\bpowershell\s+-c\b)/i)
    .map((t) => t.trim())
    .filter(Boolean);
  // Also check the full command string in case a pattern spans tokens.
  tokens.push(String(cmd));
  return patterns.some((p) => {
    try {
      const re = globToRegex(p, false);
      return tokens.some((t) => re.test(t));
    } catch {
      return false;
    }
  });
}

// File path matching: anchored — paths must match the pattern exactly.
function matchesAnyFile(filePath, patterns) {
  if (!filePath) return false;
  return patterns.some((p) => {
    try {
      return globToRegex(p, true).test(filePath);
    } catch {
      return false;
    }
  });
}

function normalizePath(p) {
  // Resolve ".." segments to prevent path-traversal bypass of blocked_file_patterns.
  const forward = String(p || '').replace(/\\/g, '/');
  try {
    return path.posix.normalize(forward);
  } catch {
    return forward;
  }
}

function checkContentAgainstPatterns(content, patterns, toolName) {
  if (!content || patterns.length === 0) return null;
  for (const pat of patterns) {
    try {
      if (new RegExp(pat).test(content)) {
        return { tool: toolName, pattern: pat };
      }
    } catch {
      // Invalid regex in blocklist — skip
    }
  }
  return null;
}

function main() {
  // Honor existing STOP-NOW flag — refuse all further tool calls.
  if (fs.existsSync(STOP_FLAG)) {
    blockAndExit('STOP-NOW flag set by cost-cap-enforce hook', { stop_flag: STOP_FLAG });
  }

  const stdin = readStdinJson();
  const toolName = stdin.tool_name || stdin.toolName || '';
  const toolInput = stdin.tool_input || stdin.toolInput || {};
  const blocklist = loadBlocklist();

  const blockedCommands = blocklist.blocked_commands || [];
  const blockedFiles = blocklist.blocked_file_patterns || [];
  const blockedContent = blocklist.blocked_content_patterns || [];

  // 1. Bash command check — tokenizes compound commands
  if (toolName === 'Bash' && toolInput.command) {
    const cmd = String(toolInput.command);
    if (matchesAnyCommand(cmd, blockedCommands)) {
      blockAndExit(`Blocked command pattern matched`, { command: cmd.slice(0, 200) });
    }
  }

  // 2. Write / Edit / MultiEdit / NotebookEdit — file path + content checks
  const writeTools = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'];
  if (writeTools.includes(toolName) && toolInput.file_path) {
    const filePath = normalizePath(toolInput.file_path);
    if (matchesAnyFile(filePath, blockedFiles)) {
      blockAndExit(`Blocked file path pattern matched`, { tool: toolName, path: filePath });
    }

    // Collect ALL content candidates from this tool call
    const contents = [];
    if (typeof toolInput.content === 'string') contents.push(toolInput.content);
    if (typeof toolInput.new_string === 'string') contents.push(toolInput.new_string);
    if (typeof toolInput.new_source === 'string') contents.push(toolInput.new_source);
    // MultiEdit: edits[].new_string
    if (Array.isArray(toolInput.edits)) {
      for (const e of toolInput.edits) {
        if (typeof e.new_string === 'string') contents.push(e.new_string);
      }
    }

    for (const c of contents) {
      const hit = checkContentAgainstPatterns(c, blockedContent, toolName);
      if (hit) {
        blockAndExit(`Blocked content pattern detected`, hit);
      }
    }
  }

  // 3. MCP tool guard — broad pattern matching critical prod-operation verbs.
  // Covers: deploy_*, apply_migration, execute_sql, delete_*, merge_*, set_env*,
  // remove_env*, set-variables, secret*, pause_project, restore_project, rotate*.
  const mcpDangerPatterns = [
    /^mcp__.*__(deploy|deploy_to_vercel|deploy_edge_function|deploy_template)$/i,
    /^mcp__.*__apply_migration$/i,
    /^mcp__.*__execute_sql$/i,
    /^mcp__.*__(delete|delete_branch|delete_label|delete_event|delete-environment)$/i,
    /^mcp__.*__(merge|merge_pull_request|merge_branch)$/i,
    /^mcp__.*__(set_env|set_env_variable|set-variables|remove_env|remove_env_variable)$/i,
    /^mcp__.*__(secret|secrets_set|set_secret|rotate_secret)$/i,
    /^mcp__.*__(pause_project|restore_project|reset_branch)$/i,
    /^mcp__.*__(rotate|rotate_credential)$/i,
    /^mcp__.*__(create_project|create-project-and-link|generate-domain)$/i,
    // Hetzner/Cloud destructive
    /^mcp__hetzner__.*$/i,
    // Stripe payment operations
    /^mcp__stripe__.*$/i,
  ];
  if (mcpDangerPatterns.some((re) => re.test(toolName))) {
    blockAndExit(`Blocked MCP danger-class tool`, { tool: toolName });
  }

  // Otherwise: allow.
  process.exit(0);
}

main();
