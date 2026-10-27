# opencode-local-memory

**Local-first, automatic persistent memory plugin for OpenCode**: recalls relevant facts and session summaries automatically on every turn, stores new decisions and preferences as plain local markdown with local CPU embeddings, checkpoints session compactions automatically, and includes a zero-token `/memory` TUI popup.

![opencode-local-memory TUI preview](./assets/screenshot.png)

## Background

This plugin started as a folder of markdown files and CLI scripts wired together through instructions in `AGENTS.md`. That setup worked on one machine, but every new environment needed the same prompt rules, and searching memory from the chat meant spending model tokens on a script call.

`opencode-local-memory` packages that workflow into a self-contained OpenCode plugin:

1. **Human-readable markdown is the source of truth**: Atomic facts live in `topics/*.md` and session summaries live in `sessions/*.md`. You can read, edit, or back them up like any ordinary text files.
2. **Local CPU embeddings (`vectors.json`)**: Uses `@xenova/transformers` (`Xenova/all-MiniLM-L6-v2`) inside the OpenCode process to embed and search entries on CPU without external servers or API keys.
3. **Self-contained lifecycle hooks**: The plugin's `context` hook recalls relevant memories for each prompt and injects the storage and recall rules directly into `<local-memory-plugin>`, so you do not need custom `AGENTS.md` instructions.
4. **Zero-token TUI search & store**: Browse, filter, and add memories directly inside OpenCode via `/memory` and `/memory-add` without making an LLM request.

## Features

| Feature | Details |
| :--- | :--- |
| Local-first, zero-token TUI & CPU embeddings | Runs 384-dimensional `Xenova/all-MiniLM-L6-v2` embeddings locally on CPU and provides a zero-token `/memory` TUI browser with no cloud API keys or external servers |
| Human-readable markdown source of truth | Stores atomic facts in `topics/*.md` and session checkpoints in `sessions/*.md` so every memory stays plain, editable markdown |
| Automatic per-turn recall (`context` hook) | Before each model call, injects `core: true` pinned invariants and runs hybrid semantic + field-weighted Okapi BM25 search (`vectors.json`, with `project` scoping and umbrella-root detection) against the user's prompt |
| Atomic fact storage & lifecycle (`memory_store`, `memory_delete`, `/memory-add`, `/memory-delete`) | Appends or updates blocks in `topics/<topic>.md`, auto-increments sequential IDs (`<prefix>-<nnn>`), prunes `supersedes` IDs, registers new topic files in `memory.md`, and writes `vectors.json` atomically |
| Automatic session checkpoints (`compaction` hook) | Captures distilled session summaries (`sessions/YYYY-MM-DD_<slug>-<NN>.md`) automatically on session compaction or via `memory_checkpoint` and indexes them into `vectors.json` |
| Interactive `/memory` TUI modal | Wide (`80%` default, configurable via `dialogWidth`) split-pane browser with colored filter pills (`^t` type, `^g` topic, `^r` mode, `^b` import, `^l` resync), instant 0ms lexical filtering refined by local vector similarity, and full session markdown preview |
| Zero-token history & rule import (`/memory-import`) | Imports existing `AGENTS.md` / `CLAUDE.md` rules into `topics/*.md` and compacted session summaries from `opencode.db` into `sessions/*.md` idempotently via `/memory-import`, `^b` inside `/memory`, or `npx @nandoblanco/opencode-local-memory import` |
| Automatic first-run bootstrap | On a blank install, automatically creates `~/.config/opencode/memory` (or `$XDG_CONFIG_HOME/opencode/memory`) with `memory.md`, starter `topics/{preferences,decisions,environment,agent-behavior}.md`, and `sessions/README.md` |

## Installation

### Option 1: One-Command Install (Recommended)

Run the built-in installer to automatically register the server and TUI plugins in `~/.config/opencode/opencode.jsonc` and `~/.config/opencode/cli.json` (preserving existing comments and settings), create `~/.config/opencode/memory`, and pre-warm the local embedding model:

```sh
npx @nandoblanco/opencode-local-memory install
```

Or specify a custom memory folder:

```sh
npx @nandoblanco/opencode-local-memory install --dir ~/my-memory
```

You can also install directly with OpenCode's native plugin CLI (because `package.json` exports both `.` and `./tui`, OpenCode loads both the server plugin and TUI popup automatically):

```sh
opencode plugin add @nandoblanco/opencode-local-memory
# or directly from GitHub:
opencode plugin add github:nandoblanco/opencode-local-memory
```

