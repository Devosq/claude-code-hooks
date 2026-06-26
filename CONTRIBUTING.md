# Contributing

Contributions welcome!

## Guidelines
- Each hook is **one self-contained Node script, zero dependencies** (stdlib only).
  Keep it that way.
- Read the tool payload as JSON from stdin; `exit 2` to block (reason to stderr),
  `exit 0` to allow.
- `node --check hooks/*.js` must pass (CI enforces it).
- Conventional Commits, English. No personal/business specifics or secrets.
