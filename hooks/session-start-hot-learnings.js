#!/usr/bin/env node
/**
 * SessionStart Hook: Read HOT.md learnings
 *
 * Reads ~/.learnings/HOT.md at session start and injects it
 * into the conversation context so past learnings are always active.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const MAX_STDIN = 512 * 1024;
let raw = '';

process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  if (raw.length < MAX_STDIN) raw += chunk.substring(0, MAX_STDIN - raw.length);
});

process.stdin.on('end', () => {
  // Pass through original
  process.stdout.write(raw);

  // Read HOT.md
  const hotPath = path.join(os.homedir(), '.learnings', 'HOT.md');
  try {
    if (fs.existsSync(hotPath)) {
      const content = fs.readFileSync(hotPath, 'utf8').trim();
      if (content.length > 0) {
        process.stderr.write(
          `\n[SESSION-START] Active learnings loaded from HOT.md:\n` +
          `${content}\n` +
          `---\nFollow these rules strictly. They come from past mistakes.\n`
        );
      }
    }
  } catch {
    // Ignore read errors
  }

  // Read project-specific progress.txt if it exists
  const progressPath = path.join(process.cwd(), 'progress.txt');
  try {
    if (fs.existsSync(progressPath)) {
      const progress = fs.readFileSync(progressPath, 'utf8').trim();
      if (progress.length > 0 && progress.length < 2000) {
        process.stderr.write(
          `\n[SESSION-START] Project progress loaded:\n${progress}\n`
        );
      }
    }
  } catch {
    // Ignore
  }
});
