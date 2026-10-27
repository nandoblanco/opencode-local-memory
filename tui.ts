"use strict";

import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { TuiPluginContext } from "@opencode-ai/plugin/tui";
import { TextAttributes } from "@opentui/core";
import {
  createComponent,
  createElement,
  createTextNode,
  effect,
  insert,
  insertNode,
  setProp,
  use,
} from "@opentui/solid";
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  onCleanup,
  onMount,
  Show,
} from "solid-js";
import {
  deleteMemoryEntry,
  getTopicSlugs,
  importExistingMemory,
  loadCachedVectors,
  matchesProjectScope,
  resolveMemoryDir,
  searchMemory,
  storeMemoryFact,
  syncVectors,
} from "./index.js";

interface MemoryEntry {
  id: string;
  date: string;
  file: string;
  tags: string;
  fact: string;
  project?: string;
  core?: boolean;
  vector?: number[];
  _haystack?: string;
}

interface MemoryHit {
  score: number;
  semanticScore: number;
  entry: MemoryEntry;
}

type TypeFilter = "all" | "topics" | "sessions";
type ModeFilter = "hybrid" | "keyword" | "regex";

const TYPE_CYCLE: TypeFilter[] = ["all", "topics", "sessions"];
const MODE_CYCLE: ModeFilter[] = ["hybrid", "keyword", "regex"];
const CLI_SCRIPT_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "index.js");

function runCliSubprocess(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const baseEnv = { ...process.env, OPENCODE_MEMORY_SUBPROCESS: "1" };
    execFile("node", [CLI_SCRIPT_PATH, ...args], { env: baseEnv, windowsHide: true, timeout: 120000 }, (err, stdout) => {
      if (!err) return resolve(String(stdout || ""));
      const bunEnv = { ...baseEnv, BUN_BE_BUN: "1" };
      execFile(process.execPath, [CLI_SCRIPT_PATH, ...args], { env: bunEnv, windowsHide: true, timeout: 120000 }, (err2, stdout2) => {
        if (err2) return reject(err);
        resolve(String(stdout2 || ""));
      });
    });
  });
}

async function safeSyncVectors(rootDir: string) {
  try {
    return await syncVectors(rootDir);
  } catch {
    await runCliSubprocess(["sync", "--dir", rootDir]);
    const loaded = (loadCachedVectors(rootDir) || []) as MemoryEntry[];
    return { total: loaded.length, embedded: 0, reused: loaded.length, vecFile: path.join(rootDir, "vectors.json") };
  }
}

async function safeImportMemory(rootDir: string, limit?: number) {
  try {
    return await importExistingMemory(rootDir, { limit });
  } catch {
    const args = ["import", "--dir", rootDir, "--json"];
    if (limit) args.push("--limit", String(limit));
    const stdout = await runCliSubprocess(args);
    const lines = stdout.trim().split(/\r?\n/).filter(Boolean);
    return JSON.parse(lines[lines.length - 1]);
  }
}

function splitHighlightedText(
  text: string,
  term: string
): Array<{ text: string; match: boolean }> {
  if (!term || !term.trim()) {
    return [{ text, match: false }];
  }
  const words = term
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length >= 2 && !w.includes(":"));
  if (!words.length) {
    const fallback = term.trim().toLowerCase();
    if (fallback && !fallback.includes(":")) words.push(fallback);
  }
  if (!words.length) return [{ text, match: false }];

  const parts: Array<{ text: string; match: boolean }> = [];
  const lower = text.toLowerCase();
  let cursor = 0;

  while (cursor < text.length) {
    let bestIdx = -1;
    let bestLen = 0;
    for (const w of words) {
      const idx = lower.indexOf(w, cursor);
      if (idx !== -1 && (bestIdx === -1 || idx < bestIdx || (idx === bestIdx && w.length > bestLen))) {
        bestIdx = idx;
        bestLen = w.length;
      }
    }
    if (bestIdx === -1) {
      parts.push({ text: text.slice(cursor), match: false });
      break;
    }
    if (bestIdx > cursor) {
      parts.push({ text: text.slice(cursor, bestIdx), match: false });
    }
    parts.push({ text: text.slice(bestIdx, bestIdx + bestLen), match: true });
    cursor = bestIdx + bestLen;
  }
  return parts.length ? parts : [{ text, match: false }];
}

function isSafeSubPath(parentDir: string, targetPath: string): boolean {
  const rel = path.relative(path.resolve(parentDir), path.resolve(targetPath));
  return Boolean(rel && !rel.startsWith("..") && !path.isAbsolute(rel));
}

