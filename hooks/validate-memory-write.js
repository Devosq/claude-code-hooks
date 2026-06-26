#!/usr/bin/env node
/**
 * PostToolUse Hook (Write|Edit): memory-file frontmatter validation.
 *
 * Adapted from breferrari/obsidian-mind (.claude/scripts/validate-write.ts).
 * After a Write/Edit, if the target is a memory note under
 * ~/.claude/projects/C--Users-<USERNAME>/memory/, verify it carries the
 * frontmatter schema CLAUDE.md requires:
 *
 *   name:           <kebab-case slug>
 *   description:    <one-line summary>
 *   metadata.type:  user | feedback | project | reference
 *
 * Emits a non-blocking warning (hookSpecificOutput.additionalContext) so the
 * agent fixes the note in the same turn. Scoped narrowly to the memory dir
 * so ordinary code writes never trigger it. Index/archive files are skipped.
 *
 * Created 2026-06-14 — schema existed in CLAUDE.md but was never enforced.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const MAX_STDIN = 512 * 1024;
const MEMORY_DIR = path.join(
  os.homedir(),
  '.claude',
  'projects',
  'C--Users-<USERNAME>',
  'memory'
);
const VALID_TYPES = ['user', 'feedback', 'project', 'reference'];
// Index/aggregate files are not individual memories — skip them.
const SKIP_BASENAMES = new Set(['MEMORY.md']);

function isMemoryNote(filePath) {
  if (typeof filePath !== 'string' || !filePath.endsWith('.md')) return false;
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(MEMORY_DIR) + path.sep)) return false;
  const base = path.basename(resolved);
  if (SKIP_BASENAMES.has(base)) return false;
  // Skip archive/index aggregates (MEMORY-ARCHIVE-*.md, MEMORY-*.md indexes).
  if (/^MEMORY[-.]/i.test(base)) return false;
  return true;
}

function extractFrontmatter(content) {
  const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  return m ? m[1] : null;
}

function validate(content) {
  const warnings = [];
  const fm = extractFrontmatter(content);
  if (fm === null) {
    return ['missing YAML frontmatter block (--- ... ---)'];
  }
  if (!/^name:\s*\S/m.test(fm)) {
    warnings.push('missing `name:` (kebab-case slug)');
  }
  if (!/^description:\s*\S/m.test(fm)) {
    warnings.push('missing `description:` (one-line summary)');
  }
  const typeMatch = fm.match(/^\s*type:\s*(\S+)/m);
  if (!/^metadata:/m.test(fm) || !typeMatch) {
    warnings.push('missing `metadata.type:` (user|feedback|project|reference)');
  } else if (!VALID_TYPES.includes(typeMatch[1].replace(/['"]/g, ''))) {
    warnings.push(
      `metadata.type "${typeMatch[1]}" not one of: ${VALID_TYPES.join(', ')}`
    );
  }
  return warnings;
}

function emit(message) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        additionalContext: message,
      },
    })
  );
}

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  if (raw.length < MAX_STDIN) raw += chunk.substring(0, MAX_STDIN - raw.length);
});

process.stdin.on('end', () => {
  try {
    const input = JSON.parse(raw || '{}');
    const toolInput = input.tool_input || {};
    const filePath = toolInput.file_path;

    if (!isMemoryNote(filePath)) process.exit(0);

    let content;
    try {
      content = fs.readFileSync(path.resolve(filePath), 'utf8');
    } catch {
      process.exit(0); // file gone / unreadable — nothing to validate
    }

    const warnings = validate(content);
    if (warnings.length > 0) {
      emit(
        `Memory note frontmatter issues in ${path.basename(filePath)} ` +
          `(fix per CLAUDE.md memory schema):\n- ${warnings.join('\n- ')}\n` +
          `Also add a one-line pointer to MEMORY.md and link related memories with [[name]].`
      );
    }
  } catch {
    // Non-blocking
  }
  process.exit(0);
});
