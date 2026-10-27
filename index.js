#!/usr/bin/env node
"use strict";

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const cliName = "open" + "code";

let embedderPromise = null;
let activeSyncPromise = null;
let cachedEntries = null;
let cachedRootDir = "";
let cachedMtime = 0;
let cachedVersion = 0;
let cachedTopicSlugs = null;
let cachedTopicsRootDir = "";
let lastContextKey = "";
let lastContextText = "";
let cachedCorpusStats = null;
const queryVecCache = new Map();
const parsedFileCache = new Map();

const STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "can", "do", "for",
  "from", "had", "has", "have", "how", "if", "in", "into", "is", "it",
  "its", "not", "of", "on", "or", "our", "out", "so", "that", "the",
  "their", "then", "there", "these", "they", "this", "to", "use", "used",
  "using", "was", "we", "were", "what", "when", "where", "which", "who",
  "why", "will", "with", "you", "your"
]);

function tokenizeText(text) {
  if (!text) return [];
  return String(text)
    .toLowerCase()
    .split(/[^a-z0-9_.-]+/)
    .map(function (t) { return t.replace(/^[._-]+|[._-]+$/g, ""); })
    .filter(function (t) { return t.length >= 2; });
}

const UMBRELLA_DIRS = new Set([
  "mampfiles", "git", "hannon-hill", "_clients", "_cms", "_modules",
  "z-old-clients", "client-code-cms", "client-code", "projects",
  "opencode-plugins", "repos", "workspace", "users", "home"
]);