### Option 2: Manual Configuration

Add `@nandoblanco/opencode-local-memory` to `~/.config/opencode/opencode.jsonc` and `~/.config/opencode/cli.json`:

```jsonc
{
	"plugins": [
		{
			"package": "@nandoblanco/opencode-local-memory",
			"options": {
				"directory": "~/.config/opencode/memory",
				"minScore": 0.38,
				"topK": 6,
				"dialogWidth": "80%"
			}
		}
	]
}
```

### From a Local Directory

Clone this repository, run `npm install`, and run `node ./index.js install` (or reference `"file:///path/to/opencode-local-memory"` in `opencode.jsonc` and `cli.json`):

```json
{
	"plugins": ["file:///path/to/opencode-local-memory"]
}
```

## Usage

### Automatic Agent Memory (Server Tools & Hooks)

Once enabled, the plugin manages memory automatically during normal coding sessions:

- **Automatic Storage & Lifecycle (`memory_store` & `memory_delete`)**: When you state a preference or coding convention, make an architectural decision, uncover a non-obvious environment fact, or correct the agent, the model calls `memory_store` before finishing its turn. When replacing or removing outdated facts, it updates entries in place via `id`, prunes superseded entries via `supersedes`, or calls `memory_delete`.
- **Automatic Recall (`context` hook + `memory_search`)**: The `context` hook injects pinned `core: true` memories and relevant prompt matches (scoped to the active project or `global`, with automatic nested-project detection from umbrella roots) before each turn. For broader lookups, the model calls `memory_search` (`hybrid`, `semantic`, or `grep`).
- **Automatic Checkpoints (`compaction` hook + `memory_checkpoint`)**: The plugin writes numbered session summaries to `sessions/YYYY-MM-DD_<slug>-<NN>.md` and indexes them into `vectors.json`.

### Zero-Token TUI Commands

1. **Interactive `/memory` popup**: Run `/memory` (or `/memory <query>`) or press `Ctrl+P` and select `Search local memory (0 tokens)...`.
2. **Direct zero-token storage (`/memory-add`)**: Run `/memory-add <topic> | <tags> | <fact>` to append a fact and embed it into `vectors.json` immediately without invoking the AI:
   ```text
   /memory-add preferences | css, layout | Always verify layout changes with Playwright before reporting completion.
   ```
3. **Direct zero-token deletion (`/memory-delete`)**: Run `/memory-delete <id>` (supports comma-separated IDs) to remove outdated entries from their markdown source files and `vectors.json` immediately:
   ```text
   /memory-delete env-007, dec-002
   ```
4. **Import existing history (`/memory-import`)**: Run `/memory-import [limit]` (or press `^b` inside `/memory`) to import existing `AGENTS.md` / `CLAUDE.md` rules and past compacted session summaries from `opencode.db` without duplicating existing entries.
5. **Custom keybind**: Bind `local.memory.search` in `~/.config/opencode/cli.json`:
   ```json
   {
   	"keybinds": {
   		"local.memory.search": "ctrl+m"
   	}
   }
   ```

## TUI Query Syntax (`/memory`)

Type filters inline in the search bar or toggle them with clickable filter pills and keyboard shortcuts.

| Syntax | Description | Example |
| :--- | :--- | :--- |
| `term1 term2` | Hybrid semantic (`Xenova/all-MiniLM-L6-v2`) + lexical search | `winnipeg velocity cards` |
| `/pattern/i` or `re:pattern` | Regular expression match across ID, tags, fact, and file path | `/dec-01[0-9]/i` |
| `type:topics` / `type:sessions` / `type:all` | Filter to atomic topic facts (`topics/*.md`) or session checkpoints (`sessions/*.md`) (`type:facts`, `in:topics`, `in:sessions` also work) | `type:sessions plugin` |
| `topic:<slug>` | Filter to a specific topic file (`topics/<slug>.md`) | `topic:decisions self-contained` |
| `project:<slug>` | Filter to a specific project scope (`global`, `cms/<client>`, `git/<repo>`, or repo name) | `project:butte calendar` |
| `core:true` or `is:core` | Filter to pinned core memories (`core: true`) | `is:core` |

## Keyboard Shortcuts (`/memory`)

