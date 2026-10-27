#!/usr/bin/env node
"use strict";

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cliName = "open" + "code";

let embedderPromise = null;
let cachedEntries = null;
let cachedRootDir = "";
let cachedMtime = 0;
let cachedVersion = 0;
let cachedTopicSlugs = null;
let cachedTopicsRootDir = "";
let lastContextKey = "";
let lastContextText = "";
const queryVecCache = new Map();

function resolveMemoryDir(customDir) {
  if (customDir) {
    if (customDir.startsWith("~")) {
      return path.join(os.homedir(), customDir.slice(1));
    }
    return path.resolve(customDir);
  }
  if (process.env.OPENCODE_MEMORY_DIR) {
    return path.resolve(process.env.OPENCODE_MEMORY_DIR);
  }
  const localParent = path.resolve(__dirname, "..");
  if (fs.existsSync(path.join(localParent, "memory.md")) && fs.existsSync(path.join(localParent, "topics"))) {
    return localParent;
  }
  const configBase = process.env.XDG_CONFIG_HOME
    ? path.resolve(process.env.XDG_CONFIG_HOME)
    : path.join(os.homedir(), ".config");
  return path.join(configBase, cliName, "memory");
}

function resolveConfigDir(customConfigDir) {
  if (customConfigDir) {
    if (customConfigDir.startsWith("~")) {
      return path.join(os.homedir(), customConfigDir.slice(1));
    }
    return path.resolve(customConfigDir);
  }
  const configBase = process.env.XDG_CONFIG_HOME
    ? path.resolve(process.env.XDG_CONFIG_HOME)
    : path.join(os.homedir(), ".config");
  return path.join(configBase, cliName);
}

function addPluginToJsoncFile(filePath, schemaUrl, pluginEntryStr, pkgName) {
  if (!fs.existsSync(filePath)) {
    const content = [
      "{",
      '  "$schema": "' + schemaUrl + '",',
      '  "plugins": [',
      "    " + pluginEntryStr,
      "  ]",
      "}",
      ""
    ].join("\n");
    fs.writeFileSync(filePath, content, "utf8");
    return "created";
  }

  const raw = fs.readFileSync(filePath, "utf8");
  if (raw.includes(pkgName)) {
    return "already-present";
  }

  const pluginsArrRe = /("plugins"\s*:\s*\[)([\s\S]*?)(\])/;
  const match = raw.match(pluginsArrRe);
  if (match) {
    const inner = match[2].trim();
    const updated = raw.replace(pluginsArrRe, function (_, open, body, close) {
      if (!inner) {
        return open + "\n    " + pluginEntryStr + "\n  " + close;
      }
      const trimmedBody = body.replace(/\s*$/, "");
      const needsComma = !trimmedBody.endsWith(",");
      return open + trimmedBody + (needsComma ? "," : "") + "\n    " + pluginEntryStr + "\n  " + close;
    });
    fs.writeFileSync(filePath, updated, "utf8");
    return "updated";
  }

  const lastBrace = raw.lastIndexOf("}");
  if (lastBrace !== -1) {
    const before = raw.slice(0, lastBrace).replace(/\s*$/, "");
    const trimmedObj = before.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, "").trim();
    const needsComma = trimmedObj.length > 1 && !trimmedObj.endsWith("{") && !trimmedObj.endsWith(",");
    const updated = before + (needsComma ? "," : "") + '\n  "plugins": [\n    ' + pluginEntryStr + "\n  ]\n}\n";
    fs.writeFileSync(filePath, updated, "utf8");
    return "updated";
  }

  return "skipped";
}