function isSafeRegexPattern(pattern: string): boolean {
  if (!pattern || pattern.length > 256) return false;
  // Reject nested quantifiers such as (a+)+, (.*)*, ([a-z]+){2,} that cause catastrophic backtracking
  if (/(\([^()]*[+*?][^()]*\))\s*[+*?{]/.test(pattern)) return false;
  return true;
}

function readFullSessionMarkdown(rootDir: string, relFile: string): string {
  try {
    const fullPath = path.resolve(rootDir, relFile);
    if (!isSafeSubPath(rootDir, fullPath)) return "";
    if (fs.existsSync(fullPath)) {
      return fs.readFileSync(fullPath, "utf8").replace(/\r\n/g, "\n").trim();
    }
  } catch {
    // ignore read error
  }
  return "";
}

interface DialogProps {
  context: TuiPluginContext;
  rootDir: string;
  initialQuery: string;
  close: () => void;
}

function createTuiRenderer() {
  function el(
    tag: string,
    props?: Record<string, unknown> | null,
    ...children: unknown[]
  ) {
    const node = createElement(tag);
    if (props) {
      for (const [key, val] of Object.entries(props)) {
        if (val === undefined) continue;
        if (key === "ref" && typeof val === "function") {
          use(val as (e: unknown) => void, node, undefined);
        } else if (
          typeof val === "function" &&
          !key.startsWith("on") &&
          key !== "renderBefore"
        ) {
          effect((prev: unknown) => setProp(node, key, (val as () => unknown)(), prev));
        } else {
          setProp(node, key, val);
        }
      }
    }
    for (const child of children) {
      if (child === undefined || child === null || child === false) continue;
      if (typeof child === "string") {
        insertNode(node, createTextNode(child));
      } else {
        insert(node, child);
      }
    }
    return node;
  }

  function LocalMemoryDialog(props: DialogProps) {
    const [query, setQuery] = createSignal(props.initialQuery);
    const [typeFilter, setTypeFilter] = createSignal<TypeFilter>("all");
    const [topicFilter, setTopicFilter] = createSignal<string>("all");
    const [mode, setMode] = createSignal<ModeFilter>("hybrid");
    const [focusPane, setFocusPane] = createSignal<"search" | "list" | "preview">("search");
    const [selectedIndex, setSelectedIndex] = createSignal(0);
    const [allEntries, setAllEntries] = createSignal<MemoryEntry[]>([]);
    const [hits, setHits] = createSignal<MemoryHit[]>([]);
    const [statusMsg, setStatusMsg] = createSignal("");

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let rootRef: any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let listScrollRef: any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let previewScrollRef: any;
    let searchSeq = 0;

    const resolveDialogWidth = (): string | number => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const opts = (props.context as any)?.options;
      const raw =
        opts?.dialogWidth ??
        opts?.width ??
        process.env.OPENCODE_MEMORY_DIALOG_WIDTH ??
        process.env.OPENCODE_DIALOG_WIDTH ??
        "80%";
      if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
        return raw <= 100 ? `${Math.round(raw)}%` : Math.round(raw);
      }
      if (typeof raw === "string") {
        const trimmed = raw.trim();
        if (/^\d+(\.\d+)?%$/.test(trimmed)) return trimmed;
        const num = Number(trimmed);
        if (Number.isFinite(num) && num > 0) {
          return num <= 100 ? `${Math.round(num)}%` : Math.round(num);
        }
      }
      return "80%";
    };

    const applyDialogWidth = () => {
      if (!rootRef) return;
      try {
        const targetWidth = resolveDialogWidth();
        let cursor = rootRef;
        let dialogBox = rootRef;
        while (cursor.parent && cursor.parent._positionType !== "absolute") {
          cursor = cursor.parent;
          dialogBox = cursor;
        }
        dialogBox.width = targetWidth;
        dialogBox.maxWidth = targetWidth;
        dialogBox.minWidth = 76;

        let inner = rootRef;
        while (inner && inner !== dialogBox) {
          inner.width = "100%";
          inner.maxWidth = "100%";
          inner = inner.parent;
        }
        rootRef.requestRender?.();
      } catch {
        // ignore layout mutation errors
      }
    };

    const theme = () => props.context.theme.surface("dialog");

    const topicsList = createMemo<string[]>(() => {
      const slugs = getTopicSlugs(props.rootDir) || [];
      return ["all", ...slugs];
    });

    const parseInlineFilters = (
      rawQ: string,
      tFilter: TypeFilter,
      topFilter: string,
      mFilter: ModeFilter
    ) => {
      let effType = tFilter;
      let effTopic = topFilter;
      let effMode = mFilter;
      let effProject = "all";
      let effCoreOnly = false;
      const tokens = rawQ.trim().split(/\s+/).filter(Boolean);
      const cleanTokens: string[] = [];

      for (const tok of tokens) {
        const lower = tok.toLowerCase();
        if (lower === "type:topics" || lower === "type:facts" || lower === "in:topics") {
          effType = "topics";
        } else if (lower === "type:sessions" || lower === "in:sessions") {
          effType = "sessions";
        } else if (lower === "type:all") {
          effType = "all";
        } else if (lower === "core:true" || lower === "is:core") {
          effCoreOnly = true;
        } else if (lower.startsWith("project:")) {
          const val = lower.slice(8).trim();
          if (val) effProject = val;
        } else if (lower.startsWith("topic:")) {
          const val = lower.slice(6).trim();
          if (val) effTopic = val;
        } else if (lower.startsWith("re:") && tok.length > 3) {
          effMode = "regex";
          cleanTokens.push(tok.slice(3));
        } else {
          cleanTokens.push(tok);
        }
      }

      return {
        cleanQ: cleanTokens.join(" ").trim(),
        effType,
        effTopic,
        effMode,
        effProject,
        effCoreOnly,
      };
    };

    const filterEntriesSync = (
      entries: MemoryEntry[],
      rawQ: string,
      tFilter: TypeFilter,
      topFilter: string,
      mFilter: ModeFilter
    ): MemoryHit[] => {
      const { cleanQ: q, effType, effTopic, effMode, effProject, effCoreOnly } = parseInlineFilters(
        rawQ,
        tFilter,
        topFilter,
        mFilter
      );

      const subset = entries.filter((e) => {
        if (effType === "topics" && !e.file.startsWith("topics/")) return false;
        if (effType === "sessions" && !e.file.startsWith("sessions/")) return false;
        if (effTopic !== "all" && e.file !== `topics/${effTopic}.md`) return false;
        if (effCoreOnly && !e.core) return false;
        if (effProject !== "all" && !matchesProjectScope(e.project, effProject, false)) return false;
        return true;
      });

      if (!q) {
        return subset
          .slice()
          .reverse()
          .map((e) => ({ score: 1, semanticScore: 0, entry: e }));
      }

      if (effMode === "regex" || (q.startsWith("/") && q.lastIndexOf("/") > 0)) {
        try {
          const lastSlash = q.startsWith("/") ? q.lastIndexOf("/") : -1;
          const pattern = lastSlash > 0 ? q.slice(1, lastSlash) : q;
          if (!isSafeRegexPattern(pattern)) return [];
          const flags = lastSlash > 0 ? q.slice(lastSlash + 1) || "i" : "i";
          const re = new RegExp(pattern, flags);
          return subset
            .filter((e) => re.test(e._haystack || `${e.id} ${e.tags} ${e.fact} ${e.file}`))
            .map((e) => ({ score: 1, semanticScore: 0, entry: e }));
        } catch {
          return [];
        }
      }

      const lowerQ = q.toLowerCase();
      const words = lowerQ.split(/\s+/).filter((w) => w.length >= 2);
      const scored: MemoryHit[] = [];

      for (const e of subset) {
        const hay = e._haystack || `${e.id} ${e.tags} ${e.fact} ${e.file}`.toLowerCase();
        let lex = 0;
        if (hay.includes(lowerQ)) {
          lex = 0.9;
        } else if (words.length > 0) {
          let matched = 0;
          for (const w of words) {
            if (hay.includes(w)) matched++;
          }
          if (matched > 0) {
            lex = (matched / words.length) * 0.75;
          }
        }
        if (lex > 0) {
          scored.push({ score: lex, semanticScore: 0, entry: e });
        }
      }

      scored.sort((a, b) => b.score - a.score);
      return scored;
    };

    const runSearch = async () => {
      const currentSeq = ++searchSeq;
      const entries = allEntries();
      const rawQ = query().trim();
      const tFilter = typeFilter();
      const topFilter = topicFilter();
      const mFilter = mode();
      const { cleanQ: q, effType, effTopic, effMode, effProject, effCoreOnly } = parseInlineFilters(
        rawQ,
        tFilter,
        topFilter,
        mFilter
      );

      // Instant synchronous pass first (0ms)
      const instant = filterEntriesSync(entries, rawQ, tFilter, topFilter, mFilter);
      setHits(instant);

      // If hybrid mode and non-empty query, refine with local vector similarity (0 LLM tokens)
      if (effMode === "hybrid" && q.length >= 2) {
        try {
          const semHits: MemoryHit[] = await searchMemory(props.rootDir, q, "hybrid", 50, {
            project: effProject,
            includeGlobal: effProject === "all",
            coreOnly: effCoreOnly,
          });
          if (currentSeq !== searchSeq) return;
          const filtered = semHits.filter((h) => {
            if (effType === "topics" && !h.entry.file.startsWith("topics/")) return false;
            if (effType === "sessions" && !h.entry.file.startsWith("sessions/")) return false;
            if (effTopic !== "all" && h.entry.file !== `topics/${effTopic}.md`) return false;
            return h.score >= 0.22;
          });
          setHits(filtered);
        } catch {
          // Keep instant lexical results on error
        }
      }
    };

    const reloadVectors = async (forceSync = false) => {
      if (forceSync) {
        setStatusMsg("syncing markdown -> vectors.json...");
        await safeSyncVectors(props.rootDir).catch(() => {});
        setStatusMsg("");
      }
      const loaded = (loadCachedVectors(props.rootDir) || []) as MemoryEntry[];
      setAllEntries(loaded);
      await runSearch();
    };

    const runImportInDialog = async () => {
      setStatusMsg("importing AGENTS.md & opencode.db...");
      try {
        const res = await safeImportMemory(props.rootDir);
        setStatusMsg("");
        const loaded = (loadCachedVectors(props.rootDir) || []) as MemoryEntry[];
        setAllEntries(loaded);
        await runSearch();
        props.context.ui.toast.show({
          title: "Memory Import Complete (0 tokens)",
          message: `Imported ${res.importedFacts.length} rules & ${res.importedSessions.length} sessions (${res.syncResult.total} total)`,
          variant: "success",
        });
      } catch (err) {
        setStatusMsg("");
        props.context.ui.toast.show({
          title: "Memory Import Error",
          message: err instanceof Error ? err.message : String(err),
          variant: "error",
        });
      }
    };

    createEffect(() => {
      query();
      typeFilter();
      topicFilter();
      mode();
      setSelectedIndex(0);
      queueMicrotask(() => listScrollRef?.scrollTo?.(0));
      void runSearch();
    });

    const selectedHit = createMemo<MemoryHit | undefined>(() => {
      const list = hits();
      if (!list.length) return undefined;
      const idx = Math.max(0, Math.min(list.length - 1, selectedIndex()));
      return list[idx];
    });

    const selectedSessionBody = createMemo<string>(() => {
      const h = selectedHit();
      if (!h || !h.entry.file.startsWith("sessions/")) return "";
      return readFullSessionMarkdown(props.rootDir, h.entry.file);
    });

    const moveSelection = (delta: number) => {
      const list = hits();
      if (!list.length) return;
      const next = Math.max(0, Math.min(list.length - 1, selectedIndex() + delta));
      setSelectedIndex(next);
      queueMicrotask(() => {
        listScrollRef?.scrollChildIntoView?.(`memory-row-${next}`);
        previewScrollRef?.scrollTo?.(0);
      });
    };

    const cycleType = () => {
      setTypeFilter((prev: TypeFilter) => TYPE_CYCLE[(TYPE_CYCLE.indexOf(prev) + 1) % TYPE_CYCLE.length]);
    };

    const cycleTopic = () => {
      const list = topicsList();
      setTopicFilter((prev: string) => list[(list.indexOf(prev) + 1) % list.length]);
    };

    const cycleMode = () => {
      setMode((prev: ModeFilter) => MODE_CYCLE[(MODE_CYCLE.indexOf(prev) + 1) % MODE_CYCLE.length]);
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const handleKeyPress = (event: any) => {
      const name = String(event.name || "").toLowerCase();

      if (name === "escape") {
        event.preventDefault();
        event.stopPropagation();
        props.close();
        return;
      }

      if (name === "tab") {
        event.preventDefault();
        event.stopPropagation();
        const order: Array<"search" | "list" | "preview"> = ["search", "list", "preview"];
        const idx = order.indexOf(focusPane());
        const next = order[(idx + (event.shift ? -1 : 1) + order.length) % order.length];
        setFocusPane(next);
        return;
      }

      if (event.ctrl && name === "t") {
        event.preventDefault();
        event.stopPropagation();
        cycleType();
        return;
      }
      if (event.ctrl && name === "g") {
        event.preventDefault();
        event.stopPropagation();
        cycleTopic();
        return;
      }
      if (event.ctrl && name === "r") {
        event.preventDefault();
        event.stopPropagation();
        cycleMode();
        return;
      }
      if (event.ctrl && name === "l") {
        event.preventDefault();
        event.stopPropagation();
        void reloadVectors(true);
        return;
      }
      if (event.ctrl && name === "b") {
        event.preventDefault();
        event.stopPropagation();
        void runImportInDialog();
        return;
      }

      if (name === "return" || name === "enter") {
        const current = selectedHit();
        if (current) {
          event.preventDefault();
          event.stopPropagation();
          const formatted = `[${current.entry.id}] (${current.entry.file}): ${current.entry.fact}`;
          try {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const uiAny = props.context.ui as any;
            if (uiAny.clipboard?.writeText) {
              void uiAny.clipboard.writeText(formatted);
            } else if (uiAny.clipboard?.copy) {
              void uiAny.clipboard.copy(formatted);
            }
          } catch {
            // ignore clipboard errors
          }
          props.context.ui.toast.show({
            title: `Selected [${current.entry.id}]`,
            message: `${current.entry.file}: ${current.entry.fact.slice(0, 90)}`,
            variant: "info",
          });
          props.close();
        }
        return;
      }

      if (
        name === "down" ||
        (event.ctrl && (name === "n" || name === "j")) ||
        (focusPane() !== "input" && !event.ctrl && name === "j")
      ) {
        event.preventDefault();
        event.stopPropagation();
        if (focusPane() === "preview" && !event.ctrl && name === "j") {
          previewScrollRef?.scrollBy?.(2);
        } else {
          moveSelection(1);
        }
        return;
      }
      if (
        name === "up" ||
        (event.ctrl && (name === "p" || name === "k")) ||
        (focusPane() !== "input" && !event.ctrl && name === "k")
      ) {
        event.preventDefault();
        event.stopPropagation();
        if (focusPane() === "preview" && !event.ctrl && name === "k") {
          previewScrollRef?.scrollBy?.(-2);
        } else {
          moveSelection(-1);
        }
        return;
      }
      if (name === "pagedown" || (event.ctrl && name === "d")) {
        event.preventDefault();
        event.stopPropagation();
        if (focusPane() === "preview") {
          previewScrollRef?.scrollBy?.(8);
        } else {
          moveSelection(6);
        }
        return;
      }
      if (name === "pageup" || (event.ctrl && name === "u")) {
        event.preventDefault();
        event.stopPropagation();
        if (focusPane() === "preview") {
          previewScrollRef?.scrollBy?.(-8);
        } else {
          moveSelection(-6);
        }
        return;
      }
    };

    onMount(() => {
      applyDialogWidth();
      queueMicrotask(applyDialogWidth);
      props.context.renderer.keyInput.prependListener("keypress", handleKeyPress);
      void reloadVectors(false);
    });

    onCleanup(() => {
      props.context.renderer.keyInput.removeListener("keypress", handleKeyPress);
    });

    const Pill = (pillProps: {
      label: () => string;
      shortcut?: string;
      active: () => boolean;
      onClick: () => void;
    }) =>
      el(
        "box",
        {
          flexDirection: "row",
          flexShrink: 0,
          paddingX: 1,
          backgroundColor: () =>
            pillProps.active()
              ? theme().background.action.primary.focused
              : theme().background.raised.base,
          onMouseUp: pillProps.onClick,
        },
        el(
          "text",
          {
            fg: () =>
              pillProps.active()
                ? theme().text.action.primary.focused
                : theme().text.base,
            attributes: () => (pillProps.active() ? TextAttributes.BOLD : undefined),
          },
          pillProps.label
        ),
        pillProps.shortcut
          ? el(
              "text",
              {
                fg: () =>
                  pillProps.active()
                    ? theme().text.action.primary.focused
                    : theme().text.muted,
              },
              ` ${pillProps.shortcut}`
            )
          : null
      );

    return el(
      "box",
      {
        ref: (r: unknown) => {
          rootRef = r;
          queueMicrotask(applyDialogWidth);
        },
        width: "100%",
        height: 28,
        flexDirection: "column",
        backgroundColor: () => theme().background.base,
      },
      // 1. Header Bar
      el(
        "box",
        {
          flexDirection: "row",
          justifyContent: "space-between",
          alignItems: "center",
          paddingX: 2,
          paddingTop: 1,
          flexShrink: 0,
        },
        el(
          "box",
          { flexDirection: "row", gap: 2, alignItems: "center" },
          el(
            "text",
            {
              fg: () => theme().text.base,
              attributes: TextAttributes.BOLD,
            },
            "Local Memory Search"
          ),
          el(
            "text",
            { fg: () => theme().text.muted },
            () =>
              statusMsg() ||
              `${hits().length} of ${allEntries().length} entries`
          )
        ),
        el(
          "box",
          { flexDirection: "row", gap: 2, alignItems: "center" },
          el(
            "text",
            { fg: () => theme().text.muted },
            () => props.context.ui.format.path(props.rootDir)
          ),
          el(
            "box",
            { paddingX: 1, onMouseUp: () => props.close() },
            el("text", { fg: () => theme().text.muted }, "esc")
          )
        )
      ),

      // 2. Search Input + Filter Pills
      el(
        "box",
        {
          flexDirection: "column",
          paddingX: 2,
          paddingY: 1,
          gap: 1,
          flexShrink: 0,
          border: ["bottom"],
          borderColor: () => theme().border.base,
        },
        el(
          "box",
          { flexDirection: "row", alignItems: "center", gap: 1 },
          el(
            "text",
            {
              fg: () =>
                focusPane() === "search"
                  ? theme().text.action.primary.base
                  : theme().text.muted,
              attributes: TextAttributes.BOLD,
            },
            "›"
          ),
          el("input", {
            id: "local-memory-search-input",
            flexGrow: 1,
            value: () => query(),
            focused: () => focusPane() === "search",
            maxLength: Number.POSITIVE_INFINITY,
            placeholder:
              "Search local memories (semantic + keyword, or /regex/i)... 0 tokens",
            placeholderColor: () => theme().text.muted,
            textColor: () => theme().text.base,
            focusedTextColor: () => theme().text.formfield.focused,
            cursorColor: () => theme().text.formfield.focused,
            backgroundColor: () => theme().background.base,
            focusedBackgroundColor: () => theme().background.formfield.focused,
            onMouseDown: () => setFocusPane("search"),
            onInput: (val: string) => setQuery(val),
          })
        ),
        el(
          "box",
          { flexDirection: "row", flexWrap: "wrap", gap: 1, alignItems: "center" },
          Pill({
            label: () => `type:${typeFilter()}`,
            shortcut: "^t",
            active: () => typeFilter() !== "all",
            onClick: cycleType,
          }),
          Pill({
            label: () => `topic:${topicFilter()}`,
            shortcut: "^g",
            active: () => topicFilter() !== "all",
            onClick: cycleTopic,
          }),
          Pill({
            label: () => `mode:${mode()}`,
            shortcut: "^r",
            active: () => mode() !== "hybrid",
            onClick: cycleMode,
          }),
          Pill({
            label: () => "import",
            shortcut: "^b",
            active: () => false,
            onClick: () => void runImportInDialog(),
          })
        )
      ),

      // 3. Split-Pane Body
      el(
        "box",
        { flexDirection: "row", flexGrow: 1, minHeight: 0 },
        // Left: Results List (44%)
        el(
          "scrollbox",
          {
            id: "local-memory-list",
            ref: (r: unknown) => {
              listScrollRef = r;
            },
            width: "44%",
            height: "100%",
            flexShrink: 0,
            border: ["right"],
            borderColor: () =>
              focusPane() === "list" ? theme().text.base : theme().border.base,
            scrollbarOptions: { visible: false },
            onMouseDown: () => setFocusPane("list"),
          },
          createComponent(Show, {
            get when() {
              return hits().length > 0;
            },
            get fallback() {
              return el(
                "box",
                { paddingX: 2, paddingY: 1 },
                el(
                  "text",
                  { fg: () => theme().text.muted },
                  "No matching memory entries found."
                )
              );
            },
            get children() {
              return createComponent(For, {
                get each() {
                  return hits();
                },
                children: (item: MemoryHit, idx: () => number) => {
                  const isSelected = () => selectedIndex() === idx();
                  return el(
                    "box",
                    {
                      id: () => `memory-row-${idx()}`,
                      flexDirection: "column",
                      paddingX: 1,
                      paddingY: 0,
                      marginBottom: 1,
                      flexShrink: 0,
                      backgroundColor: () =>
                        isSelected()
                          ? theme().background.action.primary.focused
                          : undefined,
                      onMouseUp: () => setSelectedIndex(idx()),
                      onMouseOver: () => setSelectedIndex(idx()),
                    },
                    el(
                      "box",
                      {
                        flexDirection: "row",
                        justifyContent: "space-between",
                        width: "100%",
                      },
                      el(
                        "text",
                        {
                          wrapMode: "none",
                          fg: () =>
                            isSelected()
                              ? theme().text.action.primary.focused
                              : theme().text.base,
                          attributes: () =>
                            isSelected() ? TextAttributes.BOLD : undefined,
                        },
                        () => `${isSelected() ? "› " : "  "}[${item.entry.id}]`
                      ),
                      el(
                        "text",
                        {
                          wrapMode: "none",
                          fg: () =>
                            isSelected()
                              ? theme().text.action.primary.focused
                              : theme().text.muted,
                        },
                        () =>
                          query().trim()
                            ? `${item.score.toFixed(2)} · ${item.entry.file.replace(/\.md$/, "")}`
                            : item.entry.file.replace(/\.md$/, "")
                      )
                    ),
                    el(
                      "text",
                      {
                        wrapMode: "none",
                        fg: () =>
                          isSelected()
                            ? theme().text.action.primary.focused
                            : theme().text.muted,
                      },
                      () => `  ${item.entry.fact.slice(0, 56)}`
                    )
                  );
                },
              });
            },
          })
        ),

        // Right: Full Memory Entry Preview (56%)
        el(
          "scrollbox",
          {
            id: "local-memory-preview",
            ref: (r: unknown) => {
              previewScrollRef = r;
            },
            flexGrow: 1,
            minWidth: 0,
            minHeight: 0,
            paddingX: 2,
            paddingY: 1,
            focused: () => focusPane() === "preview",
            onMouseDown: () => setFocusPane("preview"),
          },
          createComponent(Show, {
            get when() {
              return selectedHit();
            },
            get fallback() {
              return el(
                "text",
                { fg: () => theme().text.muted },
                "Select a memory entry on the left to inspect it."
              );
            },
            get children() {
              return el(
                "box",
                { flexDirection: "column", gap: 1 },
                el(
                  "text",
                  {
                    fg: () => theme().text.base,
                    attributes: TextAttributes.BOLD,
                  },
                  () => `[${selectedHit()?.entry.id ?? ""}]`
                ),
                el(
                  "text",
                  { fg: () => theme().text.muted, wrapMode: "word" },
                  () => {
                    const h = selectedHit();
                    if (!h) return "";
                    const scope = h.entry.project || "global";
                    const coreLabel = h.entry.core ? " · Core: pinned" : "";
                    return `File: ${h.entry.file} · Date: ${h.entry.date || "N/A"} · Scope: ${scope}${coreLabel} · Score: ${h.score.toFixed(3)}`;
                  }
                ),
                el(
                  "text",
                  { fg: () => theme().text.muted, wrapMode: "word" },
                  () => `Tags: [${selectedHit()?.entry.tags ?? ""}]`
                ),
                el(
                  "box",
                  {
                    flexDirection: "row",
                    flexWrap: "wrap",
                    marginTop: 1,
                  },
                  createComponent(For, {
                    get each() {
                      return splitHighlightedText(
                        selectedHit()?.entry.fact ?? "",
                        query()
                      );
                    },
                    children: (seg: { text: string; match: boolean }) =>
                      el(
                        "text",
                        {
                          fg: () =>
                            seg.match
                              ? theme().text.action.primary.base
                              : theme().text.base,
                          attributes: () =>
                            seg.match ? TextAttributes.BOLD : undefined,
                        },
                        seg.text
                      ),
                  })
                ),
                createComponent(Show, {
                  get when() {
                    return Boolean(selectedSessionBody());
                  },
                  get children() {
                    return el(
                      "box",
                      {
                        flexDirection: "column",
                        marginTop: 1,
                        paddingTop: 1,
                        border: ["top"],
                        borderColor: () => theme().border.base,
                      },
                      el(
                        "text",
                        {
                          fg: () => theme().text.base,
                          attributes: TextAttributes.BOLD,
                        },
                        "Full Session Checkpoint Markdown:"
                      ),
                      el(
                        "text",
                        { fg: () => theme().text.muted, wrapMode: "word" },
                        () => selectedSessionBody()
                      )
                    );
                  },
                })
              );
            },
          })
        )
      ),

      // 4. Footer Bar
      el(
        "box",
        {
          flexDirection: "row",
          justifyContent: "space-between",
          paddingX: 2,
          paddingY: 1,
          flexShrink: 0,
          border: ["top"],
          borderColor: () => theme().border.base,
        },
        el(
          "text",
          { fg: () => theme().text.muted },
          "enter select · ↑/↓ or ^n/^k move · ^t type · ^g topic · ^r mode · ^b import · ^l resync · tab pane · esc"
        ),
        el(
          "text",
          { fg: () => theme().text.muted },
          "0 tokens (100% local)"
        )
      )
    );
  }

  return (props: DialogProps) => createComponent(LocalMemoryDialog, props);
}