| Key | Action |
| :--- | :--- |
| `Enter` | Copy the selected memory entry (`[id] (file): fact`) to the clipboard and close the popup |
| `Up` / `Down` or `Ctrl+K` / `Ctrl+N` | Move selection up or down (`j`/`k` also work when the Results List pane is focused) |
| `PageUp` / `PageDown` or `Ctrl+U` / `Ctrl+D` | Jump 6 items up/down (or scroll the right Preview pane by 8 lines when focused) |
| `Tab` / `Shift+Tab` | Switch focus between Search Input, Results List, and Preview Pane |
| `Ctrl+T` | Cycle entry type filter pill (`all` -> `topics` -> `sessions`) |
| `Ctrl+G` | Cycle topic file filter pill (`all` -> `decisions` -> `preferences` -> `environment` -> ...) |
| `Ctrl+R` | Cycle search mode pill (`hybrid` -> `keyword` -> `regex`) |
| `Ctrl+B` | Import existing `AGENTS.md` / `CLAUDE.md` rules and compacted `opencode.db` sessions |
| `Ctrl+L` | Force resync markdown files (`topics/*.md` + `sessions/*.md`) into `vectors.json` |
| `Esc` | Close popup |

## How It Works (Architecture & Internals)

### 1. Memory Directory Resolution & First-Run Bootstrap (`resolveMemoryDir` & `ensureMemoryLayout`)

When the plugin initializes, `resolveMemoryDir()` selects the active memory directory in this order:

1. Explicit `directory` option in `opencode.jsonc` / `cli.json` (supports `~` expansion)
2. `OPENCODE_MEMORY_DIR` environment variable
3. Parent directory of `index.js` if both `memory.md` and `topics/` already exist there
4. `$XDG_CONFIG_HOME/opencode/memory` or `~/.config/opencode/memory` (default)

On startup and before any write or sync operation, `ensureMemoryLayout(rootDir)` checks the target directory. If `memory.md`, `topics/`, or `sessions/` are missing, it creates the directory tree, writes `memory.md` and `sessions/README.md`, and initializes four starter topic files (`preferences.md`, `decisions.md`, `environment.md`, `agent-behavior.md`). No pre-existing files are overwritten.

### 2. Per-Turn System Prompt Injection (`context` Hook)

Before each model turn, the server plugin's `ctx.session.hook("context")` handler inspects the conversation and appends a `<local-memory-plugin>` block to `event.system`:

1. **Dynamic topic discovery**: Scans `topics/*.md` via `getTopicSlugs()` and lists every available topic slug, instructing the model that passing any new slug to `memory_store` will create a new topic file automatically.
2. **Automatic storage triggers**: Instructs the model to call `memory_store` in the same turn whenever:
   - The user states a preference, convention, or workflow rule
   - An architectural, workflow, or design decision is made
   - A non-obvious environment, path, port, or tooling fact is discovered
   - A recurring pattern emerges
   - The user corrects the model or repeats an instruction
3. **Global vs. project scope & pinned core memories (`normalizeProjectScope` & `getCoreMemories`)**: Directs cross-project facts to `project: "global"` (default) and project-specific facts to nested scopes (`cms/<client>`, `git/<repo>`, or repo name). When launched from an umbrella workspace root, `detectProjectsFromText()` detects referenced project names in the prompt (or falls back across nested scopes), and `getCoreMemories()` pins `core: true` invariants on every turn.
4. **Per-prompt auto-recall**: Extracts the latest user message (`extractLastUserText`), runs a hybrid semantic + BM25 lexical search against `vectors.json` when the prompt is at least 5 characters long, filters hits with `score >= minScore` (default `0.38`, top `topK = 6`), and injects matching facts directly into `<local-memory-plugin>`.

### 3. How Topic Files & IDs Are Created (`memory_store`, `storeMemoryFact` & `deleteMemoryEntry`)

When a storage trigger fires (or when you run `/memory-add` or `npx @nandoblanco/opencode-local-memory store`), `storeMemoryFact(rootDir, input)` executes an atomic write-and-embed pipeline:

