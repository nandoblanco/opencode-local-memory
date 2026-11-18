import {
  Command,
  MenuItem,
  Panel,
  Plugin,
  Slot,
  Style,
  type PanelTab,
  type PluginContext,
  type UiMenuEntry,
} from "@opencode/plugin/gui";
import { For, Show, createEffect, createMemo, createSignal, onCleanup } from "solid-js";
import css from "./gui.css?inline";
import {
  MemoryRpc,
  type MemoryModeFilter,
  type MemoryRpcEntry,
  type MemoryRpcHit,
  type MemoryRpcQueryOutput,
  type MemoryTypeFilter,
} from "./rpc.js";

const TYPE_LABELS: Record<MemoryTypeFilter, string> = {
  all: "All",
  core: "Core",
  topics: "Topics",
  sessions: "Sessions",
};

const MODE_LABELS: Record<MemoryModeFilter, string> = {
  hybrid: "Hybrid (Semantic + BM25)",
  keyword: "Keyword",
  regex: "Regex",
};

const TYPE_CYCLE: MemoryTypeFilter[] = ["all", "core", "topics", "sessions"];
const MODE_CYCLE: MemoryModeFilter[] = ["hybrid", "keyword", "regex"];

function cycleValue<T>(list: readonly T[], current: T): T {
  const idx = list.indexOf(current);
  return list[(idx + 1) % list.length] ?? list[0];
}

function isSessionEntry(entry: MemoryRpcEntry): boolean {
  return String(entry.file || "").startsWith("sessions/") || String(entry.id || "").startsWith("session:");
}

function entryTopicSlug(entry: MemoryRpcEntry): string {
  const f = String(entry.file || "");
  if (f.startsWith("topics/") && f.endsWith(".md")) {
    return f.slice(7, -3);
  }
  if (isSessionEntry(entry)) return "session";
  return "general";
}

function entryTagsList(entry: MemoryRpcEntry): string[] {
  return String(entry.tags || "")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
}

function splitHighlightedParts(text: string, rawQuery: string): Array<{ text: string; match: boolean }> {
  const cleanTerms = String(rawQuery || "")
    .replace(/\b(?:type|topic|mode|project|in|core|is|re):[^\s]+/gi, " ")
    .trim()
    .split(/\s+/)
    .filter((t) => t.length >= 2);
  if (!text || cleanTerms.length === 0) return [{ text, match: false }];

  const escaped = cleanTerms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  let re: RegExp;
  try {
    re = new RegExp(`(${escaped.join("|")})`, "gi");
  } catch {
    return [{ text, match: false }];
  }

  const out: Array<{ text: string; match: boolean }> = [];
  let lastIndex = 0;
  for (const m of text.matchAll(re)) {
    const idx = m.index ?? 0;
    const hit = m[0] ?? "";
    if (!hit) continue;
    if (idx > lastIndex) {
      out.push({ text: text.slice(lastIndex, idx), match: false });
    }
    out.push({ text: hit, match: true });
    lastIndex = idx + hit.length;
  }
  if (lastIndex < text.length) {
    out.push({ text: text.slice(lastIndex), match: false });
  }
  return out.length > 0 ? out : [{ text, match: false }];
}

function getRpcClient(ctx: PluginContext) {
  const activeSession = ctx.sessions.current();
  if (activeSession?.server?.client) {
    return activeSession.server.client.rpc(MemoryRpc);
  }
  const serverIds = ctx.servers?.list?.() ?? [];
  const server =
    serverIds.map((id) => ctx.servers.get(id)).find((s) => s?.builtin) ??
    serverIds.map((id) => ctx.servers.get(id)).find((s) => s?.local) ??
    serverIds.map((id) => ctx.servers.get(id)).find((s) => s !== undefined);
  const client = server?.client ?? ctx.client;
  return client.rpc(MemoryRpc);
}

interface MemorySurfaceProps {
  ctx: PluginContext;
  initialQuery?: string;
  initialEditorMode?: "none" | "add";
  initialDraftFact?: string;
  variant: "panel" | "modal";
  onClose?: () => void;
}