async function installPlugin(options) {
  const opts = options || {};
  const configDir = resolveConfigDir(opts.configDir);
  const rootDir = resolveMemoryDir(opts.directory);
  const pkgName = "@nandoblanco/opencode-local-memory";
  const matchKey = "opencode-local-memory";

  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
  }

  const serverConfigFile = fs.existsSync(path.join(configDir, cliName + ".json")) && !fs.existsSync(path.join(configDir, cliName + ".jsonc"))
    ? path.join(configDir, cliName + ".json")
    : path.join(configDir, cliName + ".jsonc");
  const cliConfigFile = path.join(configDir, "cli.json");

  const serverEntryStr = opts.directory
    ? JSON.stringify({ package: pkgName, options: { directory: opts.directory } })
    : JSON.stringify(pkgName);
  const cliEntryStr = JSON.stringify(pkgName);

  const serverStatus = addPluginToJsoncFile(serverConfigFile, "https://" + cliName + ".ai/config.json", serverEntryStr, matchKey);
  const cliStatus = addPluginToJsoncFile(cliConfigFile, "https://" + cliName + ".ai/v2/cli.json", cliEntryStr, matchKey);

  ensureMemoryLayout(rootDir);
  const syncResult = opts.skipSync ? { total: 0, embedded: 0, reused: 0, vecFile: path.join(rootDir, "vectors.json") } : await syncVectors(rootDir);

  return {
    configDir: configDir,
    serverConfigFile: serverConfigFile,
    serverStatus: serverStatus,
    cliConfigFile: cliConfigFile,
    cliStatus: cliStatus,
    memoryDir: rootDir,
    syncResult: syncResult
  };
}

function ensureMemoryLayout(rootDir) {
  const topicDir = path.join(rootDir, "topics");
  const sessionDir = path.join(rootDir, "sessions");
  const indexFile = path.join(rootDir, "memory.md");
  const sessionReadme = path.join(sessionDir, "README.md");

  if (!fs.existsSync(rootDir)) fs.mkdirSync(rootDir, { recursive: true });
  if (!fs.existsSync(topicDir)) fs.mkdirSync(topicDir, { recursive: true });
  if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir, { recursive: true });

  const starterTopics = [
    { slug: "preferences", title: "# Preferences\n", desc: "user coding style and workflow preferences" },
    { slug: "decisions", title: "# Decisions\n", desc: "architectural and cross-project decisions" },
    { slug: "environment", title: "# Environment\n", desc: "machine, OS, and tooling facts" },
    { slug: "agent-behavior", title: "# Agent Behavior\n", desc: "corrections and operational protocols" }
  ];

  if (!fs.existsSync(indexFile)) {
    const starterIndex = [
      "# Global Memory Index",
      "",
      "## Topic files",
      "",
      ...starterTopics.map(function (t) { return "- `topics/" + t.slug + ".md` - " + t.desc; }),
      "",
      "## Session summaries",
      "",
      "- `sessions/YYYY-MM-DD_slug-NN.md` - distilled record of significant work sessions",
      ""
    ].join("\n");
    fs.writeFileSync(indexFile, starterIndex, "utf8");

    for (const t of starterTopics) {
      const tf = path.join(topicDir, t.slug + ".md");
      if (!fs.existsSync(tf)) fs.writeFileSync(tf, t.title, "utf8");
    }
  }

  if (!fs.existsSync(sessionReadme)) {
    fs.writeFileSync(
      sessionReadme,
      "# Session Checkpoints\n\nNumbered session summaries (`YYYY-MM-DD_slug-NN.md`) created by `memory_checkpoint` or automatic session compaction.\n",
      "utf8"
    );
  }
}

async function getEmbedder() {
  if (embedderPromise) return embedderPromise;
  embedderPromise = (async function () {
    let pipelineFn;
    try {
      const mod = await import("@xenova/transformers");
      pipelineFn = mod.pipeline;
    } catch {
      const fallbackPath = path.resolve(__dirname, "node_modules/@xenova/transformers/src/transformers.js");
      const fallbackUrl = new URL("file:///" + fallbackPath.replace(/\\/g, "/")).href;
      const mod = await import(fallbackUrl);
      pipelineFn = mod.pipeline;
    }
    return pipelineFn("feature-extraction", "Xenova/all-MiniLM-L6-v2");
  })();
  return embedderPromise;
}

async function embedText(text) {
  const key = String(text || "").trim().toLowerCase();
  if (queryVecCache.has(key)) {
    return queryVecCache.get(key);
  }
  const embed = await getEmbedder();
  const out = await embed(text, { pooling: "mean", normalize: true });
  const vec = Array.from(out.data);
  if (queryVecCache.size >= 128) {
    const firstKey = queryVecCache.keys().next().value;
    queryVecCache.delete(firstKey);
  }
  queryVecCache.set(key, vec);
  return vec;
}