1. **Choosing an existing vs. new topic**: The model checks the injected `Available topics` list. If the fact matches an existing category (`preferences`, `decisions`, `environment`, `agent-behavior`), it passes that slug. If the fact belongs to a new domain (for example, `tools`, `sql`, or `frontend-css-patterns`), it passes a new kebab-case slug.
2. **Automatic topic file creation**: Normalizes the slug via `.toLowerCase().replace(/[^a-z0-9-_]/g, "-")`. If `topics/<slug>.md` does not exist yet, the plugin creates it with a `# <Slug>` heading and appends `- \`topics/<slug>.md\` - <slug> entries` to `memory.md`.
3. **Sequential ID generation & lifecycle (`nextTopicId` & `deleteMemoryEntry`)**: Scans existing `- id: <prefix>-<nnn>` blocks in `topics/<slug>.md`, preserves the file's prefix convention (for example, `dec-016` increments to `dec-017`, while a new `tools.md` file starts at `tools-001`), and formats the new YAML-style entry block with today's `YYYY-MM-DD` date. Passing an existing `id` updates that block in place, and passing `supersedes` (or calling `deleteMemoryEntry`) removes outdated IDs from their markdown source files automatically.
4. **Immediate vector indexing**: Embeds `fact + " " + tags` into a 384-dimensional vector and writes `vectors.json` atomically (`vectors.json.tmp.<pid>`) so the fact is searchable on the very next turn.

### 4. Session Checkpoints & History Import (`memory_checkpoint`, `compaction` Hook & `importExistingMemory`)

`storeSessionCheckpoint(rootDir, input)` writes session summaries to `sessions/YYYY-MM-DD_<slug>-<NN>.md` in two ways:

1. **Model-initiated (`memory_checkpoint` tool)**: At the end of significant work sessions, the model passes a `slug`, `title`, and structured markdown `summary` (`What was built/fixed/decided`, `Key decisions`, `Problems solved`, `Outcome`).
2. **Automatic compaction (`compaction` hook)**: When OpenCode compacts a conversation (`ctx.session.hook("compaction")`), the plugin derives a 4-word slug from the last active user prompt, writes a numbered checkpoint file, records `.session-state`, and calls `syncVectors()` so the session summary is indexed into `vectors.json`.
3. **Idempotent rule & DB history import (`importExistingMemory`)**: Scans `AGENTS.md` / `CLAUDE.md` files (including `@path` includes) via `parseAgentsMarkdownRules()` and reads OpenCode's SQLite database (`session_v2` / `session_message` and V1 `session` / `message` / `part`) read-only via `importFromOpenCodeDb()`, deduplicating by normalized fact fingerprint and `**Session ID**` so re-running `/memory-import` never duplicates entries.

Checkpoint numbers (`-01`, `-02`, ...) auto-increment per `YYYY-MM-DD_<slug>` prefix so multiple checkpoints on the same day never collide.

### 5. Local Embedding Model, Hybrid Search & Caching (`syncVectors` & `searchMemory`)

`opencode-local-memory` uses `Xenova/all-MiniLM-L6-v2`, a 23 MB sentence-embedding model that converts any sentence into a 384-number vector representing its meaning:

```js
const mod = await import("@xenova/transformers");
const embed = await mod.pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2");
const out = await embed(text, { pooling: "mean", normalize: true });
const vec = Array.from(out.data); // -> [0.021, -0.084, 0.112, ... 384 numbers]
```

- **Semantic vs. keyword matching**: Exact keyword search (`grep`) only matches shared characters. If you store *"Always run backup.ps1 before editing"* and later ask *"how do we undo changes?"*, keyword search returns nothing because no words overlap. The embedding model places both sentences near each other in 384-dimensional space, so their dot product (`dot(queryVec, entry.vector)`) scores high even with zero shared words.
- **Model installation and local cache**: `@xenova/transformers` is a regular npm dependency in `package.json` that runs ONNX models on CPU inside Node.js or Bun (no Python or external server). On first run, `pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2")` downloads `onnx/model_quantized.onnx` (~23 MB) and `tokenizer.json` from Hugging Face into `node_modules/@xenova/transformers/.cache/Xenova/all-MiniLM-L6-v2/`. Every subsequent run loads the quantized model from local disk in milliseconds, offline.
- **Incremental vector sync (`syncVectors`)**: Parses all `topics/*.md` blocks and `sessions/*.md` summaries (with per-file `mtimeMs` caching in `parsedFileCache`) and compares each entry's `id`, `fact`, `tags`, `project`, and `core` against `vectors.json`. Unchanged entries reuse their cached 384-dimensional vectors and serialized JSON lines; only new or modified entries run through the embedding pipeline.
- **Scoring formula (`searchMemory` & `computeLexicalScore`)**:
   - `semanticScore`: Dot product (cosine similarity on L2-normalized vectors) between the 384-number query vector and each stored entry vector (`0.0` to `1.0`), computed in plain JavaScript in under 2 milliseconds.
   - `lexicalScore`: `+0.35` if the full lowercase query is an exact substring of the entry haystack (`id + tags + fact + file`), or up to `+0.35` using field-weighted Okapi BM25 (`buildCorpusStats` + `computeLexicalScore`) across `id` (`3.0x`), `tags` (`2.5x`), `file` (`1.5x`), and `fact` (`1.0x`) with stopword filtering.
   - Final score: `semanticScore + lexicalScore` in `hybrid` mode (default), `semanticScore` in `semantic` mode, or `lexicalScore` in `grep` mode.