function MemorySurface(props: MemorySurfaceProps) {
  const ui = props.ctx.ui;

  const [query, setQuery] = createSignal(props.initialQuery ?? "");
  const [typeFilter, setTypeFilter] = createSignal<MemoryTypeFilter>("all");
  const [topicFilter, setTopicFilter] = createSignal<string>("all");
  const [mode, setMode] = createSignal<MemoryModeFilter>("hybrid");
  const [selectedIndex, setSelectedIndex] = createSignal(0);

  const [loading, setLoading] = createSignal(true);
  const [busyAction, setBusyAction] = createSignal(false);
  const [errorMsg, setErrorMsg] = createSignal<string | undefined>(undefined);
  const [data, setData] = createSignal<MemoryRpcQueryOutput | undefined>(undefined);
  const [sessionMarkdown, setSessionMarkdown] = createSignal<string>("");
  const [confirmDeleteId, setConfirmDeleteId] = createSignal<string>("");

  const [editorMode, setEditorMode] = createSignal<"none" | "add" | "edit">(
    props.initialEditorMode ?? "none",
  );
  const [editId, setEditId] = createSignal("");
  const [draftTopic, setDraftTopic] = createSignal("preferences");
  const [draftTags, setDraftTags] = createSignal("");
  const [draftProject, setDraftProject] = createSignal("global");
  const [draftCore, setDraftCore] = createSignal(false);
  const [draftFact, setDraftFact] = createSignal(props.initialDraftFact ?? "");

  // External openers (commands, intercepted clicks) push state here.
  createEffect(() => {
    const q = olmPanelQuery();
    if (q) setQuery(q);
  });
  createEffect(() => {
    const ed = olmPanelEditor();
    if (ed) {
      setEditorMode(ed.mode);
      setDraftFact(ed.draftFact);
    }
  });

  let requestCounter = 0;
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;

  const hits = createMemo<MemoryRpcHit[]>(() => data()?.hits ?? []);
  const topics = createMemo<string[]>(() => data()?.topics ?? []);
  const selectedHit = createMemo<MemoryRpcHit | undefined>(() => {
    const list = hits();
    const idx = Math.max(0, Math.min(selectedIndex(), Math.max(0, list.length - 1)));
    return list[idx];
  });

  async function executeQuery(preferEntryId?: string) {
    const seq = ++requestCounter;
    setLoading(true);
    setErrorMsg(undefined);

    try {
      const rpc = getRpcClient(props.ctx);
      const res = await rpc.query({
        query: query(),
        typeFilter: typeFilter(),
        topicFilter: topicFilter(),
        mode: mode(),
        limit: 80,
      });
      if (seq !== requestCounter) return;
      setData(res);
      if (preferEntryId) {
        const idx = res.hits.findIndex((h) => h.entry.id === preferEntryId);
        setSelectedIndex(idx >= 0 ? idx : 0);
      } else {
        setSelectedIndex((prev) => Math.max(0, Math.min(prev, Math.max(0, res.hits.length - 1))));
      }
    } catch (err) {
      if (seq !== requestCounter) return;
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      if (seq === requestCounter) {
        setLoading(false);
      }
    }
  }

  function scheduleQuery() {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      void executeQuery();
    }, 65);
  }

  createEffect(() => {
    void query();
    void typeFilter();
    void topicFilter();
    void mode();
    scheduleQuery();
  });

  createEffect(() => {
    const hit = selectedHit();
    setConfirmDeleteId("");
    if (!hit || !isSessionEntry(hit.entry)) {
      setSessionMarkdown("");
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const res = await getRpcClient(props.ctx).getSessionMarkdown({ file: hit.entry.file });
        if (!cancelled) setSessionMarkdown(res.markdown || hit.entry.fact);
      } catch {
        if (!cancelled) setSessionMarkdown(hit.entry.fact);
      }
    })();
    onCleanup(() => {
      cancelled = true;
    });
  });

  onCleanup(() => {
    if (debounceTimer) clearTimeout(debounceTimer);
  });

  function openAddEditor() {
    const currentTopic = topicFilter() !== "all" ? topicFilter() : (topics()[0] || "preferences");
    setEditorMode("add");
    setEditId("");
    setDraftTopic(currentTopic);
    setDraftTags("");
    setDraftProject("global");
    setDraftCore(typeFilter() === "core");
    setDraftFact("");
    setConfirmDeleteId("");
  }

  function openEditEditor(hit?: MemoryRpcHit) {
    const target = hit ?? selectedHit();
    if (!target || isSessionEntry(target.entry)) {
      props.ctx.toast.show({ title: "Only topic facts can be edited in-place", variant: "error" });
      return;
    }
    setEditId(target.entry.id);
    setDraftTopic(entryTopicSlug(target.entry));
    setDraftTags(target.entry.tags || "");
    setDraftProject(target.entry.project || "global");
    setDraftCore(Boolean(target.entry.core));
    setDraftFact(target.entry.fact || "");
    setConfirmDeleteId("");
    setEditorMode("edit");
  }

  async function saveDraft() {
    const topicVal = draftTopic().trim();
    const factVal = draftFact().trim();
    if (!topicVal) {
      props.ctx.toast.show({ title: "Topic slug is required", variant: "error" });
      return;
    }
    if (!factVal) {
      props.ctx.toast.show({ title: "Memory fact cannot be empty", variant: "error" });
      return;
    }
    setBusyAction(true);
    try {
      const res = await getRpcClient(props.ctx).store({
        id: editorMode() === "edit" && editId() ? editId() : undefined,
        topic: topicVal,
        tags: draftTags().trim() || topicVal,
        fact: factVal,
        project: draftProject().trim() || "global",
        core: draftCore(),
      });
      setEditorMode("none");
      props.ctx.toast.show({
        title: `${res.entry.updated ? "Updated" : "Stored"} [${res.entry.id}] (${res.entry.file})`,
        variant: "success",
      });
      await executeQuery(res.entry.id);
    } catch (err) {
      props.ctx.toast.show({
        title: err instanceof Error ? err.message : "Failed to save memory",
        variant: "error",
      });
    } finally {
      setBusyAction(false);
    }
  }

  async function toggleCorePin(hit?: MemoryRpcHit) {
    const target = hit ?? selectedHit();
    if (!target || isSessionEntry(target.entry)) return;
    const nextCore = !target.entry.core;
    setBusyAction(true);
    try {
      const res = await getRpcClient(props.ctx).store({
        id: target.entry.id,
        topic: entryTopicSlug(target.entry),
        tags: target.entry.tags || entryTopicSlug(target.entry),
        fact: target.entry.fact,
        project: target.entry.project || "global",
        core: nextCore,
      });
      props.ctx.toast.show({
        title: `${nextCore ? "Pinned" : "Unpinned"} [${res.entry.id}]`,
        variant: "success",
      });
      await executeQuery(res.entry.id);
    } catch (err) {
      props.ctx.toast.show({
        title: err instanceof Error ? err.message : "Failed to update core pin",
        variant: "error",
      });
    } finally {
      setBusyAction(false);
    }
  }

  async function handleDelete(hit?: MemoryRpcHit) {
    const target = hit ?? selectedHit();
    if (!target) return;
    if (confirmDeleteId() !== target.entry.id) {
      setConfirmDeleteId(target.entry.id);
      return;
    }
    setBusyAction(true);
    try {
      const res = await getRpcClient(props.ctx).remove({ id: target.entry.id });
      setConfirmDeleteId("");
      if (res.deleted.length > 0) {
        props.ctx.toast.show({
          title: `Deleted ${res.deleted.map((d) => d.id).join(", ")}`,
          variant: "success",
        });
        await executeQuery();
      } else {
        props.ctx.toast.show({
          title: `Not found: ${target.entry.id}`,
          variant: "error",
        });
      }
    } catch (err) {
      props.ctx.toast.show({
        title: err instanceof Error ? err.message : "Delete failed",
        variant: "error",
      });
    } finally {
      setBusyAction(false);
    }
  }

  async function handleResync() {
    setBusyAction(true);
    try {
      const res = await getRpcClient(props.ctx).sync({});
      props.ctx.toast.show({
        title: `Synced ${res.total} memories (${res.embedded} newly embedded)`,
        variant: "success",
      });
      await executeQuery(selectedHit()?.entry.id);
    } catch (err) {
      props.ctx.toast.show({
        title: err instanceof Error ? err.message : "Sync failed",
        variant: "error",
      });
    } finally {
      setBusyAction(false);
    }
  }

  async function handleImport() {
    setBusyAction(true);
    try {
      const res = await getRpcClient(props.ctx).importMemory({ limit: 30 });
      props.ctx.toast.show({
        title: `Imported ${res.importedFactsCount} rules, ${res.importedSessionsCount} sessions (${res.total} total)`,
        variant: "success",
      });
      await executeQuery(selectedHit()?.entry.id);
    } catch (err) {
      props.ctx.toast.show({
        title: err instanceof Error ? err.message : "Import failed",
        variant: "error",
      });
    } finally {
      setBusyAction(false);
    }
  }

  async function copyEntry(hit?: MemoryRpcHit) {
    const target = hit ?? selectedHit();
    if (!target) return;
    const text = `[${target.entry.id}] (${target.entry.file}): ${target.entry.fact}`;
    try {
      await props.ctx.system.copy(text);
      props.ctx.toast.show({ title: `Copied [${target.entry.id}]`, variant: "success" });
    } catch {
      // ignore
    }
  }

  function handleKeyDown(e: KeyboardEvent) {
    if (editorMode() !== "none") {
      if (e.key === "Escape") {
        e.preventDefault();
        setEditorMode("none");
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        void saveDraft();
        return;
      }
      return;
    }

    if (e.ctrlKey || e.metaKey) {
      const k = e.key.toLowerCase();
      if (k === "t") {
        e.preventDefault();
        setTypeFilter((c) => cycleValue(TYPE_CYCLE, c));
        setSelectedIndex(0);
        return;
      }
      if (k === "g") {
        e.preventDefault();
        const cycle = ["all", ...topics()];
        setTopicFilter((c) => cycleValue(cycle, c));
        setSelectedIndex(0);
        return;
      }
      if (k === "r") {
        e.preventDefault();
        setMode((c) => cycleValue(MODE_CYCLE, c));
        setSelectedIndex(0);
        return;
      }
      if (k === "n") {
        e.preventDefault();
        openAddEditor();
        return;
      }
      if (k === "e") {
        e.preventDefault();
        openEditEditor();
        return;
      }
      if (k === "p") {
        e.preventDefault();
        void toggleCorePin();
        return;
      }
      if (k === "d") {
        e.preventDefault();
        void handleDelete();
        return;
      }
      if (k === "l") {
        e.preventDefault();
        void handleResync();
        return;
      }
    }

    if (e.key === "ArrowDown") {
      e.preventDefault();
      const maxIdx = Math.max(0, hits().length - 1);
      setSelectedIndex((i) => Math.min(maxIdx, i + 1));
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIndex((i) => Math.max(0, i - 1));
      return;
    }
  }

  const filterMenuItems = createMemo<UiMenuEntry[]>(() => {
    const topicItems: UiMenuEntry[] = [
      {
        label: "All topics",
        icon: topicFilter() === "all" ? "check-small" : undefined,
        onSelect: () => {
          setTopicFilter("all");
          setSelectedIndex(0);
        },
      },
      ...topics().map((slug) => ({
        label: slug,
        icon: topicFilter() === slug ? ("check-small" as const) : undefined,
        onSelect: () => {
          setTopicFilter(slug);
          setSelectedIndex(0);
        },
      })),
    ];

    return [
      {
        type: "group",
        label: "Search Mode",
        items: (["hybrid", "keyword", "regex"] as MemoryModeFilter[]).map((m) => ({
          label: MODE_LABELS[m],
          icon: mode() === m ? "check-small" : undefined,
          onSelect: () => {
            setMode(m);
            setSelectedIndex(0);
          },
        })),
      },
      { type: "separator" },
      {
        type: "group",
        label: "Topic Filter",
        items: topicItems,
      },
      { type: "separator" },
      {
        label: "Import rules & sessions",
        icon: "download",
        onSelect: () => {
          void handleImport();
        },
      },
      {
        label: "Reset filters",
        icon: "refresh",
        disabled: typeFilter() === "all" && topicFilter() === "all" && mode() === "hybrid",
        onSelect: () => {
          setTypeFilter("all");
          setTopicFilter("all");
          setMode("hybrid");
          setSelectedIndex(0);
        },
      },
    ];
  });

  const hasNonDefaultFilters = createMemo(
    () => topicFilter() !== "all" || mode() !== "hybrid" || Boolean(errorMsg()),
  );

  return (
    <div
      class={`olm-root olm-root--${props.variant}`}
      onKeyDown={handleKeyDown}
    >
      <div class="olm-header">
        <div class="olm-toolbar">
          <div class="olm-search-field">
            <ui.TextInput
              value={query()}
              onInput={(val) => {
                setQuery(val);
                setSelectedIndex(0);
              }}
              label="Search memories"
              placeholder="Search facts & session checkpoints, or filter with topic:preferences type:core..."
              type="search"
              size="large"
              invalid={Boolean(errorMsg())}
              autofocus={editorMode() === "none"}
            />
          </div>

          <div class="olm-toolbar-controls">
            <div class="olm-segmented" role="group" aria-label="Memory type filter">
              <For each={TYPE_CYCLE}>
                {(t) => (
                  <button
                    type="button"
                    class={`olm-segment ${typeFilter() === t ? "olm-segment--active" : ""}`}
                    onClick={() => {
                      setTypeFilter(t);
                      setSelectedIndex(0);
                    }}
                  >
                    {TYPE_LABELS[t]}
                  </button>
                )}
              </For>
            </div>

            <ui.Menu
              label="Filters"
              icon="sliders"
              trigger="button"
              placement="bottom-end"
              items={filterMenuItems()}
            />

            <Show when={loading() || busyAction()}>
              <ui.Loader size="small" />
            </Show>

            <ui.Tooltip value="Resync vector index" keys={["Ctrl", "L"]}>
              <ui.IconButton
                icon="refresh"
                label="Resync vector index"
                variant="ghost"
                size="normal"
                busy={busyAction()}
                onClick={() => void handleResync()}
              />
            </ui.Tooltip>

            <ui.Button
              variant="contrast"
              size="small"
              icon="plus-small"
              onClick={() => openAddEditor()}
            >
              Add Memory
            </ui.Button>
          </div>
        </div>

        <Show when={hasNonDefaultFilters() || data()}>
          <div class="olm-active-filters">
            <div class="olm-chip-group">
              <Show when={mode() !== "hybrid"}>
                <button
                  type="button"
                  class="olm-chip"
                  onClick={() => setMode("hybrid")}
                  title="Reset search mode to Hybrid"
                >
                  <span class="olm-chip-key">Mode:</span>
                  <span>{MODE_LABELS[mode()]}</span>
                  <ui.Icon name="close-small" size="small" />
                </button>
              </Show>

              <Show when={topicFilter() !== "all"}>
                <button
                  type="button"
                  class="olm-chip"
                  onClick={() => setTopicFilter("all")}
                  title="Clear topic filter"
                >
                  <span class="olm-chip-key">Topic:</span>
                  <span>{topicFilter()}</span>
                  <ui.Icon name="close-small" size="small" />
                </button>
              </Show>

              <Show when={errorMsg()}>
                {(err) => (
                  <span style={{ "font-size": "11px", color: "var(--v2-state-fg-danger)" }}>
                    {err()}
                  </span>
                )}
              </Show>
            </div>

            <span class="olm-meta-summary">
              {hits().length} of {data()?.totalEntries ?? 0} memories ({data()?.coreCount ?? 0} core)
            </span>
          </div>
        </Show>
      </div>

      <div class="olm-split">
        <div class="olm-column olm-column--list">
          <div class="olm-scroll">
            <Show
              when={hits().length > 0}
              fallback={
                <div class="olm-empty">
                  <ui.Icon name="magnifying-glass" size="large" />
                  <div class="olm-empty-title">
                    {loading() ? "Loading persistent memories..." : "No matching memories"}
                  </div>
                  <div class="olm-empty-desc">
                    Try switching to All types, clearing topic filters, or click Add Memory to store a new fact.
                  </div>
                </div>
              }
            >
              <div class="olm-list" role="listbox" aria-label="Memory entries">
                <For each={hits()}>
                  {(hit, idx) => {
                    const isSelected = () => idx() === selectedIndex() && editorMode() === "none";
                    return (
                      <button
                        type="button"
                        role="option"
                        aria-selected={isSelected()}
                        class={`olm-row ${isSelected() ? "olm-row--selected" : ""}`}
                        onClick={() => {
                          setEditorMode("none");
                          setSelectedIndex(idx());
                        }}
                      >
                        <div class="olm-row-top">
                          <span class="olm-row-id-wrap">
                            <Show when={hit.entry.core}>
                              <span class="olm-row-pin" title="Pinned Core Memory">
                                ★
                              </span>
                            </Show>
                            <span class="olm-row-id">{hit.entry.id}</span>
                          </span>
                          <span class="olm-row-meta">
                            <Show when={hit.entry.core}>
                              <span class="olm-badge olm-badge--core">core</span>
                            </Show>
                            <span class="olm-badge">
                              {entryTopicSlug(hit.entry)}
                            </span>
                            <Show when={query().trim().length > 0 && hit.score > 0}>
                              <span class="olm-row-score">{hit.score.toFixed(2)}</span>
                            </Show>
                          </span>
                        </div>

                        <div class="olm-row-fact">
                          <For each={splitHighlightedParts(hit.entry.fact, query())}>
                            {(part) => (
                              <Show when={part.match} fallback={<span>{part.text}</span>}>
                                <mark class="olm-mark">{part.text}</mark>
                              </Show>
                            )}
                          </For>
                        </div>
                      </button>
                    );
                  }}
                </For>
              </div>
            </Show>
          </div>
        </div>

        <div class="olm-column olm-column--detail">
          <Show
            when={editorMode() === "none"}
            fallback={
              <>
                <div class="olm-detail-bar">
                  <div class="olm-detail-heading">
                    <h3 class="olm-detail-title">
                      {editorMode() === "add" ? "Add New Memory Fact" : `Edit Memory [${editId()}]`}
                    </h3>
                    <div class="olm-detail-subtitle">
                      <span>Saves to topics/{draftTopic() || "preferences"}.md and updates semantic vectors immediately</span>
                    </div>
                  </div>
                  <div class="olm-detail-actions">
                    <ui.Button
                      variant="ghost"
                      size="small"
                      onClick={() => setEditorMode("none")}
                    >
                      Cancel
                    </ui.Button>
                    <ui.Button
                      variant="contrast"
                      size="small"
                      icon="check-small"
                      busy={busyAction()}
                      onClick={() => void saveDraft()}
                    >
                      {editorMode() === "add" ? "Save Memory" : "Save Changes"}
                    </ui.Button>
                  </div>
                </div>

                <div class="olm-scroll">
                  <div class="olm-form">
                    <div class="olm-form-row">
                      <div class="olm-form-group">
                        <label class="olm-form-label">Topic Slug</label>
                        <input
                          type="text"
                          class="olm-input"
                          value={draftTopic()}
                          placeholder="e.g. preferences, decisions, environment"
                          onInput={(e) => setDraftTopic(e.currentTarget.value)}
                        />
                        <Show when={topics().length > 0}>
                          <div class="olm-topic-suggestions">
                            <For each={topics().slice(0, 8)}>
                              {(slug) => (
                                <button
                                  type="button"
                                  class={`olm-topic-pill ${draftTopic() === slug ? "olm-topic-pill--active" : ""}`}
                                  onClick={() => setDraftTopic(slug)}
                                >
                                  {slug}
                                </button>
                              )}
                            </For>
                          </div>
                        </Show>
                      </div>

                      <div class="olm-form-group">
                        <label class="olm-form-label">Project Scope</label>
                        <input
                          type="text"
                          class="olm-input"
                          value={draftProject()}
                          placeholder="global or project slug (e.g. git/opencode-plugins)"
                          onInput={(e) => setDraftProject(e.currentTarget.value)}
                        />
                      </div>
                    </div>

                    <div class="olm-form-group">
                      <label class="olm-form-label">Tags (comma-separated keywords)</label>
                      <input
                        type="text"
                        class="olm-input"
                        value={draftTags()}
                        placeholder="e.g. opencode, desktop, gui, preferences"
                        onInput={(e) => setDraftTags(e.currentTarget.value)}
                      />
                    </div>

                    <div class="olm-form-group">
                      <ui.Switch
                        checked={draftCore()}
                        onChange={(checked) => setDraftCore(checked)}
                        label="Pin as Core Memory"
                        description="Core memories are always injected on every turn regardless of prompt query."
                      />
                    </div>

                    <div class="olm-form-group">
                      <label class="olm-form-label">Memory Fact</label>
                      <textarea
                        class="olm-textarea"
                        value={draftFact()}
                        placeholder="Write a concise, authoritative statement of the rule, decision, preference, or environment fact..."
                        onInput={(e) => setDraftFact(e.currentTarget.value)}
                        autofocus
                      />
                    </div>
                  </div>
                </div>
              </>
            }
          >
            <Show
              when={selectedHit()}
              fallback={
                <div class="olm-empty">
                  <ui.Icon name="bubble-5" size="large" />
                  <div class="olm-empty-title">Select a memory to inspect or manage</div>
                  <div class="olm-empty-desc">
                    View full details, pin/unpin core memories, edit topic facts in-place, or delete outdated entries.
                  </div>
                </div>
              }
            >
              {(hit) => (
                <>
                  <div class="olm-detail-bar">
                    <div class="olm-detail-heading">
                      <h3 class="olm-detail-title">
                        <Show when={hit().entry.core}>
                          <span class="olm-row-pin" title="Pinned Core Memory">
                            ★
                          </span>
                        </Show>
                        <span>{hit().entry.id}</span>
                      </h3>
                      <div class="olm-detail-subtitle">
                        <span>{hit().entry.file}</span>
                        <Show when={hit().entry.date}>
                          <span>·</span>
                          <span>Updated {hit().entry.date}</span>
                        </Show>
                      </div>
                    </div>

                    <div class="olm-detail-actions">
                      <Show when={!isSessionEntry(hit().entry)}>
                        <ui.Button
                          variant="neutral"
                          size="small"
                          busy={busyAction()}
                          onClick={() => void toggleCorePin(hit())}
                        >
                          {hit().entry.core ? "Unpin Core" : "Pin Core"}
                        </ui.Button>
                        <ui.Button
                          variant="neutral"
                          size="small"
                          icon="edit"
                          onClick={() => openEditEditor(hit())}
                        >
                          Edit
                        </ui.Button>
                      </Show>

                      <ui.Tooltip value="Copy memory entry">
                        <ui.IconButton
                          icon="copy"
                          label="Copy memory entry"
                          variant="ghost"
                          size="small"
                          onClick={() => void copyEntry(hit())}
                        />
                      </ui.Tooltip>

                      <ui.Button
                        variant="danger"
                        size="small"
                        icon="trash"
                        busy={busyAction()}
                        onClick={() => void handleDelete(hit())}
                      >
                        {confirmDeleteId() === hit().entry.id ? "Confirm Delete" : "Delete"}
                      </ui.Button>
                    </div>
                  </div>

                  <div class="olm-scroll">
                    <div class="olm-detail-body">
                      <div class="olm-field-grid">
                        <div class="olm-field-card">
                          <span class="olm-field-label">Type</span>
                          <span class="olm-field-value">
                            {isSessionEntry(hit().entry) ? "Session Checkpoint" : "Topic Fact"}
                          </span>
                        </div>
                        <div class="olm-field-card">
                          <span class="olm-field-label">Topic</span>
                          <span class="olm-field-value">{entryTopicSlug(hit().entry)}</span>
                        </div>
                        <div class="olm-field-card">
                          <span class="olm-field-label">Project Scope</span>
                          <span class="olm-field-value">{hit().entry.project || "global"}</span>
                        </div>
                        <div class="olm-field-card">
                          <span class="olm-field-label">Core Status</span>
                          <span class="olm-field-value">
                            {hit().entry.core ? "★ Pinned (Always recalled)" : "Contextual recall"}
                          </span>
                        </div>
                      </div>

                      <Show when={entryTagsList(hit().entry).length > 0}>
                        <div class="olm-tags-list">
                          <For each={entryTagsList(hit().entry)}>
                            {(tag) => <span class="olm-tag">#{tag}</span>}
                          </For>
                        </div>
                      </Show>

                      <Show
                        when={isSessionEntry(hit().entry) && sessionMarkdown()}
                        fallback={
                          <div class="olm-fact-box">
                            <For each={splitHighlightedParts(hit().entry.fact, query())}>
                              {(part) => (
                                <Show when={part.match} fallback={<span>{part.text}</span>}>
                                  <mark class="olm-mark">{part.text}</mark>
                                </Show>
                              )}
                            </For>
                          </div>
                        }
                      >
                        <div class="olm-fact-box">
                          <ui.Markdown text={sessionMarkdown()} />
                        </div>
                      </Show>
                    </div>
                  </div>
                </>
              )}
            </Show>
          </Show>
        </div>
      </div>
    </div>
  );
}