async function openFallbackSelectDialog(
  context: TuiPluginContext,
  rootDir: string,
  initialQuery: string
) {
  const hits: MemoryHit[] = initialQuery.trim()
    ? await searchMemory(rootDir, initialQuery, "hybrid", 40)
    : ((loadCachedVectors(rootDir) || []) as MemoryEntry[])
        .slice()
        .reverse()
        .map((entry) => ({ score: 1, semanticScore: 0, entry }));

  if (!hits.length) {
    context.ui.toast.show({
      title: "Local Memory",
      message: initialQuery
        ? `No memories matched "${initialQuery}".`
        : "No memories found.",
      variant: "warning",
    });
    return;
  }

  const options = hits.map((h) => ({
    title: `[${h.entry.id}] (${h.entry.file})`,
    value: h.entry.id,
    description: h.entry.fact,
    footer: `Tags: [${h.entry.tags}] · Date: ${h.entry.date || "N/A"}`,
  }));

  await context.ui.dialog.select<string>({
    title: initialQuery ? `Local Memory: "${initialQuery}" (0 tokens)` : "Local Memory (0 tokens)",
    placeholder: "Filter memories...",
    options,
  });
}

export default {
  id: "opencode-local-memory",
  async setup(context: TuiPluginContext) {
    if (!context?.ui) {
      return;
    }
    const rootDir = resolveMemoryDir((context as any)?.options?.directory);
    const renderDialog = createTuiRenderer();

    const openMemoryPopup = async (rawArgs?: string) => {
      const initialQuery = typeof rawArgs === "string" ? rawArgs.trim() : "";

      try {
        context.ui.dialog.show(() =>
          renderDialog({
            context,
            rootDir,
            initialQuery,
            close: () => context.ui.dialog.clear(),
          })
        );
        context.ui.dialog.set({
          size: "xlarge",
          centered: true,
        });
      } catch {
        await openFallbackSelectDialog(context, rootDir, initialQuery);
      }
    };

    const quickStoreFromSlash = async (rawArgs?: string) => {
      const text = typeof rawArgs === "string" ? rawArgs.trim() : "";
      const parts = text.split("|").map((s) => s.trim());
      if (parts.length < 2) {
        context.ui.toast.show({
          title: "Local Memory Add (0 tokens)",
          message: "Usage: /memory-add <topic> | <tags> | <fact>  (or /memory-add <topic> | <fact>)",
          variant: "warning",
        });
        return;
      }
      const topic = parts[0] || "preferences";
      const tags = parts.length >= 3 ? parts[1] : topic;
      const fact = parts.length >= 3 ? parts.slice(2).join(" | ") : parts[1];
      try {
        const saved = await storeMemoryFact(rootDir, { topic, tags, fact });
        context.ui.toast.show({
          title: `Stored [${saved.id}] (0 tokens)`,
          message: `${saved.file}: ${saved.fact.slice(0, 90)}`,
          variant: "success",
        });
      } catch (err) {
        context.ui.toast.show({
          title: "Local Memory Error",
          message: err instanceof Error ? err.message : String(err),
          variant: "error",
        });
      }
    };

    const quickDeleteFromSlash = async (rawArgs?: string) => {
      const id = typeof rawArgs === "string" ? rawArgs.trim() : "";
      if (!id) {
        context.ui.toast.show({
          title: "Local Memory Delete (0 tokens)",
          message: "Usage: /memory-delete <id>",
          variant: "warning",
        });
        return;
      }
      try {
        const res = await deleteMemoryEntry(rootDir, id);
        if (res.deleted.length === 0) {
          context.ui.toast.show({
            title: "Not Found",
            message: `No memory entry matched ID: ${id}`,
            variant: "warning",
          });
          return;
        }
        context.ui.toast.show({
          title: `Deleted ${res.deleted.map((d: { id: string }) => `[${d.id}]`).join(", ")} (0 tokens)`,
          message: `${res.total} entries remaining in vectors.json`,
          variant: "success",
        });
      } catch (err) {
        context.ui.toast.show({
          title: "Local Memory Error",
          message: err instanceof Error ? err.message : String(err),
          variant: "error",
        });
      }
    };

    const quickImportFromSlash = async (rawArgs?: string) => {
      const arg = typeof rawArgs === "string" ? rawArgs.trim() : "";
      const limit = arg && /^\d+$/.test(arg) ? parseInt(arg, 10) : undefined;
      context.ui.toast.show({
        title: "Importing Local Memory (0 tokens)...",
        message: "Scanning AGENTS.md rules and opencode.db session history...",
        variant: "info",
      });
      try {
        const res = await safeImportMemory(rootDir, limit);
        context.ui.toast.show({
          title: "Local Memory Import Complete (0 tokens)",
          message: `Added ${res.importedFacts.length} rules & ${res.importedSessions.length} sessions (${res.syncResult.total} total indexed)`,
          variant: "success",
        });
      } catch (err) {
        context.ui.toast.show({
          title: "Local Memory Import Error",
          message: err instanceof Error ? err.message : String(err),
          variant: "error",
        });
      }
    };

    let layerRegistered = false;
    context.ui.slot({
      append: "app",
      render() {
        if (!layerRegistered) {
          layerRegistered = true;
          context.keymap.layer(() => ({
            mode: "global",
            commands: [
              {
                id: "local.memory.search",
                title: "Search local memory (0 tokens)...",
                description:
                  "Interactive zero-token popup to search local memories (topics/*.md + sessions/*.md) with semantic + keyword + regex matching",
                category: "Memory",
                palette: true,
                slash: {
                  name: "memory",
                  arguments: true,
                },
                run: (input) => {
                  const rawArgs = typeof input === "string" ? input : (input as any)?.arguments;
                  void openMemoryPopup(rawArgs);
                },
              },
              {
                id: "local.memory.add",
                title: "Store local memory fact (0 tokens)...",
                description:
                  "Zero-token slash command to store a memory fact directly: /memory-add <topic> | <tags> | <fact>",
                category: "Memory",
                palette: false,
                slash: {
                  name: "memory-add",
                  arguments: true,
                },
                run: (input) => {
                  const rawArgs = typeof input === "string" ? input : (input as any)?.arguments;
                  void quickStoreFromSlash(rawArgs);
                },
              },
              {
                id: "local.memory.delete",
                title: "Delete local memory entry by ID (0 tokens)...",
                description:
                  "Zero-token slash command to delete a memory entry by ID: /memory-delete <id>",
                category: "Memory",
                palette: false,
                slash: {
                  name: "memory-delete",
                  arguments: true,
                },
                run: (input) => {
                  const rawArgs = typeof input === "string" ? input : (input as any)?.arguments;
                  void quickDeleteFromSlash(rawArgs);
                },
              },
              {
                id: "local.memory.import",
                title: "Import existing AGENTS.md & session history (0 tokens)...",
                description:
                  "Zero-token command to import existing AGENTS.md/CLAUDE.md rules and compacted session summaries from opencode.db: /memory-import [limit]",
                category: "Memory",
                palette: true,
                slash: {
                  name: "memory-import",
                  arguments: true,
                },
                run: (input) => {
                  const rawArgs = typeof input === "string" ? input : (input as any)?.arguments;
                  void quickImportFromSlash(rawArgs);
                },
              },
            ],
          }));
        }
        return null;
      },
    });
  },
};