- **In-memory & cross-process caching**:
   - `loadCachedVectors()` caches parsed entries in memory and validates `vectors.json` via `fs.statSync(vecFile).mtimeMs` and resolved path (`cachedRootDir`), automatically reloading if another process or CLI command updates `vectors.json`.
   - `queryVecCache` keeps an in-memory 128-entry FIFO cache of normalized query embeddings to avoid re-embedding repeated prompts.
   - `lastContextKey` caches the generated `<local-memory-plugin>` system block per `(userText, cachedVersion)` pair so duplicate hook invocations within the same turn do zero extra work.

### 6. Interactive OpenTUI `/memory` Modal Architecture (`tui.ts`)

1. **Wide modal layout (`applyDialogWidth` & `dialog.set`)**:
   - Calls `context.ui.dialog.show(...)` followed by `context.ui.dialog.set({ size: "xlarge", centered: true })` so the dialog opens wide without being reset to default width.
   - Inside `onMount` and `ref`, `applyDialogWidth()` walks upward from `rootRef` to the outer `absolute`-positioned dialog container and sets `width: "80%"` (or your configured `dialogWidth`), `maxWidth: "80%"`, and `minWidth: 76`.
2. **Two-phase 0ms lexical + async hybrid search (`runSearch`)**:
   - On every keystroke, `filterEntriesSync()` runs synchronously in 0ms against the in-memory `vectors.json` entries so the results list updates immediately with zero input lag.
   - When `mode` is `"hybrid"` and the query is at least 2 characters long, `runSearch()` then awaits `searchMemory(rootDir, q, "hybrid", 50)` (guarded by a monotonic `searchSeq` counter to discard stale async results) and refines the list with semantic vector similarity scores (`score >= 0.22`).
3. **Split-pane layout & full session markdown preview**:
   - Renders interactive `Pill` components beneath the search bar for `type:<filter>` (`^t`), `topic:<slug>` (`^g`), `mode:<mode>` (`^r`), `import` (`^b`), and `resync` (`^l`).
   - Splits the main body into a 44%-width left results list (entry ID, hybrid score, source file, and 1-line summary) and a 56%-width right preview pane (metadata card, search-term highlighted fact text, and full markdown file content via `readFullSessionMarkdown()` whenever a `sessions/*.md` checkpoint is selected).

### 7. Agent Tools Registered by the Server Plugin

| Tool Name | Required Inputs | Optional Inputs | Behavior |
| :--- | :--- | :--- | :--- |
| `memory_store` | `topic`, `tags`, `fact` | `id`, `supersedes`, `project` (default `global`), `core` (`boolean`) | Creates `topics/<topic>.md` if missing, registers it in `memory.md`, updates in place when `id` exists (or assigns the next `<prefix>-<nnn>` ID), prunes `supersedes` IDs, and updates `vectors.json`. |
| `memory_delete` | `id` | *(none)* | Deletes one or more memory entries by ID (or comma-separated IDs) from `topics/*.md` or `sessions/*.md` and updates `vectors.json`. |
| `memory_search` | `query` | `mode` (`hybrid`, `semantic`, `grep`), `topN` (default `8`), `project` (`all`, `global`, or project slug), `coreOnly` (`boolean`) | Searches topic facts and session checkpoints and returns ranked entries with scores, IDs, dates, file paths, tags, and facts. |
| `memory_checkpoint` | `slug`, `title`, `summary` | `project` (default `global`), `contextPct` | Writes `sessions/YYYY-MM-DD_<slug>-<NN>.md`, updates `.session-state`, and indexes the checkpoint into `vectors.json`. |

### 8. Token Usage Breakdown

Local embedding, TUI browsing, and direct `/memory-add`, `/memory-delete`, and `/memory-import` commands use zero LLM tokens:

