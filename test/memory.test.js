"use strict";

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  computeLexicalScore,
  deleteMemoryEntry,
  ensureMemoryLayout,
  getCoreMemories,
  getTopicSlugs,
  importExistingMemory,
  installPlugin,
  loadCachedVectors,
  matchesProjectScope,
  nextTopicId,
  parseSessionEntries,
  parseTopicEntries,
  resolveMemoryDir,
  searchMemory,
  server,
  storeMemoryFact,
  storeSessionCheckpoint,
  syncVectors,
} from "../index.js";

function withTempDir(fn) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-local-memory-test-"));
  return Promise.resolve()
    .then(() => fn(tmpDir))
    .finally(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });
}

describe("ensureMemoryLayout & resolveMemoryDir", () => {
  it("creates starter memory.md, topics/*.md, and sessions/README.md on a blank folder", async () => {
    await withTempDir(async (tmpDir) => {
      ensureMemoryLayout(tmpDir);
      assert.ok(fs.existsSync(path.join(tmpDir, "memory.md")));
      assert.ok(fs.existsSync(path.join(tmpDir, "topics", "preferences.md")));
      assert.ok(fs.existsSync(path.join(tmpDir, "topics", "decisions.md")));
      assert.ok(fs.existsSync(path.join(tmpDir, "topics", "environment.md")));
      assert.ok(fs.existsSync(path.join(tmpDir, "topics", "agent-behavior.md")));
      assert.ok(fs.existsSync(path.join(tmpDir, "sessions", "README.md")));

      const slugs = getTopicSlugs(tmpDir);
      assert.ok(slugs.includes("preferences"));
      assert.ok(slugs.includes("decisions"));
    });
  });

  it("resolves explicit custom paths and ~ paths", () => {
    const resolved = resolveMemoryDir("~/my-custom-memory");
    assert.ok(resolved.endsWith(path.join("my-custom-memory")));
  });

  it("installs plugin into opencode.jsonc and cli.json while preserving existing comments", async () => {
    await withTempDir(async (tmpDir) => {
      const cfgDir = path.join(tmpDir, "config");
      const memDir = path.join(tmpDir, "memory");
      fs.mkdirSync(cfgDir, { recursive: true });
      const jsoncPath = path.join(cfgDir, "opencode.jsonc");
      fs.writeFileSync(
        jsoncPath,
        [
          "{",
          "  // Keep this user comment",
          '  "model": "anthropic/claude-sonnet-4-5",',
          '  "plugins": [',
          '    "opencode-local-search"',
          "  ]",
          "}",
          "",
        ].join("\n"),
        "utf8"
      );

      const res = await installPlugin({ configDir: cfgDir, directory: memDir, skipSync: true });
      assert.equal(res.serverStatus, "updated");
      assert.equal(res.cliStatus, "created");

      const updatedJsonc = fs.readFileSync(jsoncPath, "utf8");
      assert.ok(updatedJsonc.includes("// Keep this user comment"));
      assert.ok(updatedJsonc.includes('"opencode-local-search"'));
      assert.ok(updatedJsonc.includes('"@nandoblanco/opencode-local-memory"'));

      const cliJson = fs.readFileSync(path.join(cfgDir, "cli.json"), "utf8");
      assert.ok(cliJson.includes('"@nandoblanco/opencode-local-memory"'));
      assert.ok(fs.existsSync(path.join(memDir, "memory.md")));

      const second = await installPlugin({ configDir: cfgDir, directory: memDir, skipSync: true });
      assert.equal(second.serverStatus, "already-present");
      assert.equal(second.cliStatus, "already-present");
    });
  });
});

describe("nextTopicId", () => {
  it("detects existing short prefixes (e.g. dec-012 -> dec-013) or falls back to topic slug", () => {
    const existingText = [
      "# Decisions",
      "",
      "- id: dec-001",
      "  date: 2026-10-01",
      "  tags: [arch]",
      "  fact: First decision",
      "",
      "- id: dec-012",
      "  date: 2026-10-25",
      "  tags: [arch]",
      "  fact: Twelfth decision",
    ].join("\n");

    assert.equal(nextTopicId(existingText, "decisions"), "dec-013");
    assert.equal(nextTopicId("# New Topic\n", "workflows"), "workflows-001");
  });
});

