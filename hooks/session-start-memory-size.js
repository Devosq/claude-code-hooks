#!/usr/bin/env node
/**
 * SessionStart Hook: MEMORY.md size warning
 *
 * Warns if MEMORY.md exceeds 22 KB threshold (system limit 24.4 KB).
 * Created 2026-05-21 after audit found MEMORY.md at 30.8 KB with
 * "Only part loaded" warning happening in production sessions.
 * Non-blocking — just informs you that archive is overdue.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const MAX_STDIN = 512 * 1024;
const WARN_BYTES = 22000;
const HARD_LIMIT = 24400;

let raw = '';

process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  if (raw.length < MAX_STDIN) raw += chunk.substring(0, MAX_STDIN - raw.length);
});

process.stdin.on('end', () => {
  process.stdout.write(raw);

  const memoryPath = path.join(
    os.homedir(),
    '.claude',
    'projects',
    'C--Users-<USERNAME>',
    'memory',
    'MEMORY.md'
  );

  try {
    if (fs.existsSync(memoryPath)) {
      const stats = fs.statSync(memoryPath);
      const sizeBytes = stats.size;
      const sizeKB = (sizeBytes / 1024).toFixed(1);
      if (sizeBytes > WARN_BYTES) {
        const overLimit = sizeBytes > HARD_LIMIT ? ' (OVER SYSTEM LIMIT — index will be truncated!)' : '';
        process.stderr.write(
          `\n[MEMORY.md size warning] MEMORY.md is ${sizeKB} KB (${sizeBytes} bytes, warn >${WARN_BYTES}, hard limit ${HARD_LIMIT})${overLimit}.\n` +
          `Archive recommended: move "Closed" projects to MEMORY-ARCHIVE-projects-Q2-2026.md or similar dated archive.\n` +
          `Shorten Active-pointers to <150 chars per line.\n`
        );
      }
    }
  } catch {
    // Ignore — non-blocking
  }
});