| Operation | Token Cost | Why |
| :--- | :--- | :--- |
| Interactive `/memory` TUI modal (`Ctrl+M`) | **0 tokens** | Reads `vectors.json` and `sessions/*.md` directly from disk and runs `Xenova/all-MiniLM-L6-v2` locally on CPU without an LLM request |
| Direct TUI fact storage & deletion (`/memory-add`, `/memory-delete`) | **0 tokens** | Appends or deletes entries in `topics/*.md` and updates `vectors.json` locally in Node.js |
| History & rule import (`/memory-import`, `Ctrl+B`) | **0 tokens** | Parses `AGENTS.md` / `CLAUDE.md` rules and reads compacted `opencode.db` sessions directly via SQLite and local embeddings |
| Automatic compaction checkpoint (`compaction` hook) | **0 extra turn tokens** | Captures the existing compaction summary event and indexes it locally into `sessions/*.md` and `vectors.json` |
| Standalone CLI (`npx @nandoblanco/opencode-local-memory ...`) | **0 tokens** | Runs directly in Node.js outside the model turn |
| Per-turn auto-recall (`context` hook) & agent tools | **~250-450 system/schema tokens** | Injects compact instructions plus pinned `core` memories and top matching facts (`score >= 0.38`, max `topK = 6`) into `event.system` and registers `memory_store`, `memory_delete`, `memory_search`, and `memory_checkpoint` |

## Directory Structure

```text
~/.config/opencode/memory/
├── memory.md                  # Global index of topic files
├── vectors.json               # Local 384-dim embeddings cache (auto-maintained)
├── topics/
│   ├── preferences.md         # User coding style and workflow rules
│   ├── decisions.md           # Architectural and cross-project decisions
│   ├── environment.md         # Machine, OS, paths, and tooling facts
│   └── agent-behavior.md      # Corrections and operational protocols
└── sessions/
    ├── README.md
    └── YYYY-MM-DD_slug-01.md  # Distilled session checkpoints
```

Each entry in `topics/<topic>.md` uses a clean, human-editable block format:

```yaml
- id: dec-016
  date: 2026-10-25
  project: global
  core: true
  tags: [opencode, plugin, local-memory, self-contained]
  fact: All persistent memory rules are injected directly by opencode-local-memory's context hook.
```

## CLI Commands

```sh
# One-command setup: updates opencode.jsonc + cli.json, scaffolds memory/, and warms vectors.json
npx @nandoblanco/opencode-local-memory install [--dir /path/to/memory] [--import]

# Import existing AGENTS.md/CLAUDE.md rules and compacted session summaries from opencode.db
npx @nandoblanco/opencode-local-memory import [--dir /path/to/memory] [--db /path/to/opencode.db] [--agents /path/to/AGENTS.md] [--limit 40]

# Incrementally sync topics/*.md and sessions/*.md into vectors.json
npx @nandoblanco/opencode-local-memory sync

# Hybrid, semantic, or exact keyword search
npx @nandoblanco/opencode-local-memory search "query" [hybrid|semantic|grep] [topN]

# Exact keyword grep
npx @nandoblanco/opencode-local-memory recall "exact keyword"

# Store a new fact from the command line
npx @nandoblanco/opencode-local-memory store decisions "arch, api" "Use REST endpoints for batch exports."

# Delete one or more entries by ID (or comma-separated IDs)
npx @nandoblanco/opencode-local-memory delete dec-002
```

## Configuration Options

Options can be passed in `~/.config/opencode/opencode.jsonc` and `~/.config/opencode/cli.json` or via environment variables:

```jsonc
{
	"plugins": [
		{
			"package": "@nandoblanco/opencode-local-memory",
			"options": {
				"directory": "~/.config/opencode/memory",
				"minScore": 0.38,
				"topK": 6,
				"dialogWidth": "80%"
			}
		}
	]
}
```

| Option | Env Variable | Default | Description |
| :--- | :--- | :--- | :--- |
| `directory` | `OPENCODE_MEMORY_DIR` | `~/.config/opencode/memory` | Path to the persistent memory directory (`memory.md`, `topics/`, `sessions/`, `vectors.json`) |
| `minScore` | *(none)* | `0.38` | Minimum hybrid similarity score (`0.0`-`1.0`) for per-prompt auto-recall injection |
| `topK` | *(none)* | `6` | Maximum auto-recalled facts injected per turn |
| `dialogWidth` | `OPENCODE_MEMORY_DIALOG_WIDTH` | `"80%"` | Width of the centered `/memory` TUI modal (`"80%"` or column count like `120`; also respects `OPENCODE_DIALOG_WIDTH`) |

## License

MIT