// Module-level signals so commands/slots can drive the shared panel's state
// without re-mounting MemorySurface (one persistent side panel, no modals).
const [olmPanelQuery, setOlmPanelQuery] = createSignal("");
const [olmPanelEditor, setOlmPanelEditor] = createSignal<{
  mode: "none" | "add";
  draftFact: string;
} | null>(null);

let memoryFallbackDialog: { close(): void } | undefined;

function openMemoryPanel(
  ctx: PluginContext,
  initialQuery = "",
  initialEditorMode: "none" | "add" = "none",
  initialDraftFact = "",
) {
  if (initialQuery) setOlmPanelQuery(initialQuery);
  if (initialEditorMode !== "none" || initialDraftFact) {
    setOlmPanelEditor({ mode: initialEditorMode, draftFact: initialDraftFact });
  }
  const session = ctx.sessions.current();
  if (!session) {
    if (memoryFallbackDialog) return;
    const ui = ctx.ui;
    memoryFallbackDialog = ctx.dialogs.open((dialog) => {
      onCleanup(() => { memoryFallbackDialog = undefined; });
      return (
        <ui.Dialog title="Memory Manager" size="x-large">
          <MemorySurface ctx={ctx} variant="modal" initialQuery={initialQuery} initialEditorMode={initialEditorMode} initialDraftFact={initialDraftFact} onClose={dialog.close} />
        </ui.Dialog>
      );
    });
    return;
  }
  memoryFallbackDialog?.close();
  try {
    // Always select the tab so it becomes the focused panel even if another
    // panel (usage, search, backups) is already open.
    ctx.layout.open(`${ctx.id}:memory`, session);
  } catch {
    // Layout not ready; retry on next interaction.
  }
}

