"use strict";

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  ensureMemoryLayout,
  getTopicSlugs,
  installPlugin,
  loadCachedVectors,
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
          '    "opencode-session-search"',
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
      assert.ok(updatedJsonc.includes('"opencode-session-search"'));
      assert.ok(updatedJsonc.includes('"opencode-local-memory"'));

      const cliJson = fs.readFileSync(path.join(cfgDir, "cli.json"), "utf8");
      assert.ok(cliJson.includes('"opencode-local-memory"'));
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

      assert.equal(registeredTools.length, 3);
      assert.deepEqual(
        registeredTools.map((t) => t.name),
        ["memory_store", "memory_search", "memory_checkpoint"]
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
});
