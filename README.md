# claude-code-hooks

> Reusable, self-contained **guard-rail hooks** for [Claude Code](https://claude.com/claude-code).
> Drop them into your hooks dir, wire them in `settings.json`, and the agent gets
> mechanical safety rails it can't talk its way past.

![CI](https://github.com/Devosq/claude-code-hooks/actions/workflows/ci.yml/badge.svg)
![Node](https://img.shields.io/badge/node-%3E%3D18-blue)
![License: MIT](https://img.shields.io/badge/license-MIT-green)

Each hook is a single Node script with **zero dependencies** (Node stdlib only).
A non-zero `exit 2` blocks the tool call and shows the reason to the agent;
`exit 0` allows it.

## The hooks

### 🛡 Guard-rails (PreToolUse — block bad actions)
| Hook | What it does |
|------|--------------|
| `block-no-verify.js` | Blocks `git commit/push --no-verify` (and `-n`) so pre-commit hooks can't be skipped. |
| `config-protection.js` | Blocks edits that would weaken quality configs (`.eslintrc`, `tsconfig.json`, etc.) to make checks pass. |
| `doc-file-warning.js` | Warns before creating stray doc/markdown files (keeps repos from filling with `NOTES.md`). |
| `pre-tool-overnight-guard.js` | In **unattended runs** only, blocks destructive commands & production paths (deploy, migration, auth, secrets). |

### 💸 Budget (PostToolUse)
| Hook | What it does |
|------|--------------|
| `cost-cap-enforce.js` | In **unattended runs** only, tracks token spend against a soft warning + hard cap; writes a `STOP-NOW` flag (optional Telegram alert) when exceeded. |

### 🧠 Memory & learning (PostToolUse / SessionStart)
| Hook | What it does |
|------|--------------|
| `validate-memory-write.js` | Validates frontmatter on memory-file writes (keeps the memory store well-formed). |
| `session-start-hot-learnings.js` | Injects `~/.learnings/HOT.md` into context at session start, so past lessons are active. |
| `session-start-hot-size.js` | Warns when `HOT.md` grows past its line budget (time to trim). |
| `session-start-memory-size.js` | Warns when `MEMORY.md` grows too large to load fully. |

> The memory/learning hooks pair with the
> [`claude-memory-system`](https://github.com/Devosq/claude-memory-system) patterns.
> The two "unattended run" hooks activate only when `CLAUDE_INSTANCE_ID` is set,
> so they're inert during normal interactive use.

## Install
```bash
git clone https://github.com/Devosq/claude-code-hooks
cp claude-code-hooks/hooks/*.js ~/.claude/hooks/
```

## Wire them in `settings.json`
See [`examples/settings.hooks.json`](./examples/settings.hooks.json) for a full
example. The shape:
```json
{
  "hooks": {
    "PreToolUse": [
      { "matcher": "Bash", "hooks": [{ "type": "command", "command": "node ~/.claude/hooks/block-no-verify.js" }] },
      { "matcher": "Edit|Write", "hooks": [{ "type": "command", "command": "node ~/.claude/hooks/config-protection.js" }] }
    ],
    "PostToolUse": [
      { "matcher": "Write|Edit", "hooks": [{ "type": "command", "command": "node ~/.claude/hooks/validate-memory-write.js" }] }
    ],
    "SessionStart": [
      { "hooks": [{ "type": "command", "command": "node ~/.claude/hooks/session-start-hot-learnings.js" }] }
    ]
  }
}
```

## Conventions
- **Exit codes:** `0` allow · `2` block (reason → stderr, shown to the agent).
- **Input:** hooks read the tool-call payload as JSON on stdin (Claude Code's hook contract).
- **No dependencies:** Node stdlib only — nothing to `npm install`.

## Development
```bash
node --check hooks/*.js   # CI runs this — every hook must parse
```

## License
[MIT](./LICENSE) © Oscar Vatanen