export default Plugin.define({
  i18n: {
    en: {
      "memory.command.title": "Memory Manager...",
      "memory.command.description": "Search, add, edit, pin, and delete persistent local memories",
      "memory.panel": "Memory",
      "memory.panel.toggle": "Toggle Memory Panel",
    },
  },
  setup(ctx) {
    ctx.add(Style, css);

    ctx.add(Command, () => ({
      id: "memory",
      title: ctx.t("memory.command.title"),
      description: ctx.t("memory.command.description"),
      keywords: "memory facts recall core topics sessions vectors embeddings",
      group: "Session",
      section: "session",
      bind: "mod+shift+m",
      slash: {
        name: "memory",
        arguments: true,
      },
      featured: true,
      run(input) {
        openMemoryPanel(ctx, input ?? "");
      },
    }));

    ctx.add(Command, () => ({
      id: "memory-add",
      title: "Add Memory Fact...",
      description: "Add a new persistent memory fact (<topic> | <tags> | <fact> or interactive form)",
      keywords: "memory store add fact rule preference",
      group: "Session",
      section: "session",
      slash: {
        name: "memory-add",
        arguments: true,
      },
      run(input) {
        const raw = (input ?? "").trim();
        if (raw.includes("|")) {
          const parts = raw
            .split("|")
            .map((s) => s.trim())
            .filter(Boolean);
          if (parts.length >= 3) {
            const topic = parts[0];
            const tags = parts[1];
            const fact = parts.slice(2).join(" | ");
            void getRpcClient(ctx)
              .store({ topic, tags, fact })
              .then((res) => {
                ctx.toast.show({
                  title: `Stored [${res.entry.id}] in ${res.entry.file}`,
                  variant: "success",
                });
              })
              .catch((err) => {
                ctx.toast.show({
                  title: err instanceof Error ? err.message : "Failed to store memory",
                  variant: "error",
                });
              });
            return;
          }
        }
        openMemoryPanel(ctx, "", "add", raw);
      },
    }));

    ctx.add(Command, () => ({
      id: "memory-delete",
      title: "Delete Memory Entry...",
      description: "Delete a persistent memory entry by ID",
      keywords: "memory delete remove prune",
      group: "Session",
      section: "session",
      slash: {
        name: "memory-delete",
        arguments: true,
      },
      run(input) {
        const raw = (input ?? "").trim();
        if (!raw) {
          openMemoryPanel(ctx, "");
          return;
        }
        void getRpcClient(ctx)
          .remove({ id: raw })
          .then((res) => {
            if (res.deleted.length > 0) {
              ctx.toast.show({
                title: `Deleted ${res.deleted.map((d) => d.id).join(", ")}`,
                variant: "success",
              });
            } else {
              ctx.toast.show({
                title: `Not found: ${raw}`,
                variant: "error",
              });
            }
          })
          .catch((err) => {
            ctx.toast.show({
              title: err instanceof Error ? err.message : "Delete failed",
              variant: "error",
            });
          });
      },
    }));

    ctx.add(Command, () => ({
      id: "memory-import",
      title: "Import Existing Memories",
      description: "Import rules from AGENTS.md/CLAUDE.md and compacted sessions from opencode.db",
      keywords: "memory import rules sessions bootstrap",
      group: "Session",
      section: "session",
      slash: {
        name: "memory-import",
        arguments: true,
      },
      run(input) {
        const limitNum = Number.parseInt((input ?? "").trim(), 10);
        const limit = Number.isFinite(limitNum) && limitNum > 0 ? limitNum : 30;
        void getRpcClient(ctx)
          .importMemory({ limit })
          .then((res) => {
            ctx.toast.show({
              title: `Imported ${res.importedFactsCount} rules, ${res.importedSessionsCount} sessions (${res.total} total)`,
              variant: "success",
            });
          })
          .catch((err) => {
            ctx.toast.show({
              title: err instanceof Error ? err.message : "Import failed",
              variant: "error",
            });
          });
      },
    }));

    const panelTabKey = `${ctx.id}:memory`;
    const memoryTab: PanelTab = {
      id: "memory",
      get title() {
        return ctx.t("memory.panel");
      },
      closable: "compact",
    };

    ctx.add(Command, () => ({
      id: "memory-panel",
      title: ctx.t("memory.panel.toggle"),
      description: "Toggle the persistent Memory Manager side panel",
      keywords: "memory panel sidebar facts core",
      group: "Session",
      section: "session",
      bind: "mod+alt+m",
      run() {
        const session = ctx.sessions.current();
        if (session) {
          ctx.layout.toggle(panelTabKey, session);
        } else {
          openMemoryPanel(ctx, "");
        }
      },
    }));

    ctx.add(MenuItem, () => {
      const session = ctx.sessions.current();
      return {
        menu: "session.panel",
        id: "memory",
        title: ctx.t("memory.panel"),
        description: ctx.t("memory.command.description"),
        icon: "outline-brain",
        keybind: `${ctx.id}.memory-panel`,
        opened: !!session && ctx.layout.state(panelTabKey, session) !== "closed",
        run() {
          const current = ctx.sessions.current();
          if (current) {
            ctx.layout.toggle(panelTabKey, current);
          } else {
            openMemoryPanel(ctx, "");
          }
        },
      };
    });

    if (typeof document !== "undefined") {
      const ensureTopLeftMemoriesButton = () => {
        const searchBtn = document.querySelector<HTMLButtonElement>(
          'header[data-slot="titlebar-v2"] button[aria-label*="Search"]',
        );
        if (searchBtn && searchBtn.parentElement) {
          const container = searchBtn.parentElement;
          if (!container.querySelector('[data-action="titlebar-memories"]')) {
            const btn = document.createElement("button");
            btn.type = "button";
            btn.setAttribute("data-action", "titlebar-memories");
            btn.setAttribute("aria-label", "Memory Manager (Ctrl+Shift+M)");
            btn.setAttribute("title", "Memory Manager (Ctrl+Shift+M)");
            btn.className = "olm-titlebar-quick-btn";
            btn.innerHTML =
              '<svg data-slot="icon-svg" width="16" height="16" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><use href="#opencode-v2-icon-outline-brain"></use></svg>';
            btn.addEventListener("click", (e) => {
              e.preventDefault();
              e.stopPropagation();
              openMemoryPanel(ctx, "");
            });
            container.appendChild(btn);
          }
        }

        const vertSearchBtn = document.querySelector<HTMLButtonElement>(
          'button[data-action="vertical-tabs-search"]',
        );
        if (vertSearchBtn && vertSearchBtn.parentElement) {
          const vertContainer = vertSearchBtn.parentElement;
          if (!vertContainer.querySelector('[data-action="vertical-tabs-memories"]')) {
            const vBtn = document.createElement("button");
            vBtn.type = "button";
            vBtn.setAttribute("data-titlebar-tab-action", "");
            vBtn.setAttribute("data-action", "vertical-tabs-memories");
            vBtn.setAttribute("aria-label", "Memories (Ctrl+Shift+M)");
            vBtn.className =
              "group flex h-7 w-full shrink-0 items-center gap-1.5 rounded-[6px] ps-1.5 pe-2 text-[13px] leading-4 text-v2-text-text-faint hover:text-v2-text-text-base";
            vBtn.innerHTML =
              '<svg data-slot="icon-svg" width="16" height="16" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg" class="shrink-0" aria-hidden="true"><use href="#opencode-v2-icon-outline-brain"></use></svg>' +
              '<span class="min-w-0 truncate whitespace-nowrap">Memories</span>';
            vBtn.addEventListener("click", (e) => {
              e.preventDefault();
              e.stopPropagation();
              openMemoryPanel(ctx, "");
            });
            vertSearchBtn.insertAdjacentElement("afterend", vBtn);
          }
        }
      };

      ensureTopLeftMemoriesButton();
      const observer = new MutationObserver(() => {
        ensureTopLeftMemoriesButton();
      });
      if (document.body) {
        observer.observe(document.body, { childList: true, subtree: true });
      }
      onCleanup(() => {
        observer.disconnect();
        document
          .querySelectorAll(
            '[data-action="titlebar-memories"], [data-action="vertical-tabs-memories"]',
          )
          .forEach((el) => el.remove());
      });
    }

    ctx.add(Panel, {
      id: "memory",
      region: "side",
      list: (input) => (input.open.includes("memory") ? [memoryTab] : []),
      render: () => <MemorySurface ctx={ctx} variant="panel" />,
    });
  },
});