describe("storeMemoryFact, storeSessionCheckpoint, syncVectors, and searchMemory", () => {
  it("stores topic facts, creates new topic files, indexes vectors, and searches via hybrid/semantic/grep", async () => {
    await withTempDir(async (tmpDir) => {
      const first = await storeMemoryFact(tmpDir, {
        topic: "decisions",
        tags: "sqlite, plugin, zero-token",
        fact: "Use local embeddings in vectors.json so recall uses zero cloud API keys.",
      });
      assert.equal(first.id, "decisions-001");
      assert.equal(first.file, "topics/decisions.md");
      assert.ok(Array.isArray(first.vector));
      assert.equal(first.vector.length, 384);

      const customTopic = await storeMemoryFact(tmpDir, {
        topic: "deployment",
        tags: "apache, xampp, localhost",
        fact: "DocumentRoot maps C:/MAMPFiles directly to http://localhost/.",
      });
      assert.equal(customTopic.id, "deployment-001");
      assert.ok(fs.existsSync(path.join(tmpDir, "topics", "deployment.md")));
      const indexMd = fs.readFileSync(path.join(tmpDir, "memory.md"), "utf8");
      assert.ok(indexMd.includes("topics/deployment.md"));

      const parsedTopics = parseTopicEntries(tmpDir);
      assert.equal(parsedTopics.length, 2);

      const cp = await storeSessionCheckpoint(tmpDir, {
        slug: "release-audit",
        title: "Release Audit Checkpoint",
        project: "/workspace/plugin",
        contextPct: 42,
        summary: "## What was built/fixed/decided\n\nVerified vector sync and hybrid search.\n\n## Outcome\n\nAll tests pass.",
      });
      assert.ok(cp.filename.endsWith("_release-audit-01.md"));

      const parsedSessions = parseSessionEntries(tmpDir);
      assert.equal(parsedSessions.length, 1);
      assert.ok(parsedSessions[0].id.startsWith("session:"));

      const grepHits = await searchMemory(tmpDir, "DocumentRoot", "grep", 5);
      assert.equal(grepHits.length, 1);
      assert.equal(grepHits[0].entry.id, "deployment-001");

      const hybridHits = await searchMemory(tmpDir, "local embeddings vectors.json", "hybrid", 5);
      assert.ok(hybridHits.length >= 1);
      assert.equal(hybridHits[0].entry.id, "decisions-001");

      const cached = loadCachedVectors(tmpDir);
      assert.equal(cached.length, 3);
    });
  });

  it("registers tools and injects self-contained <local-memory-plugin> rules in the context hook", async () => {
    await withTempDir(async (tmpDir) => {
      await storeMemoryFact(tmpDir, {
        topic: "preferences",
        tags: "style, Vanilla-JS",
        fact: "Prefer terse top-to-bottom vanilla JavaScript.",
      });

      const registeredTools = [];
      const registeredHooks = new Map();

      const dispose = await server.setup({
        options: { directory: tmpDir, minScore: 0.2, topK: 5 },
        tool: {
          async transform(fn) {
            fn({
              add(toolDef) {
                registeredTools.push(toolDef);
              },
            });
            return { dispose() {} };
          },
        },
        session: {
          async hook(name, handler) {
            registeredHooks.set(name, handler);
            return { dispose() {} };
          },
        },
      });

      assert.equal(registeredTools.length, 4);
      assert.deepEqual(
        registeredTools.map((t) => t.name),
        ["memory_store", "memory_delete", "memory_search", "memory_checkpoint"]
      );
      assert.ok(registeredHooks.has("context"));
      assert.ok(registeredHooks.has("compaction"));

      const event = {
        messages: [{ role: "user", content: "What is our vanilla JavaScript style preference?" }],
        system: [],
      };
      await registeredHooks.get("context")(event);
      assert.equal(event.system.length, 1);
      assert.ok(event.system[0].text.includes("<local-memory-plugin>"));
      assert.ok(event.system[0].text.includes("AUTOMATIC STORAGE"));
      assert.ok(event.system[0].text.includes("preferences-001"));

      if (typeof dispose === "function") {
        await dispose();
      }
    });
  });

  it("supports memory_delete, in-place id updates, and supersedes lifecycle without leaving stale entries", async () => {
    await withTempDir(async (tmpDir) => {
      const v1 = await storeMemoryFact(tmpDir, {
        topic: "environment",
        id: "env-001",
        tags: "permissions, cli",
        fact: "cli.json has session.permissions=allow.",
      });
      assert.equal(v1.id, "env-001");
      assert.equal(v1.updated, false);

      // In-place update by ID
      const v1Updated = await storeMemoryFact(tmpDir, {
        topic: "environment",
        id: "env-001",
        tags: "permissions, cli, updated",
        fact: "cli.json has session.permissions=prompt.",
      });
      assert.equal(v1Updated.id, "env-001");
      assert.equal(v1Updated.updated, true);

      let entries = parseTopicEntries(tmpDir);
      assert.equal(entries.length, 1);
      assert.equal(entries[0].fact, "cli.json has session.permissions=prompt.");

      // Supersede env-001 with env-002
      const v2 = await storeMemoryFact(tmpDir, {
        topic: "environment",
        id: "env-002",
        supersedes: "env-001",
        tags: "permissions, cli, hardened",
        fact: "cli.json enforces prompt permissions with targeted ask guards.",
      });
      assert.equal(v2.id, "env-002");
      assert.deepEqual(v2.superseded, ["env-001"]);

      entries = parseTopicEntries(tmpDir);
      assert.equal(entries.length, 1);
      assert.equal(entries[0].id, "env-002");

      const cachedAfterSupersede = loadCachedVectors(tmpDir);
      assert.equal(cachedAfterSupersede.length, 1);
      assert.equal(cachedAfterSupersede[0].id, "env-002");

      // Direct delete
      const delRes = await deleteMemoryEntry(tmpDir, "env-002, nonexistent-999");
      assert.equal(delRes.deleted.length, 1);
      assert.equal(delRes.deleted[0].id, "env-002");
      assert.deepEqual(delRes.notFound, ["nonexistent-999"]);
      assert.equal(parseTopicEntries(tmpDir).length, 0);
      assert.equal(loadCachedVectors(tmpDir).length, 0);
    });
  });

  it("supports project scoping, core pinned memories, and BM25 lexical scoring", async () => {
    await withTempDir(async (tmpDir) => {
      await storeMemoryFact(tmpDir, {
        topic: "decisions",
        id: "dec-core-001",
        tags: "core, boundary",
        core: true,
        fact: "Always work inside C:/MAMPFiles and ask before touching external directories.",
      });

      await storeMemoryFact(tmpDir, {
        topic: "decisions",
        id: "dec-winnipeg-001",
        tags: "winnipeg, cards, css",
        project: "C:/MAMPFiles/client-code/winnipeg",
        fact: "Winnipeg equal-height cards use flex-direction column on .card-body.",
      });

      await storeMemoryFact(tmpDir, {
        topic: "decisions",
        id: "dec-butte-001",
        tags: "butte, events, calendar",
        project: "C:/MAMPFiles/client-code/butte",
        fact: "Butte events feed uses Cascade JSON block.",
      });

      const coreForWinnipeg = getCoreMemories(tmpDir, "C:/MAMPFiles/client-code/winnipeg");
      assert.equal(coreForWinnipeg.length, 1);
      assert.equal(coreForWinnipeg[0].id, "dec-core-001");

      assert.equal(matchesProjectScope("winnipeg", "C:/MAMPFiles/client-code/winnipeg"), true);
      assert.equal(matchesProjectScope("winnipeg", "C:/MAMPFiles/git/hannon-hill/_clients/uwinnipeg"), true);
      assert.equal(matchesProjectScope("butte", "C:/MAMPFiles/client-code/winnipeg"), false);
      assert.equal(matchesProjectScope("global", "C:/MAMPFiles/client-code/winnipeg"), true);

      // Rule 1: Specific subfolder isolates from sibling projects
      const winnipegHits = await searchMemory(
        tmpDir,
        "cards calendar events",
        "hybrid",
        10,
        { project: "C:/MAMPFiles/client-code/winnipeg" }
      );
      const hitIds = winnipegHits.map((h) => h.entry.id);
      assert.ok(hitIds.includes("dec-winnipeg-001"));
      assert.ok(!hitIds.includes("dec-butte-001"));

      // Rule 2: Umbrella root (C:/MAMPFiles) + prompt mentioning 'butte' isolates to global + butte
      const umbrellaButteHits = await searchMemory(
        tmpDir,
        "update butte events calendar",
        "hybrid",
        10,
        { project: "C:/MAMPFiles" }
      );
      const umbrellaButteIds = umbrellaButteHits.map((h) => h.entry.id);
      assert.ok(umbrellaButteIds.includes("dec-butte-001"));
      assert.ok(!umbrellaButteIds.includes("dec-winnipeg-001"));

      // Rule 3: Umbrella root (C:/MAMPFiles) + prompt with NO project name allows all nested projects to compete
      const umbrellaFallbackHits = await searchMemory(
        tmpDir,
        "equal-height cards flex-direction column",
        "hybrid",
        10,
        { project: "C:/MAMPFiles" }
      );
      const umbrellaFallbackIds = umbrellaFallbackHits.map((h) => h.entry.id);
      assert.ok(umbrellaFallbackIds.includes("dec-winnipeg-001"));
      assert.ok(umbrellaFallbackIds.includes("dec-butte-001"));

      // BM25 lexical score does not false-positive on short stopword substrings
      const allEntries = loadCachedVectors(tmpDir);
      const winnipegEntry = allEntries.find((e) => e.id === "dec-winnipeg-001");
      const exactIdScore = computeLexicalScore(winnipegEntry, "dec-winnipeg-001", ["dec-winnipeg-001"], null);
      const unrelatedScore = computeLexicalScore(winnipegEntry, "xyznonexistent", ["xyznonexistent"], null);
      assert.ok(exactIdScore > 0.7);
      assert.equal(unrelatedScore, 0);
    });
  });

  it("sanitizes brackets/newlines in tags & IDs and preserves tuple entries in opencode.jsonc", async () => {
    await withTempDir(async (tmpDir) => {
      const memDir = path.join(tmpDir, "memory");
      const cfgDir = path.join(tmpDir, "config");
      fs.mkdirSync(cfgDir, { recursive: true });
      const jsoncPath = path.join(cfgDir, "opencode.jsonc");
      fs.writeFileSync(
        jsoncPath,
        '{\n  "plugins": [\n    ["existing-plugin", { "a": true }] // keep comment\n  ]\n}\n',
        "utf8"
      );

      await installPlugin({ configDir: cfgDir, directory: memDir });
      const rawJsonc = fs.readFileSync(jsoncPath, "utf8");
      assert.ok(rawJsonc.includes('["existing-plugin", { "a": true }], // keep comment'));
      assert.ok(rawJsonc.includes('["@nandoblanco/opencode-local-memory"'));

      const stored = await storeMemoryFact(memDir, {
        topic: "security",
        id: "sec-[001]\ninjected",
        tags: "tag1], [tag2\nnewline",
        fact: "First line\nSecond line",
      });
      assert.equal(stored.id, "sec-001-injected");
      const entries = parseTopicEntries(memDir);
      assert.equal(entries.length, 1);
      assert.equal(entries[0].id, "sec-001-injected");
      assert.equal(entries[0].tags, "tag1, tag2 newline");
      assert.equal(entries[0].fact, "First line Second line");
    });
  });

  it("imports AGENTS.md rules and compacted opencode.db sessions idempotently", async () => {
    await withTempDir(async (tmpDir) => {
      const memDir = path.join(tmpDir, "memory");
      const agentsFile = path.join(tmpDir, "AGENTS.md");
      const wrapperFile = path.join(tmpDir, "CLAUDE.md");
      const dbPath = path.join(tmpDir, "opencode.db");

      fs.writeFileSync(
        agentsFile,
        [
          "# Global Instructions",
          "",
          "## Working Boundary",
          "- Always work inside C:/MAMPFiles and ask before touching external directories.",
          "",
          "## Local Page URLs (XAMPP/Apache)",
          "- C:/MAMPFiles is Apache's DocumentRoot mapping directly to http://localhost/.",
          "",
          "## New Code Style",
          "- Write terse, top-to-bottom vanilla JavaScript without unnecessary IIFEs.",
        ].join("\n"),
        "utf8"
      );
      fs.writeFileSync(wrapperFile, "@" + agentsFile + "\n", "utf8");

      const sqliteMod = await import("node:sqlite");
      const db = new sqliteMod.DatabaseSync(dbPath);
      db.exec(`
        CREATE TABLE session_v2 (
          id TEXT PRIMARY KEY,
          title TEXT,
          directory TEXT,
          time_created INTEGER,
          time_updated INTEGER,
          time_archived INTEGER
        );
        CREATE TABLE session_message (
          id TEXT PRIMARY KEY,
          session_id TEXT,
          type TEXT,
          time_created INTEGER,
          data TEXT
        );
      `);
      db.prepare(
        "INSERT INTO session_v2 (id, title, directory, time_created, time_updated, time_archived) VALUES (?, ?, ?, ?, ?, NULL)"
      ).run("ses_test_001", "Winnipeg Card Layout Fix", "C:/MAMPFiles/client-code/winnipeg", 1761500000000, 1761500500000);
      db.prepare(
        "INSERT INTO session_message (id, session_id, type, time_created, data) VALUES (?, ?, ?, ?, ?)"
      ).run(
        "msg_001",
        "ses_test_001",
        "user",
        1761500000000,
        JSON.stringify({ type: "user", text: "Fix the equal-height card layout on the Winnipeg landing page." })
      );
      db.prepare(
        "INSERT INTO session_message (id, session_id, type, time_created, data) VALUES (?, ?, ?, ?, ?)"
      ).run(
        "msg_002",
        "ses_test_001",
        "assistant",
        1761500500000,
        JSON.stringify({
          type: "assistant",
          content: [
            {
              type: "tool",
              name: "compress",
              state: {
                input: {
                  topic: "Card Layout Fix",
                  content: [{ summary: "Updated .card-body to use flex-direction: column and pushed .card-cta to the bottom with margin-top: auto." }]
                }
              }
            },
            {
              type: "text",
              text: "Verified equal-height cards across 375px, 768px, and 1280px viewports."
            }
          ]
        })
      );
      db.close();

      const firstRun = await importExistingMemory(memDir, {
        agentsFiles: [wrapperFile],
        dbPath: dbPath,
      });

      assert.equal(firstRun.importedFacts.length, 3);
      assert.equal(firstRun.importedSessions.length, 1);
      assert.equal(firstRun.syncResult.total, 4);

      const secondRun = await importExistingMemory(memDir, {
        agentsFiles: [wrapperFile],
        dbPath: dbPath,
      });
      assert.equal(secondRun.importedFacts.length, 0);
      assert.equal(secondRun.skippedFacts, 3);
      assert.equal(secondRun.importedSessions.length, 0);
      assert.equal(secondRun.skippedSessions, 1);

      const hits = await searchMemory(memDir, "flex-direction column card-cta", "hybrid", 5);
      assert.ok(hits.length >= 1);
      assert.ok(hits[0].entry.id.startsWith("session:"));
    });
  });
});
