#!/usr/bin/env node
/**
 * SessionStart Hook: HOT.md size warning
 *
 * Warns if HOT.md exceeds target line count (30). Created 2026-05-21
 * after audit found HOT.md at 117 lines despite "Friday-trim" rule.
 * Non-blocking — just informs you that a trim is overdue.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const MAX_STDIN = 512 * 1024;
const TARGET_LINES = 30;
const WARN_LINES = 35;

let raw = '';

process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  if (raw.length < MAX_STDIN) raw += chunk.substring(0, MAX_STDIN - raw.length);
});

process.stdin.on('end', () => {
  process.stdout.write(raw);

  const hotPath = path.join(os.homedir(), '.learnings', 'HOT.md');
  try {
    if (fs.existsSync(hotPath)) {
      const content = fs.readFileSync(hotPath, 'utf8');
      const lines = content.split('\n').length;
      if (lines > WARN_LINES) {
        const coldPath = path.join(os.homedir(), '.learnings', 'HOT-COLD.md');
        const hasColdArchive = fs.existsSync(coldPath);
        process.stderr.write(
          `\n[HOT.md size warning] HOT.md is ${lines} lines (target <=${TARGET_LINES}, warn >${WARN_LINES}).\n` +
          `Trim recommended: move resolved/old (>30 days) entries to HOT-COLD.md.\n` +
          (hasColdArchive ? `HOT-COLD.md exists — append vanhat sinne.\n` : `HOT-COLD.md missing — create it as archive.\n`)
        );
      }
    }
  } catch {
    // Ignore — non-blocking
  }
});