function parseTopicEntries(rootDir) {
  const topicDir = path.join(rootDir, "topics");
  if (!fs.existsSync(topicDir)) return [];
  const files = fs.readdirSync(topicDir).filter(function (f) { return f.endsWith(".md"); });
  const entries = [];

  for (const file of files) {
    const text = fs.readFileSync(path.join(topicDir, file), "utf8").replace(/\r\n/g, "\n");
    const blocks = text.split(/\n(?=- id: )/).filter(function (b) { return b.trim().startsWith("- id: "); });
    for (const block of blocks) {
      const idMatch = block.match(/- id:\s*(\S+)/);
      const dateMatch = block.match(/date:\s*(\S+)/);
      const tagsMatch = block.match(/tags:\s*\[([^\]]*)\]/);
      const factMatch = block.match(/fact:\s*(.+)/);
      if (idMatch && factMatch) {
        entries.push({
          id: idMatch[1].trim(),
          date: dateMatch ? dateMatch[1].trim() : "",
          file: "topics/" + file,
          tags: tagsMatch ? tagsMatch[1].trim() : "",
          fact: factMatch[1].trim()
        });
      }
    }
  }
  return entries;
}

function parseSessionEntries(rootDir) {
  const sessionDir = path.join(rootDir, "sessions");
  if (!fs.existsSync(sessionDir)) return [];
  const files = fs.readdirSync(sessionDir).filter(function (f) {
    return f.endsWith(".md") && f.toLowerCase() !== "readme.md";
  });
  const entries = [];

  for (const file of files) {
    const raw = fs.readFileSync(path.join(sessionDir, file), "utf8").replace(/\r\n/g, "\n");
    const base = file.replace(/\.md$/, "");
    const titleMatch = raw.match(/^#\s+(.+)$/m);
    const title = titleMatch ? titleMatch[1].trim() : base;
    const dateMatch = base.match(/^(\d{4}-\d{2}-\d{2})_(.+)$/);
    const date = dateMatch ? dateMatch[1] : "";
    const slug = dateMatch ? dateMatch[2] : base;
    const tags = slug.replace(/-\d+$/, "").split(/[-_]+/).filter(Boolean).join(", ");

    const sections = [];
    const targetHeadings = [
      "What was built/fixed/decided",
      "Key decisions",
      "Problems solved",
      "Gotchas / live traps",
      "Patterns discovered",
      "Outcome"
    ];

    for (const heading of targetHeadings) {
      const re = new RegExp("##\\s+" + heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*\\n([\\s\\S]*?)(?=\\n##\\s+|$)", "i");
      const m = raw.match(re);
      if (m && m[1].trim()) {
        const cleaned = m[1].trim().replace(/\n+/g, " ").replace(/\s+/g, " ");
        sections.push(heading + ": " + cleaned);
      }
    }

    const factText = title + " — " + (sections.join(" | ").slice(0, 700) || raw.replace(/\s+/g, " ").slice(0, 500));
    entries.push({
      id: "session:" + base,
      date: date,
      file: "sessions/" + file,
      tags: tags,
      fact: factText
    });
  }
  return entries;
}

async function syncVectors(rootDir) {
  ensureMemoryLayout(rootDir);
  const vecFile = path.join(rootDir, "vectors.json");
  const existingMap = new Map();

  if (fs.existsSync(vecFile)) {
    try {
      const prev = JSON.parse(fs.readFileSync(vecFile, "utf8"));
      for (const item of prev) {
        if (item && item.id && Array.isArray(item.vector)) {
          existingMap.set(item.id, item);
        }
      }
    } catch {
      // Rebuild if corrupted
    }
  }

  const parsed = parseTopicEntries(rootDir).concat(parseSessionEntries(rootDir));
  let embeddedCount = 0;
  let reusedCount = 0;

  for (const entry of parsed) {
    const prev = existingMap.get(entry.id);
    if (prev && prev.fact === entry.fact && prev.tags === entry.tags && Array.isArray(prev.vector)) {
      entry.vector = prev.vector;
      reusedCount++;
    } else {
      entry.vector = await embedText(entry.fact + " " + entry.tags);
      embeddedCount++;
    }
  }

  const changed = embeddedCount > 0 || parsed.length !== existingMap.size;
  if (changed || !fs.existsSync(vecFile)) {
    fs.writeFileSync(vecFile, JSON.stringify(parsed, null, 1), "utf8");
  }

  for (const item of parsed) {
    item._haystack = (item.id + " " + item.tags + " " + item.fact + " " + item.file).toLowerCase();
  }
  cachedEntries = parsed;
  cachedRootDir = path.resolve(rootDir);
  cachedMtime = fs.existsSync(vecFile) ? fs.statSync(vecFile).mtimeMs : Date.now();
  cachedVersion++;
  cachedTopicSlugs = null;
  cachedTopicsRootDir = "";
  return { total: parsed.length, embedded: embeddedCount, reused: reusedCount, vecFile: vecFile };
}

function loadCachedVectors(rootDir) {
  const resolved = path.resolve(rootDir);
  const vecFile = path.join(resolved, "vectors.json");
  if (!fs.existsSync(vecFile)) return [];
  const stat = fs.statSync(vecFile);
  if (cachedEntries && cachedRootDir === resolved && cachedMtime === stat.mtimeMs) {
    return cachedEntries;
  }
  const parsed = JSON.parse(fs.readFileSync(vecFile, "utf8"));
  for (const item of parsed) {
    if (item && !item._haystack) {
      item._haystack = (item.id + " " + item.tags + " " + item.fact + " " + item.file).toLowerCase();
    }
  }
  cachedEntries = parsed;
  cachedRootDir = resolved;
  cachedMtime = stat.mtimeMs;
  cachedVersion++;
  return cachedEntries;
}

function getTopicSlugs(rootDir) {
  const resolved = path.resolve(rootDir);
  if (cachedTopicSlugs && cachedTopicsRootDir === resolved) return cachedTopicSlugs;
  const topicDir = path.join(resolved, "topics");
  cachedTopicSlugs = fs.existsSync(topicDir)
    ? fs.readdirSync(topicDir)
        .filter(function (f) { return f.endsWith(".md") && f.toLowerCase() !== "readme.md"; })
        .map(function (f) { return f.replace(/\.md$/i, ""); })
    : [];
  cachedTopicsRootDir = resolved;
  return cachedTopicSlugs;
}

function dotProduct(a, b) {
  let sum = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) sum += a[i] * b[i];
  return sum;
}

async function searchMemory(rootDir, query, mode, topN) {
  const cleanQuery = String(query || "").trim();
  if (!cleanQuery) return [];
  const limit = Number(topN) || 8;
  const searchMode = mode || "hybrid";

  let entries = loadCachedVectors(rootDir);
  if (entries.length === 0) {
    await syncVectors(rootDir);
    entries = loadCachedVectors(rootDir);
  }

  const results = [];
  const words = cleanQuery.toLowerCase().split(/\s+/).filter(function (w) { return w.length >= 2; });

  let queryVec = null;
  if (searchMode === "semantic" || searchMode === "hybrid") {
    queryVec = await embedText(cleanQuery);
  }

  for (const entry of entries) {
    let semanticScore = 0;
    if (queryVec && Array.isArray(entry.vector)) {
      semanticScore = dotProduct(queryVec, entry.vector);
    }

    let lexicalScore = 0;
    const haystack = entry._haystack || (entry._haystack = (entry.id + " " + entry.tags + " " + entry.fact + " " + entry.file).toLowerCase());
    if (haystack.includes(cleanQuery.toLowerCase())) {
      lexicalScore = 0.35;
    } else if (words.length > 0) {
      let matched = 0;
      for (const w of words) {
        if (haystack.includes(w)) matched++;
      }
      lexicalScore = (matched / words.length) * 0.25;
    }

    const score = searchMode === "grep"
      ? lexicalScore
      : (searchMode === "semantic" ? semanticScore : semanticScore + lexicalScore);

    if (searchMode === "grep" && lexicalScore === 0) continue;
    results.push({ score: score, semanticScore: semanticScore, entry: entry });
  }

  results.sort(function (a, b) { return b.score - a.score; });
  return results.slice(0, limit);
}

function nextTopicId(topicText, topicSlug) {
  const re = /- id:\s*([a-z0-9-]+?)-(\d+)\s*$/gm;
  let maxNum = 0;
  let detectedPrefix = topicSlug;
  let m;
  while ((m = re.exec(topicText)) !== null) {
    const n = parseInt(m[2], 10);
    if (n > maxNum) {
      maxNum = n;
      detectedPrefix = m[1];
    }
  }
  return detectedPrefix + "-" + String(maxNum + 1).padStart(3, "0");
}

async function storeMemoryFact(rootDir, input) {
  ensureMemoryLayout(rootDir);
  const rawTopic = String(input.topic || "decisions").toLowerCase().replace(/[^a-z0-9-_]/g, "-");
  const topicFile = path.join(rootDir, "topics", rawTopic + ".md");
  const indexFile = path.join(rootDir, "memory.md");

  let existingText = "";
  if (fs.existsSync(topicFile)) {
    existingText = fs.readFileSync(topicFile, "utf8");
  } else {
    const heading = "# " + rawTopic.charAt(0).toUpperCase() + rawTopic.slice(1) + "\n";
    existingText = heading;
    if (fs.existsSync(indexFile)) {
      const idxContent = fs.readFileSync(indexFile, "utf8");
      if (!idxContent.includes("topics/" + rawTopic + ".md") && !idxContent.includes("topics\\" + rawTopic + ".md")) {
        const updatedIdx = idxContent.trimEnd() + "\n- `topics/" + rawTopic + ".md` - " + rawTopic + " entries\n";
        fs.writeFileSync(indexFile, updatedIdx, "utf8");
      }
    }
  }

  const id = input.id ? String(input.id).trim() : nextTopicId(existingText, rawTopic);
  const today = new Date().toISOString().split("T")[0];
  const tagsList = Array.isArray(input.tags)
    ? input.tags.map(function (t) { return String(t).trim(); }).filter(Boolean).join(", ")
    : String(input.tags || rawTopic).trim();
  const cleanFact = String(input.fact || "").replace(/\s+/g, " ").trim();

  const block = [
    "",
    "- id: " + id,
    "  date: " + today,
    "  tags: [" + tagsList + "]",
    "  fact: " + cleanFact,
    ""
  ].join("\n");

  fs.writeFileSync(topicFile, existingText.trimEnd() + "\n" + block, "utf8");

  const vec = await embedText(cleanFact + " " + tagsList);
  const vecFile = path.join(rootDir, "vectors.json");
  const entries = loadCachedVectors(rootDir).filter(function (e) { return e.id !== id; });
  const newEntry = {
    id: id,
    date: today,
    file: "topics/" + rawTopic + ".md",
    tags: tagsList,
    fact: cleanFact,
    vector: vec
  };
  entries.push(newEntry);
  const serializable = entries.map(function (e) {
    return { id: e.id, date: e.date, file: e.file, tags: e.tags, fact: e.fact, vector: e.vector };
  });
  fs.writeFileSync(vecFile, JSON.stringify(serializable, null, 1), "utf8");
  newEntry._haystack = (newEntry.id + " " + newEntry.tags + " " + newEntry.fact + " " + newEntry.file).toLowerCase();
  cachedEntries = entries;
  cachedRootDir = path.resolve(rootDir);
  cachedMtime = fs.statSync(vecFile).mtimeMs;
  cachedVersion++;
  cachedTopicSlugs = null;
  cachedTopicsRootDir = "";

  return newEntry;
}

async function storeSessionCheckpoint(rootDir, input) {
  ensureMemoryLayout(rootDir);
  const sessionDir = path.join(rootDir, "sessions");
  const today = new Date().toISOString().split("T")[0];
  const slug = String(input.slug || "session").toLowerCase().replace(/[^a-z0-9-_]/g, "-");
  const prefix = today + "_" + slug + "-";

  const existingNums = fs.readdirSync(sessionDir)
    .filter(function (f) { return f.startsWith(prefix) && f.endsWith(".md"); })
    .map(function (f) {
      const m = f.match(/-(\d+)\.md$/);
      return m ? parseInt(m[1], 10) : 0;
    });
  const nextNum = existingNums.length > 0 ? Math.max.apply(null, existingNums) + 1 : 1;
  const numStr = String(nextNum).padStart(2, "0");
  const filename = prefix + numStr + ".md";
  const filepath = path.join(sessionDir, filename);

  const title = String(input.title || slug).trim();
  const pct = input.contextPct !== undefined ? String(input.contextPct) + "% used at checkpoint" : "auto";
  const project = String(input.project || "global").trim();
  const summary = String(input.summary || "").trim();

  const md = [
    "# " + title,
    "",
    "**Date**: " + today,
    "**Checkpoint**: " + numStr,
    "**Context**: " + pct,
    "**Project**: " + project,
    "",
    summary,
    ""
  ].join("\n");

  fs.writeFileSync(filepath, md, "utf8");

  const stateFile = path.join(rootDir, ".session-state");
  fs.writeFileSync(stateFile, "slug=" + slug + "\nlast_checkpoint_pct=" + (Number(input.contextPct) || 0) + "\n", "utf8");

  await syncVectors(rootDir);
  return { filename: filename, filepath: filepath, checkpoint: numStr };
}

function extractLastUserText(messages) {
  if (!Array.isArray(messages)) return "";
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (!msg) continue;
    if (msg.role === "user") {
      if (typeof msg.content === "string") return msg.content;
      if (typeof msg.text === "string") return msg.text;
      if (Array.isArray(msg.content)) {
        const textParts = msg.content
          .filter(function (p) { return p && (p.type === "text" || typeof p.text === "string"); })
          .map(function (p) { return p.text || ""; });
        if (textParts.length > 0) return textParts.join(" ");
      }
      if (Array.isArray(msg.parts)) {
        const textParts = msg.parts
          .filter(function (p) { return p && p.type === "text"; })
          .map(function (p) { return p.text || ""; });
        if (textParts.length > 0) return textParts.join(" ");
      }
    }
  }
  return "";
}

function createPluginDefinition() {
  return {
    id: "opencode-local-memory",
    async setup(ctx) {
      const options = (ctx && ctx.options) || {};
      const rootDir = resolveMemoryDir(options.directory);
      const minScore = Number(options.minScore || 0.38);
      const topK = Number(options.topK || 6);

      loadCachedVectors(rootDir);
      getEmbedder().catch(function () {});
      syncVectors(rootDir).catch(function (err) {
        console.error("local-memory sync error:", err);
      });

      const registrations = [];

      if (ctx && ctx.tool && typeof ctx.tool.transform === "function") {
        const toolReg = await ctx.tool.transform(function (editor) {
          editor.add({
            name: "memory_store",
            description: "Atomically store a persistent memory fact into a topic file and update semantic vectors immediately. Call this whenever the user states a preference/rule, corrects the agent, makes an architectural decision, or uncovers a non-obvious environment fact.",
            input: {
              type: "object",
              properties: {
                topic: {
                  type: "string",
                  description: "Topic filename slug without .md (e.g. preferences, decisions, environment, agent-behavior, tools)"
                },
                tags: {
                  type: "string",
                  description: "Comma-separated keywords for retrieval"
                },
                fact: {
                  type: "string",
                  description: "Concise one-line statement of the fact, decision, or preference"
                },
                id: {
                  type: "string",
                  description: "Optional explicit ID (auto-generated as <topic>-<nnn> when omitted)"
                }
              },
              required: ["topic", "tags", "fact"],
              additionalProperties: false
            },
            execute: async function (input) {
              const saved = await storeMemoryFact(rootDir, input);
              return {
                content: "Stored [" + saved.id + "] in " + saved.file + " and updated vectors.json:\n" + saved.fact
              };
            }
          });

          editor.add({
            name: "memory_search",
            description: "Search persistent local memory (both atomic topic facts and session checkpoint summaries) using hybrid semantic + keyword matching.",
            input: {
              type: "object",
              properties: {
                query: {
                  type: "string",
                  description: "Search query or keywords"
                },
                mode: {
                  type: "string",
                  enum: ["hybrid", "semantic", "grep"],
                  description: "Search mode (default: hybrid)"
                },
                topN: {
                  type: "number",
                  description: "Maximum results to return (default: 8)"
                }
              },
              required: ["query"],
              additionalProperties: false
            },
            execute: async function (input) {
              const hits = await searchMemory(rootDir, input.query, input.mode || "hybrid", input.topN || 8);
              if (hits.length === 0) {
                return { content: "No matching memory entries found." };
              }
              const formatted = hits.map(function (h) {
                return h.score.toFixed(3) + "  [" + h.entry.id + "] " + h.entry.fact + "  (" + h.entry.file + ")";
              }).join("\n");
              return { content: formatted };
            }
          });

          editor.add({
            name: "memory_checkpoint",
            description: "Save a numbered session checkpoint summary to sessions/YYYY-MM-DD_<slug>-<NN>.md and index it into vectors.json.",
            input: {
              type: "object",
              properties: {
                slug: {
                  type: "string",
                  description: "Short kebab-case session topic slug"
                },
                title: {
                  type: "string",
                  description: "Short descriptive title for the checkpoint"
                },
                summary: {
                  type: "string",
                  description: "Markdown summary body (What was built/fixed/decided, Key decisions, Files changed, Problems solved, Outcome)"
                },
                project: {
                  type: "string",
                  description: "Project path or 'global'"
                },
                contextPct: {
                  type: "number",
                  description: "Optional context usage percentage"
                }
              },
              required: ["slug", "title", "summary"],
              additionalProperties: false
            },
            execute: async function (input) {
              const saved = await storeSessionCheckpoint(rootDir, input);
              return {
                content: "Saved and indexed session checkpoint: " + saved.filename
              };
            }
          });
        });
        if (toolReg) registrations.push(toolReg);
      }

      if (ctx && ctx.session && typeof ctx.session.hook === "function") {
        const ctxReg = await ctx.session.hook("context", async function (event) {
          const userText = extractLastUserText(event.messages);
          const ctxKey = String(userText || "").trim() + "::" + cachedVersion;
          if (ctxKey === lastContextKey && lastContextText) {
            if (Array.isArray(event.system)) {
              event.system.push({ type: "text", text: lastContextText });
            }
            return;
          }

          const topicSlugs = getTopicSlugs(rootDir);
          const lines = [
            "<local-memory-plugin>",
            "Persistent memory (`opencode-local-memory`) is active at: " + rootDir,
            "Available topics: " + (topicSlugs.join(", ") || "preferences, decisions, environment, agent-behavior") + " (or pass any new topic slug to create a new file).",
            "",
            "AUTOMATIC STORAGE (via `memory_store` tool — no prompting needed):",
            "Call `memory_store` immediately in the SAME turn before your final response whenever any of these happen:",
            "- User states a preference, convention, or 'always/never do X' rule",
            "- An architecture, workflow, or design decision is made (yours or theirs)",
            "- A non-obvious environment, path, port, or tooling fact is discovered",
            "- A recurring correction or pattern emerges",
            "- The user has to correct you or repeat an instruction (store it so it never needs repeating)",
            "Hard gate: before finishing every task, check if any trigger above fired. If it did, call `memory_store` NOW — never promise to remember later. Do NOT store trivial exchanges, transient debugging steps, duplicates, or secrets.",
            "",
            "WHERE TO STORE:",
            "- Global (`memory_store` tool): coding style, tooling preferences, agent behavior rules, cross-project decisions, and environment facts that remain true in a new project tomorrow.",
            "- Project (`AGENTS.md` in repo root): repo-specific architecture, asset IDs, endpoints, or conventions true only inside that repo.",
            "",
            "AUTOMATIC RECALL & CHECKPOINTS:",
            "- When the user references 'we discussed', 'last time', 'earlier', a settled decision, or when a topic needs deeper lookup than the auto-recalled hits below, call `memory_search` (`mode: 'hybrid' | 'semantic' | 'grep'`).",
            "- Session compactions are checkpointed automatically. At the end of significant work sessions (architecture decisions, hard-won fixes, new patterns), call `memory_checkpoint` with `slug`, `title`, and a distilled `summary`."
          ];

          if (userText && userText.trim().length >= 5) {
            const hits = await searchMemory(rootDir, userText, "hybrid", topK).catch(function () { return []; });
            const relevant = hits.filter(function (h) { return h.score >= minScore; });
            if (relevant.length > 0) {
              lines.push("Auto-recalled memories for this prompt:");
              for (const h of relevant) {
                lines.push("- [" + h.entry.id + "] (" + h.entry.file + "): " + h.entry.fact);
              }
            }
          }

          lines.push("</local-memory-plugin>");
          lastContextKey = ctxKey;
          lastContextText = lines.join("\n");
          if (Array.isArray(event.system)) {
            event.system.push({ type: "text", text: lastContextText });
          }
        });
        if (ctxReg) registrations.push(ctxReg);

        const compReg = await ctx.session.hook("compaction", async function (event) {
          const lastText = extractLastUserText(event.messages);
          const slug = lastText
            ? lastText.toLowerCase().replace(/[^a-z0-9\s]/g, "").trim().split(/\s+/).slice(0, 4).join("-") || "compaction"
            : "compaction";
          const projectDir = (ctx.location && ctx.location.directory) ? ctx.location.directory : "global";
          await storeSessionCheckpoint(rootDir, {
            slug: slug,
            title: "Auto Compaction Checkpoint (" + slug + ")",
            project: projectDir,
            summary: "## What was built/fixed/decided\n\nAutomatic checkpoint captured at session compaction.\n\n## Last active prompt\n\n" + (lastText || "N/A")
          }).catch(function (err) {
            console.error("local-memory compaction checkpoint error:", err);
          });
        });
        if (compReg) registrations.push(compReg);
      }

      return async function () {
        for (const reg of registrations) {
          if (reg && typeof reg.dispose === "function") {
            await reg.dispose();
          }
        }
      };
    }
  };
}

const server = createPluginDefinition();
export default server;
export {
  server,
  resolveMemoryDir,
  resolveConfigDir,
  ensureMemoryLayout,
  installPlugin,
  parseTopicEntries,
  parseSessionEntries,
  nextTopicId,
  getTopicSlugs,
  loadCachedVectors,
  syncVectors,
  searchMemory,
  storeMemoryFact,
  storeSessionCheckpoint
};

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isDirectRun) {
  const cmd = process.argv[2] || "sync";
  const rootDir = resolveMemoryDir(process.env.OPENCODE_MEMORY_DIR);

  if (cmd === "install" || cmd === "init" || cmd === "setup") {
    let customDir = process.env.OPENCODE_MEMORY_DIR || "";
    const dirFlagIdx = process.argv.indexOf("--dir");
    if (dirFlagIdx !== -1 && process.argv[dirFlagIdx + 1]) {
      customDir = process.argv[dirFlagIdx + 1];
    }
    installPlugin({ directory: customDir || undefined }).then(function (res) {
      console.log("opencode-local-memory installed:");
      console.log("  Server config: " + res.serverConfigFile + " (" + res.serverStatus + ")");
      console.log("  TUI config:    " + res.cliConfigFile + " (" + res.cliStatus + ")");
      console.log("  Memory folder: " + res.memoryDir);
      console.log("  Vectors cache: " + res.syncResult.vecFile + " (" + res.syncResult.total + " entries ready)");
    }).catch(function (err) {
      console.error("Install failed:", err);
      process.exit(1);
    });
  } else if (cmd === "sync" || cmd === "embed") {
    syncVectors(rootDir).then(function (res) {
      console.log("Synced " + res.total + " memory entries (" + res.embedded + " newly embedded, " + res.reused + " cached) -> " + res.vecFile);
    }).catch(function (err) {
      console.error("Sync failed:", err);
      process.exit(1);
    });
  } else if (cmd === "search" || cmd === "recall") {
    const query = process.argv[3] || "";
    const mode = cmd === "recall" ? "grep" : (process.argv[4] || "hybrid");
    const topN = parseInt(process.argv[5] || "8", 10);
    searchMemory(rootDir, query, mode, topN).then(function (hits) {
      for (const h of hits) {
        console.log(h.score.toFixed(3) + "  [" + h.entry.id + "] " + h.entry.fact + "  (" + h.entry.file + ")");
      }
    }).catch(function (err) {
      console.error("Search failed:", err);
      process.exit(1);
    });
  } else if (cmd === "store") {
    const topic = process.argv[3];
    const tags = process.argv[4];
    const fact = process.argv.slice(5).join(" ");
    storeMemoryFact(rootDir, { topic: topic, tags: tags, fact: fact }).then(function (entry) {
      console.log("Stored [" + entry.id + "] in " + entry.file);
    }).catch(function (err) {
      console.error("Store failed:", err);
      process.exit(1);
    });
  }
}
