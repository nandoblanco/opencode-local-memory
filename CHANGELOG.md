# Changelog

## 1.3.0 (2026-11-17)

- Removed the trailing keyboard shortcut badge (`Ctrl+Shift+M`) from the left sidebar `vertical-tabs-memories` button and added `whitespace-nowrap` so sidebar button labels do not wrap (`gui.tsx`).
- Kept the `<local-memory-plugin>` system block constant per session in the `context` hook to preserve prompt cache hits across turns.
- Added `maintainMemory()` (`npx @nandoblanco/opencode-local-memory maintain` / `clean`, `--prune-imported`) and automatic 24-hour background maintenance via `.last-maintain` to deduplicate topic facts and prune auto-compaction stub files.
- Required an explicit compaction summary (`>= 40` chars) before writing compaction checkpoints and capped auto-recalled `session:` entries at 2 per turn.

## 1.2.0 (2026-11-12)

- Added OpenCode Desktop Memory Manager (`gui.tsx`, `gui.css`, `dist/gui-experimental.cjs`, and `MemoryRpc` in `rpc.js`) with a persistent side panel (`Ctrl+Shift+M` to open/focus, `Ctrl+Alt+M` to toggle), fallback dialog when no session is active, query and project filters, inline fact creation/editing, core pinning (`core: true`), entry deletion, rule/session import, and index resync.
- Added interactive fact creation, editing, core pin/unpin, and deletion confirmation inside the `/memory` TUI modal (`tui.ts`).
- Pinned patched `glob` and `minimatch` versions in development dependency overrides (`package.json`).

## 1.1.1 (2026-10-28)

- Refined the `/memory` OpenTUI modal layout (`tui.ts`) with a bordered filter bar and split-pane preview cards.

## 1.1.0 (2026-10-27)

- Added zero-token rule and history importer (`importRulesAndSessions` in `index.js`, `/memory-import`, `Ctrl+B` in `/memory`, and `npx @nandoblanco/opencode-local-memory import`) to import `AGENTS.md` / `CLAUDE.md` rules into `topics/*.md` and compacted session summaries from `opencode.db` into `sessions/*.md`.
- Added `memory_delete` agent tool, `/memory-delete` slash command, and `supersedes` replacement pruning on `memory_store`.
- Added `project` scoping (`global` vs. project-specific memories with umbrella-root detection) and `core: true` pinned invariants injected on every turn.
- Upgraded hybrid search (`searchMemories`) to combine 384-dimensional `Xenova/all-MiniLM-L6-v2` cosine similarity with field-weighted Okapi BM25 scoring.

## 1.0.1 (2026-10-26)

- Scoped npm package as `@nandoblanco/opencode-local-memory` with public `publishConfig` and normalized `bin` and `repository` fields.
- Hardened tag and entry ID sanitization, ONNX runtime lifecycle cleanup, concurrent `syncVectors` serialization, and comment-preserving JSONC config installation (`installPlugin`).

## 1.0.0 (2026-10-25)

- Initial release of `opencode-local-memory` for OpenCode.
- Added local markdown memory storage (`topics/*.md` and `sessions/*.md`), CPU vector indexing (`vectors.json` via `@huggingface/transformers`), automatic per-turn recall (`context` hook), session compaction checkpoints (`compaction` hook), agent tools (`memory_search`, `memory_store`, `memory_checkpoint`), and the zero-token `/memory` TUI browser (`tui.ts`).
