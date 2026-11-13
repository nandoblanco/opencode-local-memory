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

type TypeFilter = "all" | "core" | "topics" | "sessions";
type ModeFilter = "hybrid" | "keyword" | "regex";
type EditorField = "topic" | "tags" | "project" | "core" | "fact";

const TYPE_CYCLE: TypeFilter[] = ["all", "core", "topics", "sessions"];
const MODE_CYCLE: ModeFilter[] = ["hybrid", "keyword", "regex"];
const EDITOR_FIELDS: EditorField[] = ["topic", "tags", "project", "core", "fact"];
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

async function safeStoreMemory(
  rootDir: string,
  payload: {
    id?: string;
    topic: string;
    tags: string;
    fact: string;
    project?: string;
    core?: boolean;
  }
) {
  try {
    return await storeMemoryFact(rootDir, payload);
  } catch {
    const stdout = await runCliSubprocess([
      "store-json",
      "--dir",
      rootDir,
      "--payload",
      JSON.stringify(payload),
    ]);
    const lines = stdout.trim().split(/\r?\n/).filter(Boolean);
    return JSON.parse(lines[lines.length - 1]);
  }
}

async function safeDeleteMemory(rootDir: string, id: string) {
  try {
    return await deleteMemoryEntry(rootDir, id);
  } catch {
    const stdout = await runCliSubprocess([
      "delete-json",
      "--dir",
      rootDir,
      "--payload",
      JSON.stringify({ id }),
    ]);
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
    const [editorMode, setEditorMode] = createSignal<null | "add" | "edit">(null);
    const [editorField, setEditorField] = createSignal<EditorField>("fact");
    const [editId, setEditId] = createSignal("");
    const [editTopic, setEditTopic] = createSignal("preferences");
    const [editTags, setEditTags] = createSignal("");
    const [editProject, setEditProject] = createSignal("global");
    const [editCore, setEditCore] = createSignal(false);
    const [editFact, setEditFact] = createSignal("");
    const [confirmDeleteId, setConfirmDeleteId] = createSignal<string | null>(null);

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
        } else if (lower === "type:core" || lower === "in:core") {
          effType = "core";
          effCoreOnly = true;
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

      if (effType === "core") {
        effCoreOnly = true;
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
        if (effType === "core" && !e.core) return false;
        if (effType === "topics" && !e.file.startsWith("topics/")) return false;
        if (effType === "sessions" && !e.file.startsWith("sessions/")) return false;
        if (effTopic !== "all" && e.file !== `topics/${effTopic}.md`) return false;
        if (effCoreOnly && !e.core) return false;
        if (effProject !== "all" && !matchesProjectScope(e.project, effProject, false)) return false;
        return true;
      });

      if (!q) {
        const topicPart = subset.filter((e) => !e.file.startsWith("sessions/")).reverse();
        const sessionPart = subset.filter((e) => e.file.startsWith("sessions/")).reverse();
        return topicPart
          .concat(sessionPart)
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
            if (effType === "core" && !h.entry.core) return false;
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

    const reloadVectors = async (forceSync = false, selectId?: string) => {
      if (forceSync) {
        setStatusMsg("syncing markdown -> vectors.json...");
        await safeSyncVectors(props.rootDir).catch(() => {});
        setStatusMsg("");
      }
      const loaded = (loadCachedVectors(props.rootDir) || []) as MemoryEntry[];
      setAllEntries(loaded);
      await runSearch();
      if (selectId) {
        const idx = hits().findIndex((h) => h.entry.id === selectId);
        if (idx >= 0) {
          setSelectedIndex(idx);
          queueMicrotask(() => listScrollRef?.scrollChildIntoView?.(`memory-row-${idx}`));
        }
      }
    };

    const startAdd = () => {
      setConfirmDeleteId(null);
      const currentTopic = topicFilter() !== "all" ? topicFilter() : "preferences";
      setEditId("");
      setEditTopic(currentTopic);
      setEditTags(currentTopic);
      setEditProject("global");
      setEditCore(typeFilter() === "core");
      setEditFact("");
      setEditorField("fact");
      setEditorMode("add");
      setFocusPane("preview");
      setStatusMsg("adding new memory fact (Tab fields · ^S/Enter save · Esc cancel)");
    };

    const startEdit = () => {
      setConfirmDeleteId(null);
      const current = selectedHit();
      if (!current) return;
      if (!current.entry.file.startsWith("topics/")) {
        props.context.ui.toast.show({
          title: "Session Checkpoints are Read-Only",
          message: "Select a topic fact (topics/*.md) to edit inline, or press ^N to add a new fact.",
          variant: "warning",
        });
        return;
      }
      const topicSlug = current.entry.file.replace(/^topics\//, "").replace(/\.md$/, "");
      setEditId(current.entry.id);
      setEditTopic(topicSlug || "preferences");
      setEditTags(current.entry.tags || "");
      setEditProject(current.entry.project || "global");
      setEditCore(Boolean(current.entry.core));
      setEditFact(current.entry.fact || "");
      setEditorField("fact");
      setEditorMode("edit");
      setFocusPane("preview");
      setStatusMsg(`editing [${current.entry.id}] (Tab fields · ^S/Enter save · Esc cancel)`);
    };

    const cancelEditor = () => {
      setEditorMode(null);
      setConfirmDeleteId(null);
      setStatusMsg("");
    };

    const saveEditor = async () => {
      const modeVal = editorMode();
      if (!modeVal) return;
      const topic = editTopic().trim() || "preferences";
      const fact = editFact().trim();
      if (!fact) {
        props.context.ui.toast.show({
          title: "Fact Required",
          message: "Enter a non-empty memory fact before saving.",
          variant: "warning",
        });
        return;
      }
      const tags = editTags().trim() || topic;
      const project = editProject().trim() || "global";
      const core = Boolean(editCore());
      const id = modeVal === "edit" ? editId().trim() || undefined : undefined;
      setStatusMsg(modeVal === "edit" ? `saving [${id}]...` : "storing new memory...");
      try {
        const saved = await safeStoreMemory(props.rootDir, {
          id,
          topic,
          tags,
          fact,
          project,
          core,
        });
        setEditorMode(null);
        setStatusMsg("");
        await reloadVectors(false, saved.id);
        props.context.ui.toast.show({
          title: modeVal === "edit" ? `Updated [${saved.id}] (0 tokens)` : `Stored [${saved.id}] (0 tokens)`,
          message: `${saved.file}: ${saved.fact.slice(0, 90)}`,
          variant: "success",
        });
      } catch (err) {
        setStatusMsg("");
        props.context.ui.toast.show({
          title: "Memory Save Error",
          message: err instanceof Error ? err.message : String(err),
          variant: "error",
        });
      }
    };

    const toggleSelectedCore = async () => {
      setConfirmDeleteId(null);
      const current = selectedHit();
      if (!current) return;
      if (!current.entry.file.startsWith("topics/")) {
        props.context.ui.toast.show({
          title: "Topic Facts Only",
          message: "Only topic facts (topics/*.md) can be pinned as core memories.",
          variant: "warning",
        });
        return;
      }
      const topic = current.entry.file.replace(/^topics\//, "").replace(/\.md$/, "");
      const nextCore = !current.entry.core;
      setStatusMsg(`${nextCore ? "pinning" : "unpinning"} [${current.entry.id}]...`);
      try {
        const saved = await safeStoreMemory(props.rootDir, {
          id: current.entry.id,
          topic,
          tags: current.entry.tags,
          fact: current.entry.fact,
          project: current.entry.project || "global",
          core: nextCore,
        });
        setStatusMsg("");
        await reloadVectors(false, saved.id);
        props.context.ui.toast.show({
          title: nextCore ? `Pinned [${saved.id}] as Core` : `Unpinned [${saved.id}]`,
          message: nextCore
            ? "Injected automatically on every turn."
            : "Removed from pinned core memories.",
          variant: "success",
        });
      } catch (err) {
        setStatusMsg("");
        props.context.ui.toast.show({
          title: "Pin Toggle Error",
          message: err instanceof Error ? err.message : String(err),
          variant: "error",
        });
      }
    };

    const promptOrConfirmDelete = async () => {
      const current = selectedHit();
      if (!current) return;
      const targetId = current.entry.id;
      if (confirmDeleteId() !== targetId) {
        setConfirmDeleteId(targetId);
        setStatusMsg(`confirm delete [${targetId}]? press ^D or Enter again (Esc cancels)`);
        return;
      }
      setConfirmDeleteId(null);
      setStatusMsg(`deleting [${targetId}]...`);
      try {
        const res = await safeDeleteMemory(props.rootDir, targetId);
        setStatusMsg("");
        await reloadVectors(false);
        props.context.ui.toast.show({
          title: `Deleted [${targetId}] (0 tokens)`,
          message: `${res.total} entries remaining in vectors.json`,
          variant: "success",
        });
      } catch (err) {
        setStatusMsg("");
        props.context.ui.toast.show({
          title: "Delete Error",
          message: err instanceof Error ? err.message : String(err),
          variant: "error",
        });
      }
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
        if (editorMode()) {
          cancelEditor();
          return;
        }
        if (confirmDeleteId()) {
          setConfirmDeleteId(null);
          setStatusMsg("");
          return;
        }
        props.close();
        return;
      }

      if (editorMode()) {
        if (name === "tab") {
          event.preventDefault();
          event.stopPropagation();
          const idx = EDITOR_FIELDS.indexOf(editorField());
          const next = EDITOR_FIELDS[(idx + (event.shift ? -1 : 1) + EDITOR_FIELDS.length) % EDITOR_FIELDS.length];
          setEditorField(next);
          return;
        }
        if ((event.ctrl && name === "s") || name === "return" || name === "enter" || name === "kpenter") {
          event.preventDefault();
          event.stopPropagation();
          void saveEditor();
          return;
        }
        if (editorField() === "core" && name === "space") {
          event.preventDefault();
          event.stopPropagation();
          setEditCore((v) => !v);
          return;
        }
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
      if (event.ctrl && name === "n") {
        event.preventDefault();
        event.stopPropagation();
        startAdd();
        return;
      }
      if (event.ctrl && name === "e") {
        event.preventDefault();
        event.stopPropagation();
        startEdit();
        return;
      }
      if (event.ctrl && name === "p") {
        event.preventDefault();
        event.stopPropagation();
        void toggleSelectedCore();
        return;
      }
      if (event.ctrl && name === "d") {
        event.preventDefault();
        event.stopPropagation();
        void promptOrConfirmDelete();
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

      if (name === "return" || name === "enter" || name === "kpenter") {
        if (confirmDeleteId()) {
          event.preventDefault();
          event.stopPropagation();
          void promptOrConfirmDelete();
          return;
        }
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
        (event.ctrl && name === "j") ||
        (focusPane() !== "search" && !event.ctrl && name === "j")
      ) {
        event.preventDefault();
        event.stopPropagation();
        setConfirmDeleteId(null);
        if (focusPane() === "preview" && !event.ctrl && name === "j") {
          previewScrollRef?.scrollBy?.(2);
        } else {
          moveSelection(1);
        }
        return;
      }
      if (
        name === "up" ||
        (event.ctrl && name === "k") ||
        (focusPane() !== "search" && !event.ctrl && name === "k")
      ) {
        event.preventDefault();
        event.stopPropagation();
        setConfirmDeleteId(null);
        if (focusPane() === "preview" && !event.ctrl && name === "k") {
          previewScrollRef?.scrollBy?.(-2);
        } else {
          moveSelection(-1);
        }
        return;
      }
      if (name === "pagedown" || (event.ctrl && name === "f")) {
        event.preventDefault();
        event.stopPropagation();
        setConfirmDeleteId(null);
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
        setConfirmDeleteId(null);
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
        height: 34,
        flexDirection: "column",
        backgroundColor: () => theme().background.base,
        paddingLeft: 2,
        paddingRight: 2,
        paddingTop: 1,
        paddingBottom: 1,
        gap: 1,
      },
      // 1. Header Bar (single-line, no wrapping)
      el(
        "box",
        {
          flexDirection: "row",
          justifyContent: "space-between",
          alignItems: "center",
          border: ["bottom"],
          borderColor: () => theme().border.base,
          paddingBottom: 0,
          flexShrink: 0,
          width: "100%",
        },
        el(
          "box",
          { flexDirection: "row", gap: 2, alignItems: "center", flexShrink: 0 },
          el(
            "text",
            {
              wrapMode: "none",
              flexShrink: 0,
              fg: () => theme().text.action.primary.base,
              attributes: TextAttributes.BOLD,
            },
            "opencode / memory"
          ),
          el(
            "text",
            {
              wrapMode: "none",
              flexShrink: 0,
              fg: () => theme().text.muted,
            },
            () => props.context.ui.format.path(props.rootDir)
          )
        ),
        el(
          "text",
          {
            wrapMode: "none",
            flexShrink: 0,
            fg: () => theme().text.muted,
          },
          "[↑↓] select  [^N] add  [^E] edit  [^P] pin  [^D] delete  [Esc] close"
        )
      ),

      // 2. Boxed Filter + Pills Card
      el(
        "box",
        {
          flexDirection: "column",
          backgroundColor: () =>
            theme().background.raised?.base ?? theme().background.base,
          border: true,
          borderColor: () =>
            focusPane() === "search"
              ? theme().text.action.primary.base
              : theme().border.base,
          paddingLeft: 2,
          paddingRight: 2,
          paddingTop: 0,
          paddingBottom: 0,
          gap: 0,
          flexShrink: 0,
          width: "100%",
        },
        el(
          "box",
          {
            flexDirection: "row",
            justifyContent: "space-between",
            alignItems: "center",
            gap: 1,
            width: "100%",
          },
          el(
            "text",
            {
              width: 7,
              wrapMode: "none",
              flexShrink: 0,
              fg: () => theme().text.action.primary.base,
              attributes: TextAttributes.BOLD,
            },
            "Filter:"
          ),
          el(
            "box",
            {
              flexGrow: 1,
              flexShrink: 1,
              minWidth: 0,
            },
            el("input", {
              id: "local-memory-search-input",
              width: "100%",
              value: () => query(),
              focused: () => !editorMode() && focusPane() === "search",
              maxLength: Number.POSITIVE_INFINITY,
              placeholder:
                "Search memories (semantic + keyword, topic:name, project:slug, /regex/i)...",
              placeholderColor: () => theme().text.muted,
              textColor: () => theme().text.base,
              focusedTextColor: () => theme().text.formfield.focused,
              cursorColor: () => theme().text.formfield.focused,
              backgroundColor: () =>
                theme().background.raised?.base ?? theme().background.base,
              focusedBackgroundColor: () =>
                theme().background.raised?.base ?? theme().background.base,
              onMouseDown: () => {
                setEditorMode(null);
                setFocusPane("search");
              },
              onInput: (val: string) => setQuery(val),
            })
          ),
          el(
            "text",
            {
              wrapMode: "none",
              flexShrink: 0,
              fg: () =>
                confirmDeleteId()
                  ? theme().text.feedback?.warning?.base ?? theme().text.action.primary.base
                  : theme().text.feedback?.success?.base ??
                    theme().text.action.primary.base,
            },
            () =>
              statusMsg() ||
              `${hits().length} of ${allEntries().length} entries · 0 tokens`
          )
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
            label: () => "+ add",
            shortcut: "^n",
            active: () => editorMode() === "add",
            onClick: startAdd,
          }),
          Pill({
            label: () => "edit",
            shortcut: "^e",
            active: () => editorMode() === "edit",
            onClick: startEdit,
          }),
          Pill({
            label: () => (selectedHit()?.entry.core ? "unpin" : "pin core"),
            shortcut: "^p",
            active: () => Boolean(selectedHit()?.entry.core),
            onClick: () => void toggleSelectedCore(),
          }),
          Pill({
            label: () => (confirmDeleteId() ? "confirm del!" : "delete"),
            shortcut: "^d",
            active: () => Boolean(confirmDeleteId()),
            onClick: () => void promptOrConfirmDelete(),
          }),
          Pill({
            label: () => "import",
            shortcut: "^b",
            active: () => false,
            onClick: () => void runImportInDialog(),
          }),
          Pill({
            label: () => "resync",
            shortcut: "^l",
            active: () => false,
            onClick: () => void reloadVectors(true),
          })
        )
      ),

      // 3. Split-Pane Body: Two Side-by-Side Bordered Cards
      el(
        "box",
        { flexDirection: "row", gap: 2, flexGrow: 1, minHeight: 0, width: "100%" },
        // Left Card: Results List (44%)
        el(
          "box",
          {
            width: "44%",
            height: "100%",
            flexDirection: "column",
            flexShrink: 0,
            backgroundColor: () =>
              theme().background.raised?.base ?? theme().background.base,
            border: true,
            borderColor: () =>
              focusPane() === "list"
                ? theme().text.action.primary.base
                : theme().border.base,
            paddingLeft: 1,
            paddingRight: 1,
            paddingTop: 0,
            paddingBottom: 0,
            onMouseDown: () => setFocusPane("list"),
          },
          el(
            "box",
            {
              flexDirection: "row",
              justifyContent: "space-between",
              border: ["bottom"],
              borderColor: () => theme().border.base,
              paddingX: 1,
              flexShrink: 0,
            },
            el(
              "text",
              {
                fg: () => theme().text.action.primary.base,
                attributes: TextAttributes.BOLD,
              },
              "◈ MEMORY ENTRIES"
            ),
            el(
              "text",
              { fg: () => theme().text.muted },
              () => `${mode()} · ${typeFilter()}`
            )
          ),
          el(
            "scrollbox",
            {
              id: "local-memory-list",
              ref: (r: unknown) => {
                listScrollRef = r;
              },
              width: "100%",
              flexGrow: 1,
              minHeight: 0,
              scrollbarOptions: { visible: false },
            },
            createComponent(Show, {
              get when() {
                return hits().length > 0;
              },
              get fallback() {
                return el(
                  "box",
                  { paddingX: 1, paddingY: 1 },
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
                            truncate: true,
                            fg: () =>
                              isSelected()
                                ? theme().text.action.primary.focused
                                : theme().text.base,
                            attributes: () =>
                              isSelected() ? TextAttributes.BOLD : undefined,
                          },
                          () =>
                            `${isSelected() ? "▸ " : "  "}${item.entry.core ? "★ " : ""}[${item.entry.id}]`
                        ),
                        el(
                          "text",
                          {
                            wrapMode: "none",
                            fg: () =>
                              isSelected()
                                ? theme().text.action.primary.focused
                                : theme().text.action.primary.base,
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
                          truncate: true,
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
          )
        ),

        // Right Card: Full Memory Entry Preview or Inline Editor (56%)
        el(
          "box",
          {
            flexGrow: 1,
            height: "100%",
            minWidth: 0,
            minHeight: 0,
            flexDirection: "column",
            backgroundColor: () =>
              theme().background.raised?.base ?? theme().background.base,
            border: true,
            borderColor: () =>
              editorMode() || focusPane() === "preview"
                ? theme().text.action.primary.base
                : theme().border.base,
            paddingLeft: 2,
            paddingRight: 2,
            paddingTop: 0,
            paddingBottom: 1,
            onMouseDown: () => setFocusPane("preview"),
          },
          el(
            "box",
            {
              flexDirection: "row",
              justifyContent: "space-between",
              border: ["bottom"],
              borderColor: () => theme().border.base,
              marginBottom: 1,
              flexShrink: 0,
            },
            el(
              "text",
              {
                fg: () => theme().text.action.primary.base,
                attributes: TextAttributes.BOLD,
              },
              () =>
                editorMode() === "add"
                  ? "◈ ADD NEW MEMORY FACT"
                  : editorMode() === "edit"
                    ? `◈ EDIT MEMORY [${editId()}]`
                    : "◈ ENTRY PREVIEW"
            ),
            el(
              "text",
              { fg: () => theme().text.muted },
              () =>
                editorMode()
                  ? "[Tab] next field · [^S/Enter] save · [Esc] cancel"
                  : selectedHit()
                    ? `${selectedHit()?.entry.file ?? ""} · score ${selectedHit()?.score.toFixed(3) ?? ""}`
                    : "no selection"
            )
          ),
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
              focused: () => !editorMode() && focusPane() === "preview",
            },
            createComponent(Show, {
              get when() {
                return Boolean(editorMode());
              },
              get fallback() {
                return createComponent(Show, {
                  get when() {
                    return selectedHit();
                  },
                  get fallback() {
                    return el(
                      "text",
                      { fg: () => theme().text.muted },
                      "Select a memory entry on the left to inspect it, or press ^N to add a new memory fact."
                    );
                  },
                  get children() {
                    return el(
                      "box",
                      { flexDirection: "column", gap: 1 },
                      el(
                        "box",
                        {
                          flexDirection: "column",
                          paddingLeft: 1,
                          border: ["left"],
                          borderColor: () => theme().text.action.primary.base,
                        },
                        el(
                          "text",
                          {
                            fg: () => theme().text.base,
                            attributes: TextAttributes.BOLD,
                          },
                          () =>
                            `${selectedHit()?.entry.core ? "★ " : ""}[${selectedHit()?.entry.id ?? ""}]`
                        ),
                        el(
                          "text",
                          { fg: () => theme().text.muted, wrapMode: "word" },
                          () => {
                            const h = selectedHit();
                            if (!h) return "";
                            const scope = h.entry.project || "global";
                            const coreLabel = h.entry.core ? " · Core: pinned" : "";
                            return `File: ${h.entry.file} · Date: ${h.entry.date || "N/A"} · Scope: ${scope}${coreLabel}`;
                          }
                        ),
                        el(
                          "text",
                          { fg: () => theme().text.muted, wrapMode: "word" },
                          () => `Tags: [${selectedHit()?.entry.tags ?? ""}]`
                        )
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
                                fg: () => theme().text.action.primary.base,
                                attributes: TextAttributes.BOLD,
                              },
                              "◈ FULL SESSION CHECKPOINT MARKDOWN"
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
                });
              },
              get children() {
                return el(
                  "box",
                  { flexDirection: "column", gap: 1, width: "100%" },
                  // Topic field
                  el(
                    "box",
                    {
                      flexDirection: "row",
                      alignItems: "center",
                      gap: 1,
                      width: "100%",
                      onMouseDown: () => setEditorField("topic"),
                    },
                    el(
                      "text",
                      {
                        width: 10,
                        flexShrink: 0,
                        fg: () =>
                          editorField() === "topic"
                            ? theme().text.action.primary.base
                            : theme().text.muted,
                        attributes: () =>
                          editorField() === "topic" ? TextAttributes.BOLD : undefined,
                      },
                      "Topic:"
                    ),
                    el(
                      "box",
                      { flexGrow: 1, minWidth: 0 },
                      el("input", {
                        id: "local-memory-edit-topic",
                        width: "100%",
                        value: () => editTopic(),
                        focused: () => editorMode() !== null && editorField() === "topic",
                        placeholder: "preferences, decisions, environment, tools...",
                        placeholderColor: () => theme().text.muted,
                        textColor: () => theme().text.base,
                        focusedTextColor: () => theme().text.formfield.focused,
                        cursorColor: () => theme().text.formfield.focused,
                        onInput: (v: string) => setEditTopic(v),
                      })
                    )
                  ),
                  // Tags field
                  el(
                    "box",
                    {
                      flexDirection: "row",
                      alignItems: "center",
                      gap: 1,
                      width: "100%",
                      onMouseDown: () => setEditorField("tags"),
                    },
                    el(
                      "text",
                      {
                        width: 10,
                        flexShrink: 0,
                        fg: () =>
                          editorField() === "tags"
                            ? theme().text.action.primary.base
                            : theme().text.muted,
                        attributes: () =>
                          editorField() === "tags" ? TextAttributes.BOLD : undefined,
                      },
                      "Tags:"
                    ),
                    el(
                      "box",
                      { flexGrow: 1, minWidth: 0 },
                      el("input", {
                        id: "local-memory-edit-tags",
                        width: "100%",
                        value: () => editTags(),
                        focused: () => editorMode() !== null && editorField() === "tags",
                        placeholder: "comma-separated keywords...",
                        placeholderColor: () => theme().text.muted,
                        textColor: () => theme().text.base,
                        focusedTextColor: () => theme().text.formfield.focused,
                        cursorColor: () => theme().text.formfield.focused,
                        onInput: (v: string) => setEditTags(v),
                      })
                    )
                  ),
                  // Project field
                  el(
                    "box",
                    {
                      flexDirection: "row",
                      alignItems: "center",
                      gap: 1,
                      width: "100%",
                      onMouseDown: () => setEditorField("project"),
                    },
                    el(
                      "text",
                      {
                        width: 10,
                        flexShrink: 0,
                        fg: () =>
                          editorField() === "project"
                            ? theme().text.action.primary.base
                            : theme().text.muted,
                        attributes: () =>
                          editorField() === "project" ? TextAttributes.BOLD : undefined,
                      },
                      "Project:"
                    ),
                    el(
                      "box",
                      { flexGrow: 1, minWidth: 0 },
                      el("input", {
                        id: "local-memory-edit-project",
                        width: "100%",
                        value: () => editProject(),
                        focused: () => editorMode() !== null && editorField() === "project",
                        placeholder: "global (or cms/<client>, git/<repo>)...",
                        placeholderColor: () => theme().text.muted,
                        textColor: () => theme().text.base,
                        focusedTextColor: () => theme().text.formfield.focused,
                        cursorColor: () => theme().text.formfield.focused,
                        onInput: (v: string) => setEditProject(v),
                      })
                    )
                  ),
                  // Core pin toggle
                  el(
                    "box",
                    {
                      flexDirection: "row",
                      alignItems: "center",
                      gap: 1,
                      width: "100%",
                      onMouseUp: () => {
                        setEditorField("core");
                        setEditCore((v) => !v);
                      },
                    },
                    el(
                      "text",
                      {
                        width: 10,
                        flexShrink: 0,
                        fg: () =>
                          editorField() === "core"
                            ? theme().text.action.primary.base
                            : theme().text.muted,
                        attributes: () =>
                          editorField() === "core" ? TextAttributes.BOLD : undefined,
                      },
                      "Core Pin:"
                    ),
                    el(
                      "text",
                      {
                        fg: () =>
                          editCore()
                            ? theme().text.action.primary.base
                            : theme().text.muted,
                        attributes: () => (editCore() ? TextAttributes.BOLD : undefined),
                      },
                      () =>
                        editCore()
                          ? "[★ Pinned — injected on every turn] (click or Space to toggle)"
                          : "[  Unpinned — recalled by relevance] (click or Space to toggle)"
                    )
                  ),
                  // Fact field
                  el(
                    "box",
                    {
                      flexDirection: "column",
                      gap: 0,
                      width: "100%",
                      marginTop: 1,
                      onMouseDown: () => setEditorField("fact"),
                    },
                    el(
                      "text",
                      {
                        fg: () =>
                          editorField() === "fact"
                            ? theme().text.action.primary.base
                            : theme().text.muted,
                        attributes: () =>
                          editorField() === "fact" ? TextAttributes.BOLD : undefined,
                      },
                      "Fact (one-line statement):"
                    ),
                    el(
                      "box",
                      {
                        width: "100%",
                        border: true,
                        borderColor: () =>
                          editorField() === "fact"
                            ? theme().text.action.primary.base
                            : theme().border.base,
                        paddingX: 1,
                      },
                      el("input", {
                        id: "local-memory-edit-fact",
                        width: "100%",
                        value: () => editFact(),
                        focused: () => editorMode() !== null && editorField() === "fact",
                        maxLength: Number.POSITIVE_INFINITY,
                        placeholder: "Write the fact, rule, preference, or decision...",
                        placeholderColor: () => theme().text.muted,
                        textColor: () => theme().text.base,
                        focusedTextColor: () => theme().text.formfield.focused,
                        cursorColor: () => theme().text.formfield.focused,
                        onInput: (v: string) => setEditFact(v),
                      })
                    )
                  ),
                  // Action pills inside editor
                  el(
                    "box",
                    { flexDirection: "row", gap: 1, marginTop: 1 },
                    Pill({
                      label: () => (editorMode() === "edit" ? "save changes" : "store memory"),
                      shortcut: "^s / Enter",
                      active: () => true,
                      onClick: () => void saveEditor(),
                    }),
                    Pill({
                      label: () => "cancel",
                      shortcut: "Esc",
                      active: () => false,
                      onClick: cancelEditor,
                    })
                  )
                );
              },
            })
          )
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