function slugifyScopePart(str) {
  return String(str || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-_]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function isUmbrellaProject(raw) {
  const val = String(raw || "").trim();
  if (!val || val.toLowerCase() === "global" || val.toLowerCase() === "all" || val === "*") return true;
  const norm = val.replace(/\\/g, "/").replace(/\/+$/, "");
  if (/(?:^|\/)(?:_clients|client-code-cms|client-code|projects)\/([a-z0-9._-]+)/i.test(norm)) {
    return false;
  }
  const gitSub = norm.match(/(?:^|\/)git\/(?:hannon-hill|opencode-plugins)\/([a-z0-9._-]+)/i);
  if (gitSub && !UMBRELLA_DIRS.has(gitSub[1].toLowerCase())) return false;
  const gitDirect = norm.match(/(?:^|\/)git\/([a-z0-9._-]+)/i);
  if (gitDirect && !UMBRELLA_DIRS.has(gitDirect[1].toLowerCase())) return false;
  const base = slugifyScopePart(path.posix.basename(norm) || norm);
  return !base || UMBRELLA_DIRS.has(base);
}

function normalizeProjectScope(raw) {
  const val = String(raw || "").trim();
  if (!val || val.toLowerCase() === "global" || val === "*") return "global";
  if (val.toLowerCase() === "all") return "all";
  const norm = val.replace(/\\/g, "/").replace(/\/+$/, "");

  if (/^(cms|git)\/[a-z0-9-_]+$/i.test(norm)) {
    const parts = norm.split("/");
    return parts[0].toLowerCase() + "/" + slugifyScopePart(parts[1]);
  }

  const cmsMatch = norm.match(/(?:^|\/)(?:_clients|client-code-cms|client-code|projects)\/([a-z0-9._-]+)/i);
  if (cmsMatch && !UMBRELLA_DIRS.has(cmsMatch[1].toLowerCase())) {
    return "cms/" + slugifyScopePart(cmsMatch[1]);
  }

  const gitNested = norm.match(/(?:^|\/)git\/(?:hannon-hill|opencode-plugins)\/([a-z0-9._-]+)/i);
  if (gitNested && !UMBRELLA_DIRS.has(gitNested[1].toLowerCase())) {
    return "git/" + slugifyScopePart(gitNested[1]);
  }

  const gitRepo = norm.match(/(?:^|\/)git\/([a-z0-9._-]+)/i);
  if (gitRepo && !UMBRELLA_DIRS.has(gitRepo[1].toLowerCase())) {
    return "git/" + slugifyScopePart(gitRepo[1]);
  }

  const mampChild = norm.match(/(?:^|\/)mampfiles\/([a-z0-9._-]+)/i);
  if (mampChild) {
    const child = slugifyScopePart(mampChild[1]);
    if (child && child !== "agent" && !UMBRELLA_DIRS.has(child)) {
      return child;
    }
  }

  const base = slugifyScopePart(path.posix.basename(norm) || norm);
  if (!base || UMBRELLA_DIRS.has(base)) return "global";
  return base;
}

function getProjectLeaf(scope) {
  const norm = normalizeProjectScope(scope);
  const idx = norm.lastIndexOf("/");
  return idx !== -1 ? norm.slice(idx + 1) : norm;
}

function projectSlugsEquivalent(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  const leafA = getProjectLeaf(a);
  const leafB = getProjectLeaf(b);
  if (leafA === leafB) return true;
  if (("u" + leafA === leafB || "u" + leafB === leafA) && Math.min(leafA.length, leafB.length) >= 4) {
    return true;
  }
  return false;
}

function matchesProjectScope(entryProject, targetProject, includeGlobal) {
  const eProj = normalizeProjectScope(entryProject);
  if (Array.isArray(targetProject)) {
    if (targetProject.length === 0) return true;
    if (includeGlobal !== false && eProj === "global") return true;
    return targetProject.some(function (t) { return projectSlugsEquivalent(eProj, normalizeProjectScope(t)); });
  }
  const tProj = normalizeProjectScope(targetProject);
  if (tProj === "all" || tProj === "global") {
    if (includeGlobal === false && tProj === "global") return eProj === "global";
    return true;
  }
  if (projectSlugsEquivalent(eProj, tProj)) return true;
  if (includeGlobal !== false && eProj === "global") return true;
  return false;
}

function detectProjectsFromText(text, entries) {
  if (!text) return [];
  const raw = String(text);
  const norm = raw.replace(/\\/g, "/");
  const detected = new Set();

  const pathPatterns = [
    /(?:^|[\s"'`(])(?:[a-z]:)?[^\s"'`)]*?\/(?:_clients|client-code-cms|client-code)\/([a-z0-9._-]+)/gi,
    /(?:^|[\s"'`(])(?:[a-z]:)?[^\s"'`)]*?\/git\/(?:hannon-hill|opencode-plugins)\/([a-z0-9._-]+)/gi,
    /(?:^|[\s"'`(])(?:[a-z]:)?[^\s"'`)]*?\/git\/([a-z0-9._-]+)/gi,
    /\b(?:cms|git)\/([a-z0-9._-]+)\b/gi
  ];

  for (const re of pathPatterns) {
    let m;
    while ((m = re.exec(norm)) !== null) {
      const slug = slugifyScopePart(m[1]);
      if (slug && !UMBRELLA_DIRS.has(slug)) {
        detected.add(slug);
      }
    }
  }

  const tokens = new Set(tokenizeText(raw));
  if (Array.isArray(entries)) {
    const knownProjects = new Set();
    for (const e of entries) {
      if (e.project && e.project !== "global") {
        knownProjects.add(getProjectLeaf(e.project));
      }
    }
    for (const proj of knownProjects) {
      if (tokens.has(proj)) {
        detected.add(proj);
      } else if (proj.length >= 4 && tokens.has("u" + proj)) {
        detected.add(proj);
      } else if (proj.startsWith("u") && proj.length >= 5 && tokens.has(proj.slice(1))) {
        detected.add(proj);
      }
    }
  }

  return Array.from(detected);
}

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
  if (process.env.OPENCODE_CONFIG_DIR) {
    return path.resolve(process.env.OPENCODE_CONFIG_DIR);
  }
  const configBase = process.env.XDG_CONFIG_HOME
    ? path.resolve(process.env.XDG_CONFIG_HOME)
    : path.join(os.homedir(), ".config");
  return path.join(configBase, cliName);
}

function findPluginsArraySpan(raw) {
  const keyRe = /"plugins"\s*:\s*\[/g;
  const match = keyRe.exec(raw);
  if (!match) return null;
  const openBracketIdx = match.index + match[0].length - 1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = openBracketIdx; i < raw.length; i++) {
    const ch = raw[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === "/" && raw[i + 1] === "/") {
      const nl = raw.indexOf("\n", i + 2);
      if (nl === -1) break;
      i = nl;
      continue;
    }
    if (ch === "/" && raw[i + 1] === "*") {
      const endComment = raw.indexOf("*/", i + 2);
      if (endComment === -1) break;
      i = endComment + 1;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "[") depth++;
    else if (ch === "]") {
      depth--;
      if (depth === 0) {
        return {
          start: match.index,
          openEnd: openBracketIdx + 1,
          closeStart: i,
          end: i + 1
        };
      }
    }
  }
  return null;
}

function findLastCodeCharIndex(str) {
  let lastIdx = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (inString) {
      lastIdx = i;
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === "/" && str[i + 1] === "/") {
      const nl = str.indexOf("\n", i + 2);
      if (nl === -1) break;
      i = nl;
      continue;
    }
    if (ch === "/" && str[i + 1] === "*") {
      const endComment = str.indexOf("*/", i + 2);
      if (endComment === -1) break;
      i = endComment + 1;
      continue;
    }
    if (ch === '"') {
      inString = true;
      lastIdx = i;
      continue;
    }
    if (!/\s/.test(ch)) {
      lastIdx = i;
    }
  }
  return lastIdx;
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

  const span = findPluginsArraySpan(raw);
  if (span) {
    const open = raw.slice(span.start, span.openEnd);
    const body = raw.slice(span.openEnd, span.closeStart);
    const close = raw.slice(span.closeStart, span.end);
    const lastCodeIdx = findLastCodeCharIndex(body);
    let replacement;
    if (lastCodeIdx === -1) {
      replacement = open + "\n    " + pluginEntryStr + "\n  " + close;
    } else {
      const needsComma = body[lastCodeIdx] !== ",";
      const withComma = needsComma
        ? body.slice(0, lastCodeIdx + 1) + "," + body.slice(lastCodeIdx + 1)
        : body;
      const trimmedBody = withComma.replace(/\s*$/, "");
      replacement = open + trimmedBody + "\n    " + pluginEntryStr + "\n  " + close;
    }
    const updated = raw.slice(0, span.start) + replacement + raw.slice(span.end);
    fs.writeFileSync(filePath, updated, "utf8");
    return "updated";
  }

  const lastBrace = raw.lastIndexOf("}");
  if (lastBrace !== -1) {
    const beforeSlice = raw.slice(0, lastBrace);
    const lastCodeIdx = findLastCodeCharIndex(beforeSlice);
    const lastChar = lastCodeIdx !== -1 ? beforeSlice[lastCodeIdx] : "{";
    const needsComma = lastChar !== "{" && lastChar !== ",";
    const withComma = (needsComma && lastCodeIdx !== -1)
      ? beforeSlice.slice(0, lastCodeIdx + 1) + "," + beforeSlice.slice(lastCodeIdx + 1)
      : beforeSlice;
    const before = withComma.replace(/\s*$/, "");
    const updated = before + '\n  "plugins": [\n    ' + pluginEntryStr + "\n  ]\n}\n";
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
    ? JSON.stringify([pkgName, { directory: opts.directory }])
    : JSON.stringify(pkgName);
  const cliEntryStr = opts.directory
    ? JSON.stringify([pkgName, { directory: opts.directory }])
    : JSON.stringify(pkgName);

  const serverStatus = addPluginToJsoncFile(serverConfigFile, "https://" + cliName + ".ai/config.json", serverEntryStr, matchKey);
  const cliStatus = addPluginToJsoncFile(cliConfigFile, "https://" + cliName + ".ai/v2/cli.json", cliEntryStr, matchKey);

  ensureMemoryLayout(rootDir);
  const importResult = opts.importExisting
    ? await importExistingMemory(rootDir, {
        dbPath: opts.dbPath,
        agentsFiles: opts.agentsFiles,
        projectDir: opts.projectDir,
        limit: opts.limit,
        skipSync: true
      })
    : null;
  const syncResult = opts.skipSync ? { total: 0, embedded: 0, reused: 0, vecFile: path.join(rootDir, "vectors.json") } : await syncVectors(rootDir);

  return {
    configDir: configDir,
    serverConfigFile: serverConfigFile,
    serverStatus: serverStatus,
    cliConfigFile: cliConfigFile,
    cliStatus: cliStatus,
    memoryDir: rootDir,
    importResult: importResult,
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
  })().catch(function (err) {
    embedderPromise = null;
    throw err;
  });
  return embedderPromise;
}

function runSubprocessCli(args) {
  return new Promise(function (resolve, reject) {
    const baseEnv = Object.assign({}, process.env, { OPENCODE_MEMORY_SUBPROCESS: "1" });
    execFile("node", [__filename].concat(args), { env: baseEnv, windowsHide: true, timeout: 120000 }, function (err, stdout) {
      if (!err) return resolve(String(stdout || ""));
      const bunEnv = Object.assign({}, baseEnv, { BUN_BE_BUN: "1" });
      execFile(process.execPath, [__filename].concat(args), { env: bunEnv, windowsHide: true, timeout: 120000 }, function (err2, stdout2) {
        if (err2) return reject(err);
        resolve(String(stdout2 || ""));
      });
    });
  });
}

async function embedText(text) {
  const key = String(text || "").trim().toLowerCase();
  if (queryVecCache.has(key)) {
    return queryVecCache.get(key);
  }
  const embed = await getEmbedder();
  const out = await embed(text, { pooling: "mean", normalize: true });
  const vec = Array.from(out.data, function (v) {
    return Math.round(v * 1e6) / 1e6;
  });
  if (out && typeof out.dispose === "function") {
    try {
      out.dispose();
    } catch {
      // ignore dispose errors
    }
  }
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
    const fullPath = path.join(topicDir, file);
    let stat;
    try {
      stat = fs.statSync(fullPath);
    } catch {
      continue;
    }
    const cached = parsedFileCache.get(fullPath);
    if (cached && cached.mtimeMs === stat.mtimeMs) {
      for (const item of cached.entries) {
        entries.push(Object.assign({}, item));
      }
      continue;
    }

    const text = fs.readFileSync(fullPath, "utf8").replace(/\r\n/g, "\n");
    const blocks = text.split(/\n(?=- id: )/).filter(function (b) { return b.trim().startsWith("- id: "); });
    const fileEntries = [];
    for (const block of blocks) {
      const idMatch = block.match(/- id:\s*(\S+)/);
      const dateMatch = block.match(/date:\s*(\S+)/);
      const tagsMatch = block.match(/tags:\s*\[([^\]]*)\]/);
      const projectMatch = block.match(/^\s*project:\s*(.+)$/m);
      const coreMatch = block.match(/^\s*core:\s*(true|false)\s*$/mi);
      const factMatch = block.match(/fact:\s*(.+)/);
      if (idMatch && factMatch) {
        const tagsStr = tagsMatch ? tagsMatch[1].trim() : "";
        const hasCoreTag = /(?:^|,)\s*core\s*(?:,|$)/i.test(tagsStr);
        const isCore = coreMatch ? coreMatch[1].toLowerCase() === "true" : hasCoreTag;
        const proj = projectMatch ? normalizeProjectScope(projectMatch[1].trim()) : "global";
        const entry = {
          id: idMatch[1].trim(),
          date: dateMatch ? dateMatch[1].trim() : "",
          file: "topics/" + file,
          tags: tagsStr,
          fact: factMatch[1].trim()
        };
        if (proj !== "global") entry.project = proj;
        if (isCore) entry.core = true;
        fileEntries.push(entry);
        entries.push(Object.assign({}, entry));
      }
    }
    parsedFileCache.set(fullPath, { mtimeMs: stat.mtimeMs, entries: fileEntries });
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
    const fullPath = path.join(sessionDir, file);
    let stat;
    try {
      stat = fs.statSync(fullPath);
    } catch {
      continue;
    }
    const cached = parsedFileCache.get(fullPath);
    if (cached && cached.mtimeMs === stat.mtimeMs) {
      for (const item of cached.entries) {
        entries.push(Object.assign({}, item));
      }
      continue;
    }

    const raw = fs.readFileSync(fullPath, "utf8").replace(/\r\n/g, "\n");
    const base = file.replace(/\.md$/, "");
    const titleMatch = raw.match(/^#\s+(.+)$/m);
    const title = titleMatch ? titleMatch[1].trim() : base;
    const dateMatch = base.match(/^(\d{4}-\d{2}-\d{2})_(.+)$/);
    const date = dateMatch ? dateMatch[1] : "";
    const slug = dateMatch ? dateMatch[2] : base;
    const tags = slug.replace(/-\d+$/, "").split(/[-_]+/).filter(Boolean).join(", ");
    const projMatch = raw.match(/^\*\*Project\*\*:\s*(.+)$/m);
    const proj = projMatch ? normalizeProjectScope(projMatch[1].trim()) : "global";

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
    const entry = {
      id: "session:" + base,
      date: date,
      file: "sessions/" + file,
      tags: tags,
      fact: factText
    };
    if (proj !== "global") entry.project = proj;
    parsedFileCache.set(fullPath, { mtimeMs: stat.mtimeMs, entries: [entry] });
    entries.push(Object.assign({}, entry));
  }
  return entries;
}

function serializeEntryLine(e) {
  if (e._jsonLine) return e._jsonLine;
  const obj = {
    id: e.id,
    date: e.date,
    file: e.file,
    tags: e.tags,
    fact: e.fact
  };
  if (e.project && e.project !== "global") obj.project = e.project;
  if (e.core === true) obj.core = true;
  obj.vector = e.vector;
  e._jsonLine = "  " + JSON.stringify(obj);
  return e._jsonLine;
}

function serializeVectorsJson(entries) {
  if (!entries || entries.length === 0) return "[]\n";
  const lines = entries.map(serializeEntryLine);
  return "[\n" + lines.join(",\n") + "\n]\n";
}

function writeVectorsAtomic(vecFile, content) {
  const tmpFile = vecFile + ".tmp." + process.pid;
  try {
    fs.writeFileSync(tmpFile, content, "utf8");
    fs.renameSync(tmpFile, vecFile);
  } catch {
    try {
      if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
    } catch {
      // ignore cleanup error
    }
    fs.writeFileSync(vecFile, content, "utf8");
  }
}

function prepareEntryCacheFields(item) {
  if (!item) return;
  if (!item._haystack) {
    item._haystack = (
      item.id + " " +
      item.tags + " " +
      item.fact + " " +
      item.file +
      (item.project ? " " + item.project : "")
    ).toLowerCase();
  }
  if (!item._idTokens) {
    item._idTokens = new Set(tokenizeText(item.id));
    item._tagTokens = new Set(tokenizeText(item.tags));
    item._fileTokens = new Set(tokenizeText(item.file));
    const factToks = tokenizeText(item.fact);
    const tf = new Map();
    for (const t of factToks) {
      tf.set(t, (tf.get(t) || 0) + 1);
    }
    item._factTf = tf;
    item._docLen = factToks.length + item._tagTokens.size * 2 + item._idTokens.size;
    const allToks = new Set(factToks);
    for (const t of item._idTokens) allToks.add(t);
    for (const t of item._tagTokens) allToks.add(t);
    for (const t of item._fileTokens) allToks.add(t);
    item._allTokens = allToks;
  }
  if (Array.isArray(item.vector) && !(item._vec instanceof Float32Array)) {
    item._vec = new Float32Array(item.vector);
  }
}

function buildCorpusStats(entries) {
  const df = new Map();
  let totalLen = 0;
  const count = entries ? entries.length : 0;
  if (!count) {
    return { N: 0, avgDocLen: 1, df: df };
  }
  for (const entry of entries) {
    prepareEntryCacheFields(entry);
    totalLen += entry._docLen || 1;
    if (entry._allTokens) {
      for (const tok of entry._allTokens) {
        df.set(tok, (df.get(tok) || 0) + 1);
      }
    }
  }
  return {
    N: count,
    avgDocLen: Math.max(1, totalLen / count),
    df: df
  };
}

function computeLexicalScore(entry, cleanQuery, queryTokens, stats) {
  prepareEntryCacheFields(entry);
  const lowerQ = cleanQuery.toLowerCase();
  const idLower = String(entry.id || "").toLowerCase();

  let exactBoost = 0;
  if (lowerQ === idLower || entry._idTokens.has(lowerQ)) {
    exactBoost += 0.55;
  } else if (lowerQ.length >= 4 && entry._haystack.includes(lowerQ)) {
    const escaped = lowerQ.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const boundaryRe = new RegExp("(^|[^a-z0-9])" + escaped + "($|[^a-z0-9])");
    exactBoost += boundaryRe.test(entry._haystack) ? 0.22 : 0.14;
  }

  if (!queryTokens.length) {
    return Math.min(0.6, exactBoost);
  }

  const N = Math.max(1, stats ? stats.N : 1);
  const avgDocLen = stats ? stats.avgDocLen : 20;
  const dfMap = stats ? stats.df : null;
  const k1 = 1.2;
  const b = 0.75;
  const docLen = entry._docLen || 10;

  let bm25Raw = 0;
  let maxPossible = 0;
  let matchedTokens = 0;

  for (const qTok of queryTokens) {
    const df = dfMap ? (dfMap.get(qTok) || 0) : 0;
    const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
    const maxIdf = Math.log(1 + (N + 0.5) / 0.5);
    maxPossible += Math.max(0.5, idf) * (k1 + 1);

    let weightedTf = 0;
    if (entry._idTokens.has(qTok)) weightedTf += 3.0;
    if (entry._tagTokens.has(qTok)) weightedTf += 2.2;
    if (entry._fileTokens.has(qTok)) weightedTf += 1.2;
    if (entry._factTf.has(qTok)) weightedTf += entry._factTf.get(qTok);

    if (weightedTf === 0 && qTok.length >= 4 && entry._allTokens) {
      for (const cand of entry._allTokens) {
        if (cand.startsWith(qTok) || (qTok.length >= 5 && cand.includes(qTok))) {
          weightedTf += 0.55;
          break;
        }
      }
    }

    if (weightedTf > 0) {
      matchedTokens++;
      const effectiveIdf = df > 0 ? idf : maxIdf * 0.85;
      const tfNorm = (weightedTf * (k1 + 1)) / (weightedTf + k1 * (1 - b + b * (docLen / avgDocLen)));
      bm25Raw += effectiveIdf * tfNorm;
    }
  }

  if (matchedTokens === 0 && exactBoost === 0) return 0;

  const coverage = queryTokens.length > 0 ? matchedTokens / queryTokens.length : 0;
  const normalizedBm25 = maxPossible > 0 ? Math.min(1, bm25Raw / maxPossible) : 0;
  const combined = normalizedBm25 * 0.28 + coverage * 0.12 + exactBoost;
  return Math.min(exactBoost >= 0.5 ? 0.85 : 0.65, combined);
}

async function runSyncVectors(rootDir) {
  ensureMemoryLayout(rootDir);
  const vecFile = path.join(rootDir, "vectors.json");
  const existingMap = new Map();
  let prevCount = 0;

  if (fs.existsSync(vecFile)) {
    try {
      const prev = JSON.parse(fs.readFileSync(vecFile, "utf8"));
      prevCount = Array.isArray(prev) ? prev.length : 0;
      for (const item of prev) {
        if (item && item.id && Array.isArray(item.vector)) {
          existingMap.set(item.id + "::" + (item.fact || ""), item);
          if (!existingMap.has(item.id)) {
            existingMap.set(item.id, item);
          }
        }
      }
    } catch {
      // Rebuild if corrupted
    }
  }

  const parsed = parseTopicEntries(rootDir).concat(parseSessionEntries(rootDir));
  let embeddedCount = 0;
  let reusedCount = 0;
  let metadataChanged = false;

  for (const entry of parsed) {
    const prev = existingMap.get(entry.id + "::" + (entry.fact || "")) || existingMap.get(entry.id);
    if (prev && prev.fact === entry.fact && prev.tags === entry.tags && Array.isArray(prev.vector)) {
      entry.vector = prev.vector;
      reusedCount++;
      if ((prev.project || "global") !== (entry.project || "global") || Boolean(prev.core) !== Boolean(entry.core)) {
        metadataChanged = true;
      } else if (prev._jsonLine) {
        entry._jsonLine = prev._jsonLine;
      }
    } else {
      try {
        entry.vector = await embedText(entry.fact + " " + entry.tags);
        embeddedCount++;
      } catch (embedErr) {
        if (process.env.OPENCODE_MEMORY_SUBPROCESS === "1") throw embedErr;
        await runSubprocessCli(["sync", "--dir", rootDir]);
        cachedMtime = 0;
        const reloaded = loadCachedVectors(rootDir) || [];
        return { total: reloaded.length, embedded: parsed.length - reusedCount, reused: reusedCount, vecFile: vecFile };
      }
    }
    prepareEntryCacheFields(entry);
    serializeEntryLine(entry);
  }

  const changed = embeddedCount > 0 || metadataChanged || parsed.length !== prevCount;
  if (changed || !fs.existsSync(vecFile)) {
    writeVectorsAtomic(vecFile, serializeVectorsJson(parsed));
  }

  cachedEntries = parsed;
  cachedCorpusStats = buildCorpusStats(parsed);
  cachedRootDir = path.resolve(rootDir);
  cachedMtime = fs.existsSync(vecFile) ? fs.statSync(vecFile).mtimeMs : Date.now();
  cachedVersion++;
  cachedTopicSlugs = null;
  cachedTopicsRootDir = "";
  return { total: parsed.length, embedded: embeddedCount, reused: reusedCount, vecFile: vecFile };
}

async function syncVectors(rootDir) {
  if (activeSyncPromise) {
    try {
      await activeSyncPromise;
    } catch {
      // Proceed with fresh sync
    }
  }
  const p = runSyncVectors(rootDir);
  activeSyncPromise = p;
  try {
    return await p;
  } finally {
    if (activeSyncPromise === p) {
      activeSyncPromise = null;
    }
  }
}

function loadCachedVectors(rootDir) {
  const resolved = path.resolve(rootDir);
  const vecFile = path.join(resolved, "vectors.json");
  let stat;
  try {
    stat = fs.statSync(vecFile);
  } catch {
    return [];
  }
  if (cachedEntries && cachedRootDir === resolved && cachedMtime === stat.mtimeMs) {
    return cachedEntries;
  }
  const parsed = JSON.parse(fs.readFileSync(vecFile, "utf8"));
  for (const item of parsed) {
    prepareEntryCacheFields(item);
    serializeEntryLine(item);
  }
  cachedEntries = parsed;
  cachedCorpusStats = buildCorpusStats(parsed);
  cachedRootDir = resolved;
  cachedMtime = stat.mtimeMs;
  cachedVersion++;
  return cachedEntries;
}

function getCoreMemories(rootDir, project, queryText) {
  const entries = loadCachedVectors(rootDir);
  const rawProj = String(project || "").trim();
  let targetFilter = "global";
  let includeGlobal = true;

  if (rawProj && rawProj.toLowerCase() === "all") {
    targetFilter = "all";
  } else if (isUmbrellaProject(rawProj)) {
    const detected = queryText ? detectProjectsFromText(queryText, entries) : [];
    if (detected.length > 0) {
      targetFilter = detected;
    } else {
      targetFilter = "global";
      includeGlobal = false;
    }
  } else {
    targetFilter = normalizeProjectScope(rawProj);
  }

  return entries.filter(function (e) {
    const isCore = e.core === true || /(?:^|,)\s*core\s*(?:,|$)/i.test(e.tags || "");
    if (!isCore) return false;
    return matchesProjectScope(e.project, targetFilter, includeGlobal);
  });
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

async function searchMemory(rootDir, query, mode, topN, options) {
  const cleanQuery = String(query || "").trim();
  if (!cleanQuery) return [];
  const limit = Number(topN) || 8;
  const searchMode = mode || "hybrid";
  const opts = options || {};
  const rawProject = String(opts.project || "").trim();
  const includeGlobal = opts.includeGlobal !== false;

  let entries = loadCachedVectors(rootDir);
  if (entries.length === 0) {
    await syncVectors(rootDir);
    entries = loadCachedVectors(rootDir);
  }
  const stats = cachedCorpusStats || buildCorpusStats(entries);

  let effectiveFilter = null;
  let boostTargets = [];
  if (!rawProject || rawProject.toLowerCase() === "all") {
    effectiveFilter = null;
    boostTargets = detectProjectsFromText(cleanQuery, entries);
  } else if (rawProject.toLowerCase() === "global" && !includeGlobal) {
    effectiveFilter = "global";
  } else if (isUmbrellaProject(rawProject)) {
    const detected = detectProjectsFromText(cleanQuery, entries);
    if (detected.length > 0) {
      effectiveFilter = detected;
      boostTargets = detected;
    } else {
      effectiveFilter = null;
    }
  } else {
    const normProj = normalizeProjectScope(rawProject);
    effectiveFilter = normProj;
    boostTargets = [normProj];
  }

  const rawTokens = tokenizeText(cleanQuery);
  const nonStopTokens = rawTokens.filter(function (t) { return !STOPWORDS.has(t); });
  const queryTokens = nonStopTokens.length > 0 ? nonStopTokens : rawTokens;

  let queryVec = null;
  if (searchMode === "semantic" || searchMode === "hybrid") {
    const rawQueryVec = await embedText(cleanQuery);
    queryVec = rawQueryVec instanceof Float32Array ? rawQueryVec : new Float32Array(rawQueryVec);
  }

  const results = [];
  for (const entry of entries) {
    if (opts.coreOnly && !entry.core) {
      continue;
    }
    if (effectiveFilter && !matchesProjectScope(entry.project, effectiveFilter, includeGlobal)) {
      continue;
    }

    let semanticScore = 0;
    if (queryVec && (entry._vec || Array.isArray(entry.vector))) {
      semanticScore = dotProduct(queryVec, entry._vec || entry.vector);
    }

    const lexicalScore = computeLexicalScore(entry, cleanQuery, queryTokens, stats);
    const entryProj = normalizeProjectScope(entry.project);
    const isBoostedProject = entryProj !== "global" && boostTargets.some(function (t) {
      return projectSlugsEquivalent(entryProj, normalizeProjectScope(t));
    });
    const projectBoost = isBoostedProject ? 0.08 : 0;

    const score = searchMode === "grep"
      ? lexicalScore
      : (searchMode === "semantic" ? semanticScore + projectBoost : semanticScore + lexicalScore + projectBoost);

    if (searchMode === "grep" && lexicalScore === 0) continue;
    results.push({ score: score, semanticScore: semanticScore, lexicalScore: lexicalScore, entry: entry });
  }

  results.sort(function (a, b) { return b.score - a.score; });
  return results.slice(0, limit);
}

function nextTopicId(topicText, topicSlug) {
  const normalized = String(topicText || "").replace(/\r\n/g, "\n");
  const re = /- id:\s*([a-z0-9-]+?)-(\d+)\s*$/gm;
  const existingIds = new Set();
  let maxNum = 0;
  let detectedPrefix = topicSlug;
  let m;
  while ((m = re.exec(normalized)) !== null) {
    existingIds.add(m[1] + "-" + m[2]);
    const n = parseInt(m[2], 10);
    if (n > maxNum) {
      maxNum = n;
      detectedPrefix = m[1];
    }
  }
  let nextNum = maxNum + 1;
  let candidate = detectedPrefix + "-" + String(nextNum).padStart(3, "0");
  while (existingIds.has(candidate)) {
    nextNum++;
    candidate = detectedPrefix + "-" + String(nextNum).padStart(3, "0");
  }
  return candidate;
}

function removeTopicBlockFromFile(filePath, targetId) {
  if (!fs.existsSync(filePath)) return null;
  const raw = fs.readFileSync(filePath, "utf8").replace(/\r\n/g, "\n");
  const lines = raw.split("\n");
  const out = [];
  let removedBlock = null;
  let i = 0;

  while (i < lines.length) {
    const m = lines[i].match(/^- id:\s*(\S+)\s*$/);
    if (m && m[1].trim() === targetId) {
      const blockLines = [lines[i]];
      i++;
      while (i < lines.length && (/^\s+[a-zA-Z0-9_-]+:/.test(lines[i]) || lines[i].trim() === "")) {
        if (lines[i].trim() === "" && i + 1 < lines.length && !/^\s+[a-zA-Z0-9_-]+:/.test(lines[i + 1])) {
          i++;
          break;
        }
        blockLines.push(lines[i]);
        i++;
      }
      removedBlock = blockLines.join("\n").trim();
      continue;
    }
    out.push(lines[i]);
    i++;
  }

  if (removedBlock !== null) {
    const cleaned = out.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
    fs.writeFileSync(filePath, cleaned, "utf8");
    parsedFileCache.delete(filePath);
  }
  return removedBlock;
}

async function deleteMemoryEntry(rootDir, idInput) {
  if (activeSyncPromise) {
    try {
      await activeSyncPromise;
    } catch {
      // Ignore background sync error
    }
  }
  const rawIds = Array.isArray(idInput)
    ? idInput
    : String(idInput || "").split(",");
  const targetIds = rawIds
    .map(function (s) { return String(s || "").replace(/[\[\]]+/g, "").trim(); })
    .filter(Boolean);

  if (targetIds.length === 0) {
    return { deleted: [], notFound: [], total: loadCachedVectors(rootDir).length };
  }

  const topicDir = path.join(rootDir, "topics");
  const sessionDir = path.join(rootDir, "sessions");
  const prevEntries = loadCachedVectors(rootDir);
  const deleted = [];
  const notFound = [];
  const removedSet = new Set();

  for (const targetId of targetIds) {
    let foundFile = "";
    if (fs.existsSync(topicDir)) {
      const files = fs.readdirSync(topicDir).filter(function (f) { return f.endsWith(".md"); });
      for (const file of files) {
        const fullPath = path.join(topicDir, file);
        const removed = removeTopicBlockFromFile(fullPath, targetId);
        if (removed !== null) {
          foundFile = "topics/" + file;
          break;
        }
      }
    }
    if (!foundFile && targetId.startsWith("session:") && fs.existsSync(sessionDir)) {
      const base = targetId.slice("session:".length) + ".md";
      const fullPath = path.join(sessionDir, base);
      if (fs.existsSync(fullPath)) {
        fs.unlinkSync(fullPath);
        parsedFileCache.delete(fullPath);
        foundFile = "sessions/" + base;
      }
    }
    const matchedEntry = prevEntries.find(function (e) { return e.id === targetId; });
    if (foundFile || matchedEntry) {
      removedSet.add(targetId);
      deleted.push({
        id: targetId,
        file: foundFile || (matchedEntry ? matchedEntry.file : "")
      });
    } else {
      notFound.push(targetId);
    }
  }

  const vecFile = path.join(rootDir, "vectors.json");
  const nextEntries = prevEntries.filter(function (e) { return !removedSet.has(e.id); });

  if (removedSet.size > 0 && (nextEntries.length !== prevEntries.length || fs.existsSync(vecFile))) {
    writeVectorsAtomic(vecFile, serializeVectorsJson(nextEntries));
  }
  cachedEntries = nextEntries;
  cachedCorpusStats = buildCorpusStats(nextEntries);
  cachedRootDir = path.resolve(rootDir);
  cachedMtime = fs.existsSync(vecFile) ? fs.statSync(vecFile).mtimeMs : Date.now();
  cachedVersion++;

  return {
    deleted: deleted,
    notFound: notFound,
    total: nextEntries.length
  };
}

async function storeMemoryFact(rootDir, input) {
  if (activeSyncPromise) {
    try {
      await activeSyncPromise;
    } catch {
      // Ignore background sync error
    }
  }
  ensureMemoryLayout(rootDir);
  const rawTopic = String(input.topic || "decisions").toLowerCase().replace(/[^a-z0-9-_]/g, "-");
  const topicDir = path.join(rootDir, "topics");
  const topicFile = path.join(topicDir, rawTopic + ".md");
  const indexFile = path.join(rootDir, "memory.md");

  const rawId = input.id
    ? String(input.id).replace(/[\[\]]+/g, "").replace(/[\r\n\s]+/g, "-").replace(/-+/g, "-").replace(/^-+|-+$/g, "")
    : "";
  const supersedesList = input.supersedes
    ? (Array.isArray(input.supersedes) ? input.supersedes : String(input.supersedes).split(","))
        .map(function (s) { return String(s || "").replace(/[\[\]]+/g, "").replace(/[\r\n\s]+/g, "-").replace(/-+/g, "-").replace(/^-+|-+$/g, ""); })
        .filter(Boolean)
    : [];

  let wasUpdated = false;
  const supersededIds = [];
  const idsToRemove = new Set([rawId].concat(supersedesList).filter(Boolean));
  if (idsToRemove.size > 0 && fs.existsSync(topicDir)) {
    const files = fs.readdirSync(topicDir).filter(function (f) { return f.endsWith(".md"); });
    for (const file of files) {
      const fullPath = path.join(topicDir, file);
      for (const targetId of idsToRemove) {
        const removed = removeTopicBlockFromFile(fullPath, targetId);
        if (removed !== null) {
          if (targetId === rawId) {
            wasUpdated = true;
          } else if (!supersededIds.includes(targetId)) {
            supersededIds.push(targetId);
          }
        }
      }
    }
  }

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

  const id = rawId || nextTopicId(existingText, rawTopic);
  const today = new Date().toISOString().split("T")[0];
  const rawTags = Array.isArray(input.tags)
    ? input.tags.map(function (t) { return String(t).trim(); }).filter(Boolean).join(", ")
    : String(input.tags || rawTopic).trim();
  const tagsList = rawTags.replace(/[\[\]]+/g, "").replace(/[\r\n\s]+/g, " ").trim() || rawTopic;
  const cleanFact = String(input.fact || "").replace(/\s+/g, " ").trim();
  const projectScope = normalizeProjectScope(input.project);
  const isCore = input.core === true || /(?:^|,)\s*core\s*(?:,|$)/i.test(tagsList);

  const blockLines = [
    "",
    "- id: " + id,
    "  date: " + today,
    "  tags: [" + tagsList + "]"
  ];
  if (projectScope !== "global") {
    blockLines.push("  project: " + projectScope);
  }
  if (isCore) {
    blockLines.push("  core: true");
  }
  blockLines.push("  fact: " + cleanFact, "");

  fs.writeFileSync(topicFile, existingText.trimEnd() + "\n" + blockLines.join("\n"), "utf8");
  parsedFileCache.delete(topicFile);

  const vec = await embedText(cleanFact + " " + tagsList);
  const vecFile = path.join(rootDir, "vectors.json");
  const removeVecIds = new Set([id].concat(supersedesList));
  const entries = loadCachedVectors(rootDir).filter(function (e) {
    return !removeVecIds.has(e.id);
  });
  const newEntry = {
    id: id,
    date: today,
    file: "topics/" + rawTopic + ".md",
    tags: tagsList,
    fact: cleanFact,
    vector: vec
  };
  if (projectScope !== "global") newEntry.project = projectScope;
  if (isCore) newEntry.core = true;
  prepareEntryCacheFields(newEntry);
  serializeEntryLine(newEntry);
  entries.push(newEntry);
  writeVectorsAtomic(vecFile, serializeVectorsJson(entries));
  cachedEntries = entries;
  cachedCorpusStats = buildCorpusStats(entries);
  cachedRootDir = path.resolve(rootDir);
  cachedMtime = fs.statSync(vecFile).mtimeMs;
  cachedVersion++;
  cachedTopicSlugs = null;
  cachedTopicsRootDir = "";

  return Object.assign({}, newEntry, {
    project: projectScope,
    core: isCore,
    updated: wasUpdated,
    superseded: supersededIds
  });
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

function resolveDbPath(customPath) {
  if (customPath) {
    const resolved = customPath.startsWith("~")
      ? path.join(os.homedir(), customPath.slice(1))
      : path.resolve(customPath);
    if (fs.existsSync(resolved)) return resolved;
  }
  if (process.env.OPENCODE_DB_PATH && fs.existsSync(process.env.OPENCODE_DB_PATH)) {
    return path.resolve(process.env.OPENCODE_DB_PATH);
  }
  const home = os.homedir();
  const candidates = [];
  if (process.env.XDG_DATA_HOME) {
    candidates.push(path.join(process.env.XDG_DATA_HOME, cliName, cliName + ".db"));
  }
  candidates.push(path.join(home, ".local", "share", cliName, cliName + ".db"));
  if (process.env.LOCALAPPDATA) {
    candidates.push(path.join(process.env.LOCALAPPDATA, cliName, cliName + ".db"));
  }
  for (const cand of candidates) {
    if (fs.existsSync(cand)) return cand;
  }
  return candidates[0];
}

async function openReadOnlySqlite(dbPath) {
  const isBun = typeof globalThis.Bun !== "undefined";
  async function openBun() {
    const mod = await import("bun:sqlite");
    let db;
    try {
      db = new mod.Database(dbPath, { readonly: true });
    } catch {
      db = new mod.Database(dbPath);
    }
    return {
      all: function (sql) {
        const params = Array.prototype.slice.call(arguments, 1);
        return db.query(sql).all.apply(db.query(sql), params);
      },
      close: function () { db.close(); }
    };
  }
  async function openNode() {
    const mod = await import("node:sqlite");
    let db;
    try {
      db = new mod.DatabaseSync(dbPath, { readOnly: true });
    } catch {
      db = new mod.DatabaseSync(dbPath);
    }
    return {
      all: function (sql) {
        const params = Array.prototype.slice.call(arguments, 1);
        return db.prepare(sql).all.apply(db.prepare(sql), params);
      },
      close: function () { db.close(); }
    };
  }
  if (isBun) {
    try {
      return await openBun();
    } catch {
      return await openNode();
    }
  }
  try {
    return await openNode();
  } catch {
    return await openBun();
  }
}

function classifyRuleTopic(heading, text) {
  const h = String(heading || "").toLowerCase();
  const t = String(text || "").toLowerCase();
  if (/(environment|url|xampp|apache|localhost|port|path|workspace|server|database|sqlite|directory|folder)/i.test(h)) {
    return "environment";
  }
  if (/(style|format|output|code|css|js|javascript|html|php|python|sql|naming|indent|comment|preference)/i.test(h)) {
    return "preferences";
  }
  if (/(mentor|persona|confirm|delete|deletion|boundary|shell|accuracy|outbound|untrusted|protocol|behavior|backup|screenshot|verify|playwright)/i.test(h)) {
    return "agent-behavior";
  }
  if (/(decision|architecture|schema|stack|plugin)/i.test(h)) {
    return "decisions";
  }
  if (/\b(never|always|must not|do not|ask first|before editing)\b/i.test(t)) {
    return "agent-behavior";
  }
  if (/\b(localhost|http:\/\/|c:\\|\/users\/|port \d+|xampp|apache)\b/i.test(t)) {
    return "environment";
  }
  return "preferences";
}

function parseAgentsMarkdownRules(filePath, projectScope, visited) {
  const seenFiles = visited || new Set();
  if (!filePath || !fs.existsSync(filePath)) return [];
  const resolved = path.resolve(filePath);
  if (seenFiles.has(resolved)) return [];
  seenFiles.add(resolved);

  const raw = fs.readFileSync(resolved, "utf8").replace(/\r\n/g, "\n");
  const lines = raw.split("\n");
  const rules = [];

  for (const line of lines) {
    const importMatch = line.trim().match(/^@([a-zA-Z]:[^\s]+|~\/[^\s]+|\/[^\s]+)$/);
    if (importMatch) {
      const targetRaw = importMatch[1];
      const targetPath = targetRaw.startsWith("~")
        ? path.join(os.homedir(), targetRaw.slice(1))
        : path.resolve(path.dirname(resolved), targetRaw);
      if (fs.existsSync(targetPath)) {
        const imported = parseAgentsMarkdownRules(targetPath, projectScope, seenFiles);
        for (const r of imported) rules.push(r);
      }
    }
  }

  let currentHeading = "";
  let currentSubHeading = "";
  let inCodeBlock = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (trimmed.startsWith("```")) {
      inCodeBlock = !inCodeBlock;
      continue;
    }
    if (inCodeBlock) continue;

    const h2 = trimmed.match(/^##\s+(.+)$/);
    if (h2) {
      currentHeading = h2[1].replace(/[*_`]/g, "").trim();
      currentSubHeading = "";
      continue;
    }
    const h3 = trimmed.match(/^###\s+(.+)$/);
    if (h3) {
      currentSubHeading = h3[1].replace(/[*_`]/g, "").trim();
      continue;
    }
    const boldHeader = trimmed.match(/^\*\*([^*]+?)(?::)?\*\*\s*$/);
    if (boldHeader) {
      currentSubHeading = boldHeader[1].trim();
      continue;
    }

    const bullet = line.match(/^\s*[-*]\s+(.+)$/);
    if (!bullet) continue;
    let body = bullet[1].trim();
    while (i + 1 < lines.length && /^\s{2,}[^-*\s]/.test(lines[i + 1]) && !lines[i + 1].trim().startsWith("```")) {
      i++;
      body += " " + lines[i].trim();
    }

    const cleanBody = body.replace(/\s+/g, " ").trim();
    if (cleanBody.length < 24 || cleanBody.length > 550) continue;
    if (/^`topics\/|^`sessions\//.test(cleanBody)) continue;

    let leadLabel = "";
    const leadMatch = cleanBody.match(/^\*\*([^*]{2,40}?)\*\*[:\s-]*(.+)$/);
    let factText = cleanBody;
    if (leadMatch) {
      leadLabel = leadMatch[1].replace(/:$/, "").trim();
      factText = (leadLabel + ": " + leadMatch[2].trim()).replace(/\*\*/g, "");
    } else {
      factText = cleanBody.replace(/\*\*/g, "");
    }

    const sectionContext = [currentHeading, currentSubHeading].filter(Boolean).join(" / ");
    const topic = classifyRuleTopic(sectionContext + " " + leadLabel, factText);
    const tagTokens = tokenizeText(sectionContext + " " + leadLabel)
      .filter(function (t) { return !STOPWORDS.has(t) && t.length >= 3; })
      .slice(0, 5);
    if (tagTokens.indexOf("imported") === -1) tagTokens.push("imported");
    const tags = Array.from(new Set(tagTokens)).join(", ") || topic;

    const fullFact = currentSubHeading && !factText.toLowerCase().startsWith(currentSubHeading.toLowerCase())
      ? currentSubHeading + ": " + factText
      : factText;

    rules.push({
      topic: topic,
      tags: tags,
      fact: fullFact,
      project: projectScope || "global",
      sourceFile: resolved
    });
  }

  return rules;
}

function appendTopicFactBatch(rootDir, items) {
  if (!Array.isArray(items) || items.length === 0) return { added: [], skipped: 0 };
  ensureMemoryLayout(rootDir);
  const existing = parseTopicEntries(rootDir);
  const existingFacts = new Set(
    existing.map(function (e) {
      return String(e.fact || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    })
  );

  const byTopic = new Map();
  let skipped = 0;
  for (const item of items) {
    const cleanFact = String(item.fact || "").replace(/\s+/g, " ").trim();
    const normFact = cleanFact.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    if (!normFact || existingFacts.has(normFact)) {
      skipped++;
      continue;
    }
    existingFacts.add(normFact);
    const rawTopic = String(item.topic || "preferences").toLowerCase().replace(/[^a-z0-9-_]/g, "-");
    if (!byTopic.has(rawTopic)) byTopic.set(rawTopic, []);
    byTopic.get(rawTopic).push(Object.assign({}, item, { topic: rawTopic, fact: cleanFact }));
  }

  const topicDir = path.join(rootDir, "topics");
  const indexFile = path.join(rootDir, "memory.md");
  const today = new Date().toISOString().split("T")[0];
  const added = [];

  for (const [rawTopic, list] of byTopic.entries()) {
    const topicFile = path.join(topicDir, rawTopic + ".md");
    let text = "";
    if (fs.existsSync(topicFile)) {
      text = fs.readFileSync(topicFile, "utf8");
    } else {
      text = "# " + rawTopic.charAt(0).toUpperCase() + rawTopic.slice(1) + "\n";
      if (fs.existsSync(indexFile)) {
        const idxContent = fs.readFileSync(indexFile, "utf8");
        if (!idxContent.includes("topics/" + rawTopic + ".md")) {
          fs.writeFileSync(indexFile, idxContent.trimEnd() + "\n- `topics/" + rawTopic + ".md` - " + rawTopic + " entries\n", "utf8");
        }
      }
    }

    for (const item of list) {
      const id = nextTopicId(text, rawTopic);
      const tagsList = String(item.tags || rawTopic).replace(/[\[\]]+/g, "").replace(/[\r\n\s]+/g, " ").trim() || rawTopic;
      const proj = normalizeProjectScope(item.project);
      const blockLines = [
        "",
        "- id: " + id,
        "  date: " + (item.date || today),
        "  tags: [" + tagsList + "]"
      ];
      if (proj !== "global") blockLines.push("  project: " + proj);
      if (item.core) blockLines.push("  core: true");
      blockLines.push("  fact: " + item.fact, "");
      text = text.trimEnd() + "\n" + blockLines.join("\n");
      added.push({ id: id, topic: rawTopic, file: "topics/" + rawTopic + ".md", fact: item.fact, project: proj });
    }

    fs.writeFileSync(topicFile, text, "utf8");
    parsedFileCache.delete(topicFile);
  }

  cachedTopicSlugs = null;
  cachedTopicsRootDir = "";
  return { added: added, skipped: skipped };
}

function getImportedSessionIds(rootDir) {
  const sessionDir = path.join(rootDir, "sessions");
  const importedIds = new Set();
  if (!fs.existsSync(sessionDir)) return importedIds;
  const files = fs.readdirSync(sessionDir).filter(function (f) { return f.endsWith(".md") && f.toLowerCase() !== "readme.md"; });
  for (const file of files) {
    try {
      const raw = fs.readFileSync(path.join(sessionDir, file), "utf8");
      const m = raw.match(/^\*\*Session ID\*\*:\s*(\S+)\s*$/m);
      if (m && m[1]) importedIds.add(m[1].trim());
    } catch {
      // ignore unreadable file
    }
  }
  return importedIds;
}

function writeImportedSessionFile(rootDir, sessionData) {
  ensureMemoryLayout(rootDir);
  const sessionDir = path.join(rootDir, "sessions");
  const dateStr = sessionData.date || new Date().toISOString().split("T")[0];
  const rawSlug = String(sessionData.slug || sessionData.title || "session")
    .toLowerCase()
    .replace(/[^a-z0-9\s-_]/g, "")
    .trim()
    .split(/[\s-_]+/)
    .filter(function (w) { return w && !STOPWORDS.has(w); })
    .slice(0, 4)
    .join("-") || "session";
  const prefix = dateStr + "_" + rawSlug + "-";

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

  const md = [
    "# " + String(sessionData.title || rawSlug).trim(),
    "",
    "**Date**: " + dateStr,
    "**Checkpoint**: " + numStr,
    "**Context**: imported from opencode.db",
    "**Project**: " + (sessionData.project || "global"),
    "**Session ID**: " + sessionData.sessionId,
    "",
    sessionData.summary,
    ""
  ].join("\n");

  fs.writeFileSync(filepath, md, "utf8");
  parsedFileCache.delete(filepath);
  return { filename: filename, filepath: filepath, sessionId: sessionData.sessionId };
}

async function importFromOpenCodeDb(rootDir, options) {
  const opts = options || {};
  const dbPath = resolveDbPath(opts.dbPath);
  const maxSessions = Number(opts.limit) || 40;
  if (!dbPath || !fs.existsSync(dbPath)) {
    return { dbPath: dbPath || "", imported: [], skipped: 0 };
  }

  const existingSessionIds = getImportedSessionIds(rootDir);
  let db;
  try {
    db = await openReadOnlySqlite(dbPath);
  } catch {
    return { dbPath: dbPath, imported: [], skipped: 0 };
  }

  const imported = [];
  let skipped = 0;

  try {
    const tables = new Set(
      db.all("SELECT name FROM sqlite_master WHERE type = 'table'").map(function (r) { return String(r.name || ""); })
    );

    const candidates = [];

    if (tables.has("session_v2") && tables.has("session_message")) {
      const v2Cols = new Set(
        db.all("PRAGMA table_info(session_v2)").map(function (c) { return String(c.name || ""); })
      );
      const dirExpr = v2Cols.has("directory")
        ? "directory"
        : (v2Cols.has("workspace_directory") ? "COALESCE(workspace_directory, root_directory, '')" : "''");
      const whereClause = v2Cols.has("time_archived") ? "WHERE time_archived IS NULL" : "";
      const rows = db.all(
        "SELECT id, title, " + dirExpr + " AS directory, time_created, time_updated FROM session_v2 " +
        whereClause + " ORDER BY time_updated DESC LIMIT " + Math.max(100, maxSessions * 3)
      );

      for (const row of rows) {
        const sid = String(row.id || "");
        if (!sid) continue;
        if (existingSessionIds.has(sid)) {
          skipped++;
          continue;
        }
        const msgs = db.all(
          "SELECT type, time_created, data FROM session_message WHERE session_id = ? ORDER BY time_created ASC LIMIT 120",
          sid
        );
        if (!msgs || msgs.length < 2) continue;

        let firstUser = "";
        let lastUser = "";
        let lastAssistant = "";
        const compressSummaries = [];

        for (const m of msgs) {
          let parsed;
          try {
            parsed = JSON.parse(String(m.data || ""));
          } catch {
            continue;
          }
          const t = String(m.type || parsed.type || "");
          if (t === "user" && typeof parsed.text === "string" && parsed.text.trim()) {
            const txt = parsed.text.trim();
            if (!firstUser) firstUser = txt;
            lastUser = txt;
          } else if (t === "assistant" && Array.isArray(parsed.content)) {
            for (const part of parsed.content) {
              if (!part || typeof part !== "object") continue;
              if (part.type === "text" && typeof part.text === "string" && part.text.trim()) {
                lastAssistant = part.text.trim();
              } else if (part.type === "tool" && part.name === "compress" && part.state && part.state.input) {
                const inp = part.state.input;
                if (Array.isArray(inp.content)) {
                  for (const c of inp.content) {
                    if (c && typeof c.summary === "string" && c.summary.trim()) {
                      compressSummaries.push(c.summary.trim());
                    }
                  }
                }
              }
            }
          } else if ((t === "compaction" || t === "summary") && typeof parsed.text === "string" && parsed.text.trim()) {
            compressSummaries.push(parsed.text.trim());
          }
        }

        if (!compressSummaries.length && (!firstUser || !lastAssistant || (firstUser.length + lastAssistant.length) < 120)) {
          continue;
        }
        const rawTitle = String(row.title || "").trim();
        const isGenericTitle = !rawTitle || /^(\(untitled|new session|greeting|hi|hello|test)/i.test(rawTitle);
        if (isGenericTitle && !compressSummaries.length && msgs.length < 4) {
          continue;
        }

        const ts = Number(row.time_updated || row.time_created || Date.now());
        const dateStr = new Date(ts > 1e11 ? ts : ts * 1000).toISOString().split("T")[0];
        const title = (!isGenericTitle ? rawTitle : firstUser.split("\n")[0].slice(0, 72)).trim() || "Imported Session";
        const bodyParts = [];
        if (compressSummaries.length > 0) {
          bodyParts.push("## What was built/fixed/decided\n\n" + compressSummaries.join("\n\n").slice(0, 1800));
        } else {
          bodyParts.push("## What was built/fixed/decided\n\n" + firstUser.replace(/\s+/g, " ").slice(0, 500));
        }
        if (lastAssistant) {
          bodyParts.push("## Outcome\n\n" + lastAssistant.replace(/\s+/g, " ").slice(0, 900));
        }
        if (lastUser && lastUser !== firstUser) {
          bodyParts.push("## Key decisions\n\nFollow-up focus: " + lastUser.replace(/\s+/g, " ").slice(0, 350));
        }

        candidates.push({
          sessionId: sid,
          title: title,
          date: dateStr,
          project: row.directory ? normalizeProjectScope(String(row.directory)) : "global",
          summary: bodyParts.join("\n\n"),
          hasCompaction: compressSummaries.length > 0
        });
        if (candidates.length >= maxSessions) break;
      }
    }

    if (candidates.length < maxSessions && tables.has("session") && tables.has("message") && tables.has("part")) {
      const v1Rows = db.all(
        "SELECT id, title, directory, time_created, time_updated FROM session ORDER BY time_updated DESC LIMIT " +
        Math.max(100, maxSessions * 3)
      );
      for (const row of v1Rows) {
        const sid = String(row.id || "");
        if (!sid) continue;
        if (existingSessionIds.has(sid) || candidates.some(function (c) { return c.sessionId === sid; })) {
          skipped++;
          continue;
        }
        const parts = db.all(
          "SELECT p.data AS part_data, json_extract(m.data, '$.role') AS role FROM part p JOIN message m ON m.id = p.message_id WHERE p.session_id = ? ORDER BY p.time_created ASC LIMIT 120",
          sid
        );
        if (!parts || parts.length < 2) continue;

        let firstUser = "";
        let lastAssistant = "";
        const compressSummaries = [];
        for (const p of parts) {
          let parsed;
          try {
            parsed = JSON.parse(String(p.part_data || ""));
          } catch {
            continue;
          }
          if (parsed.type === "text" && typeof parsed.text === "string" && parsed.text.trim()) {
            if (p.role === "user") {
              if (!firstUser) firstUser = parsed.text.trim();
            } else {
              lastAssistant = parsed.text.trim();
            }
          } else if ((parsed.type === "compaction" || parsed.type === "summary") && typeof parsed.text === "string") {
            compressSummaries.push(parsed.text.trim());
          }
        }

        if (!compressSummaries.length && (!firstUser || !lastAssistant || (firstUser.length + lastAssistant.length) < 120)) {
          continue;
        }
        const ts = Number(row.time_updated || row.time_created || Date.now());
        const dateStr = new Date(ts > 1e11 ? ts : ts * 1000).toISOString().split("T")[0];
        const rawTitle = String(row.title || "").trim();
        const title = (rawTitle && !/^(\(untitled|new session)/i.test(rawTitle) ? rawTitle : firstUser.split("\n")[0].slice(0, 72)).trim() || "Imported Session";
        const bodyParts = [
          "## What was built/fixed/decided\n\n" + (compressSummaries.length > 0 ? compressSummaries.join("\n\n").slice(0, 1800) : firstUser.replace(/\s+/g, " ").slice(0, 500))
        ];
        if (lastAssistant) {
          bodyParts.push("## Outcome\n\n" + lastAssistant.replace(/\s+/g, " ").slice(0, 900));
        }

        candidates.push({
          sessionId: sid,
          title: title,
          date: dateStr,
          project: row.directory ? normalizeProjectScope(String(row.directory)) : "global",
          summary: bodyParts.join("\n\n"),
          hasCompaction: compressSummaries.length > 0
        });
        if (candidates.length >= maxSessions) break;
      }
    }

    for (const cand of candidates.slice(0, maxSessions)) {
      const saved = writeImportedSessionFile(rootDir, cand);
      existingSessionIds.add(cand.sessionId);
      imported.push(saved);
    }
  } finally {
    try {
      db.close();
    } catch {
      // ignore close error
    }
  }

  return { dbPath: dbPath, imported: imported, skipped: skipped };
}

async function importExistingMemory(rootDir, options) {
  const opts = options || {};
  ensureMemoryLayout(rootDir);

  const candidateAgentsFiles = [];
  if (Array.isArray(opts.agentsFiles) && opts.agentsFiles.length > 0) {
    for (const f of opts.agentsFiles) {
      if (f) candidateAgentsFiles.push({ path: f, project: opts.project || "global" });
    }
  } else if (typeof opts.agentsFiles === "string" && opts.agentsFiles.trim()) {
    candidateAgentsFiles.push({ path: opts.agentsFiles.trim(), project: opts.project || "global" });
  } else if (opts.includeAgents !== false) {
    const home = os.homedir();
    const configDir = resolveConfigDir(opts.configDir);
    candidateAgentsFiles.push({ path: path.join(configDir, "AGENTS.md"), project: "global" });
    candidateAgentsFiles.push({ path: path.join(home, ".claude", "CLAUDE.md"), project: "global" });
    const projDir = opts.projectDir || process.cwd();
    if (projDir) {
      const projAgents = path.join(path.resolve(projDir), "AGENTS.md");
      const projScope = isUmbrellaProject(projDir) ? "global" : normalizeProjectScope(projDir);
      candidateAgentsFiles.push({ path: projAgents, project: projScope });
    }
  }

  const visitedFiles = new Set();
  const parsedRules = [];
  const agentsSources = [];
  for (const item of candidateAgentsFiles) {
    const resolved = item.path.startsWith("~")
      ? path.join(os.homedir(), item.path.slice(1))
      : path.resolve(item.path);
    if (!fs.existsSync(resolved)) continue;
    const beforeCount = parsedRules.length;
    const extracted = parseAgentsMarkdownRules(resolved, item.project, visitedFiles);
    for (const r of extracted) parsedRules.push(r);
    if (parsedRules.length > beforeCount) {
      agentsSources.push(resolved);
    }
  }

  const factsResult = appendTopicFactBatch(rootDir, parsedRules);
  const sessionsResult = opts.includeSessions === false
    ? { dbPath: "", imported: [], skipped: 0 }
    : await importFromOpenCodeDb(rootDir, { dbPath: opts.dbPath, limit: opts.limit });

  const syncResult = opts.skipSync
    ? { total: 0, embedded: 0, reused: 0, vecFile: path.join(rootDir, "vectors.json") }
    : await syncVectors(rootDir);

  return {
    importedFacts: factsResult.added,
    skippedFacts: factsResult.skipped,
    importedSessions: sessionsResult.imported,
    skippedSessions: sessionsResult.skipped,
    agentsSources: agentsSources,
    dbPath: sessionsResult.dbPath,
    syncResult: syncResult
  };
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
      const defaultProject = (ctx && ctx.location && ctx.location.directory)
        ? ctx.location.directory
        : (options.project || "global");

      loadCachedVectors(rootDir);
      syncVectors(rootDir).catch(function (err) {
        console.error("local-memory sync error:", err);
      });

      const registrations = [];

      if (ctx && ctx.tool && typeof ctx.tool.transform === "function") {
        const toolReg = await ctx.tool.transform(function (editor) {
          editor.add({
            name: "memory_store",
            description: "Atomically store or update a persistent memory fact in a topic file and update semantic vectors immediately. Supports in-place updates via id, superseding outdated facts via supersedes, project scoping, and core pinning.",
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
                  description: "Optional explicit ID (auto-generated as <topic>-<nnn> when omitted; updates in place if ID already exists)"
                },
                supersedes: {
                  type: "string",
                  description: "Optional ID (or comma-separated IDs) of outdated memory entries to delete when storing this replacement"
                },
                project: {
                  type: "string",
                  description: "Optional project scope slug/path or 'global' (default: 'global')"
                },
                core: {
                  type: "boolean",
                  description: "Optional flag to pin this fact as a core memory injected on every turn regardless of prompt query"
                }
              },
              required: ["topic", "tags", "fact"],
              additionalProperties: false
            },
            execute: async function (input) {
              const saved = await storeMemoryFact(rootDir, input);
              const verb = saved.updated ? "Updated" : "Stored";
              const extra = [];
              if (saved.project && saved.project !== "global") extra.push("project=" + saved.project);
              if (saved.core) extra.push("core=true");
              if (saved.superseded && saved.superseded.length > 0) extra.push("superseded: " + saved.superseded.join(", "));
              const suffix = extra.length > 0 ? " (" + extra.join(", ") + ")" : "";
              return {
                content: verb + " [" + saved.id + "] in " + saved.file + suffix + " and updated vectors.json:\n" + saved.fact
              };
            }
          });

          editor.add({
            name: "memory_delete",
            description: "Delete one or more outdated or incorrect memory entries by ID from their Markdown source files (topics/*.md or sessions/*.md) and vectors.json.",
            input: {
              type: "object",
              properties: {
                id: {
                  type: "string",
                  description: "Memory entry ID to delete (or comma-separated IDs, e.g. 'env-007' or 'env-007, dec-002')"
                }
              },
              required: ["id"],
              additionalProperties: false
            },
            execute: async function (input) {
              const res = await deleteMemoryEntry(rootDir, input.id);
              if (res.deleted.length === 0) {
                return {
                  content: "No matching memory entry found for ID: " + res.notFound.join(", ")
                };
              }
              const summary = res.deleted.map(function (d) {
                return "[" + d.id + "] from " + d.file;
              }).join(", ");
              const missing = res.notFound.length > 0 ? " (not found: " + res.notFound.join(", ") + ")" : "";
              return {
                content: "Deleted " + summary + " and updated vectors.json" + missing + "."
              };
            }
          });

          editor.add({
            name: "memory_search",
            description: "Search persistent local memory (both atomic topic facts and session checkpoint summaries) using hybrid semantic + BM25 keyword matching.",
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
                },
                project: {
                  type: "string",
                  description: "Optional project scope filter ('all' for all projects, 'global' for global only, or a project name/path)"
                },
                coreOnly: {
                  type: "boolean",
                  description: "When true, only return pinned core memories"
                }
              },
              required: ["query"],
              additionalProperties: false
            },
            execute: async function (input) {
              const hits = await searchMemory(rootDir, input.query, input.mode || "hybrid", input.topN || 8, {
                project: input.project || "all",
                coreOnly: Boolean(input.coreOnly)
              });
              if (hits.length === 0) {
                return { content: "No matching memory entries found." };
              }
              const formatted = hits.map(function (h) {
                const badges = [];
                if (h.entry.core) badges.push("core");
                if (h.entry.project && h.entry.project !== "global") badges.push("project:" + h.entry.project);
                const badgeStr = badges.length > 0 ? " [" + badges.join(",") + "]" : "";
                return h.score.toFixed(3) + "  [" + h.entry.id + "]" + badgeStr + " " + h.entry.fact + "  (" + h.entry.file + ")";
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
          const activeProject = (event && event.directory) || defaultProject || "global";
          const userText = extractLastUserText(event.messages);
          const ctxKey = String(userText || "").trim() + "::" + normalizeProjectScope(activeProject) + "::" + cachedVersion;
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
            "AUTOMATIC STORAGE (via `memory_store` / `memory_delete` tools — no prompting needed):",
            "Call `memory_store` immediately in the SAME turn before your final response whenever any of these happen:",
            "- User states a preference, convention, or 'always/never do X' rule",
            "- An architecture, workflow, or design decision is made (yours or theirs)",
            "- A non-obvious environment, path, port, or tooling fact is discovered",
            "- A recurring correction or pattern emerges",
            "- The user has to correct you or repeat an instruction (store it so it never needs repeating)",
            "- When replacing an outdated fact, pass `id` to update in-place or `supersedes: '<old-id>'` (or call `memory_delete`) so stale facts never pollute recall.",
            "Hard gate: before finishing every task, check if any trigger above fired. If it did, call `memory_store` NOW — never promise to remember later. Do NOT store trivial exchanges, transient debugging steps, duplicates, or secrets.",
            "",
            "WHERE TO STORE:",
            "- Global (`memory_store` with default `project: 'global'`): coding style, tooling preferences, agent behavior rules, cross-project decisions, and environment facts that remain true in a new project tomorrow. Pass `core: true` for critical invariants that must be pinned on every turn.",
            "- Project-scoped (`memory_store` with `project: '<repo-or-path>'` or `AGENTS.md` in repo root): project-specific architecture, asset IDs, endpoints, or conventions that only apply to that project.",
            "",
            "AUTOMATIC RECALL & CHECKPOINTS:",
            "- When the user references 'we discussed', 'last time', 'earlier', a settled decision, or when a topic needs deeper lookup than the auto-recalled hits below, call `memory_search` (`mode: 'hybrid' | 'semantic' | 'grep'`).",
            "- Session compactions are checkpointed automatically. At the end of significant work sessions (architecture decisions, hard-won fixes, new patterns), call `memory_checkpoint` with `slug`, `title`, and a distilled `summary`."
          ];

          const coreMemories = getCoreMemories(rootDir, activeProject, userText);
          const coreIds = new Set();
          if (coreMemories.length > 0) {
            lines.push("Pinned core memories:");
            for (const entry of coreMemories) {
              coreIds.add(entry.id);
              lines.push("- [" + entry.id + "] (" + entry.file + "): " + entry.fact);
            }
          }

          if (userText && userText.trim().length >= 5) {
            const hits = await searchMemory(rootDir, userText, "hybrid", topK, { project: activeProject }).catch(function () { return []; });
            const relevant = hits.filter(function (h) {
              return h.score >= minScore && !coreIds.has(h.entry.id);
            });
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
  resolveDbPath,
  ensureMemoryLayout,
  installPlugin,
  importExistingMemory,
  parseAgentsMarkdownRules,
  parseTopicEntries,
  parseSessionEntries,
  nextTopicId,
  getTopicSlugs,
  getCoreMemories,
  isUmbrellaProject,
  normalizeProjectScope,
  getProjectLeaf,
  matchesProjectScope,
  detectProjectsFromText,
  computeLexicalScore,
  loadCachedVectors,
  syncVectors,
  searchMemory,
  storeMemoryFact,
  deleteMemoryEntry,
  storeSessionCheckpoint
};

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isDirectRun) {
  const cmd = process.argv[2] || "sync";
  let customDir = process.env.OPENCODE_MEMORY_DIR || "";
  const dirFlagIdx = process.argv.indexOf("--dir");
  if (dirFlagIdx !== -1 && process.argv[dirFlagIdx + 1]) {
    customDir = process.argv[dirFlagIdx + 1];
  }
  const dbFlagIdx = process.argv.indexOf("--db");
  const customDb = (dbFlagIdx !== -1 && process.argv[dbFlagIdx + 1]) ? process.argv[dbFlagIdx + 1] : undefined;
  const agentsFlagIdx = process.argv.indexOf("--agents");
  const customAgents = (agentsFlagIdx !== -1 && process.argv[agentsFlagIdx + 1]) ? process.argv[agentsFlagIdx + 1] : undefined;
  const limitFlagIdx = process.argv.indexOf("--limit");
  const customLimit = (limitFlagIdx !== -1 && process.argv[limitFlagIdx + 1]) ? parseInt(process.argv[limitFlagIdx + 1], 10) : undefined;
  const withImport = process.argv.includes("--import");
  const rootDir = resolveMemoryDir(customDir || undefined);

  if (cmd === "install" || cmd === "init" || cmd === "setup") {
    installPlugin({
      directory: customDir || undefined,
      importExisting: withImport,
      dbPath: customDb,
      agentsFiles: customAgents,
      limit: customLimit
    }).then(function (res) {
      console.log("opencode-local-memory installed:");
      console.log("  Server config: " + res.serverConfigFile + " (" + res.serverStatus + ")");
      console.log("  TUI config:    " + res.cliConfigFile + " (" + res.cliStatus + ")");
      console.log("  Memory folder: " + res.memoryDir);
      if (res.importResult) {
        console.log(
          "  Imported:      " +
          res.importResult.importedFacts.length + " rules from AGENTS.md, " +
          res.importResult.importedSessions.length + " sessions from opencode.db"
        );
      }
      console.log("  Vectors cache: " + res.syncResult.vecFile + " (" + res.syncResult.total + " entries ready)");
    }).catch(function (err) {
      console.error("Install failed:", err);
      process.exit(1);
    });
  } else if (cmd === "import" || cmd === "backfill") {
    const asJson = process.argv.includes("--json");
    importExistingMemory(rootDir, {
      dbPath: customDb,
      agentsFiles: customAgents,
      limit: customLimit
    }).then(function (res) {
      if (asJson) {
        console.log(JSON.stringify(res));
        return;
      }
      console.log("opencode-local-memory import complete:");
      console.log("  Rules imported:    " + res.importedFacts.length + " (skipped " + res.skippedFacts + " existing)");
      console.log("  Sessions imported: " + res.importedSessions.length + " (skipped " + res.skippedSessions + " existing)");
      console.log("  Vectors cache:     " + res.syncResult.vecFile + " (" + res.syncResult.total + " total entries)");
    }).catch(function (err) {
      console.error("Import failed:", err);
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
  } else if (cmd === "delete" || cmd === "rm") {
    const id = process.argv.slice(3).join(",");
    deleteMemoryEntry(rootDir, id).then(function (res) {
      console.log("Deleted " + res.deleted.length + " entries; remaining: " + res.total);
    }).catch(function (err) {
      console.error("Delete failed:", err);
      process.exit(1);
    });
  }
}
