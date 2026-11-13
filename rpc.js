const DRAFT_2020_12 = "https://json-schema.org/draft/2020-12/schema";

const memoryEntrySchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    date: { type: "string" },
    file: { type: "string" },
    tags: { type: "string" },
    fact: { type: "string" },
    project: { type: "string" },
    core: { type: "boolean" },
  },
  required: ["id", "date", "file", "tags", "fact"],
  additionalProperties: false,
};

const memoryHitSchema = {
  type: "object",
  properties: {
    score: { type: "number" },
    semanticScore: { type: "number" },
    entry: memoryEntrySchema,
  },
  required: ["score", "semanticScore", "entry"],
  additionalProperties: false,
};

export const MemoryRpc = {
  id: "opencode-local-memory",
  methods: {
    query: {
      input: {
        $schema: DRAFT_2020_12,
        type: "object",
        properties: {
          query: { type: "string" },
          typeFilter: { type: "string", enum: ["all", "core", "topics", "sessions"] },
          topicFilter: { type: "string" },
          mode: { type: "string", enum: ["hybrid", "keyword", "regex"] },
          projectFilter: { type: "string" },
          coreOnly: { type: "boolean" },
          limit: { type: "number" },
        },
        additionalProperties: false,
      },
      output: {
        $schema: DRAFT_2020_12,
        type: "object",
        properties: {
          rootDir: { type: "string" },
          totalEntries: { type: "number" },
          coreCount: { type: "number" },
          topicsCount: { type: "number" },
          sessionsCount: { type: "number" },
          topics: { type: "array", items: { type: "string" } },
          projects: { type: "array", items: { type: "string" } },
          hits: { type: "array", items: memoryHitSchema },
        },
        required: [
          "rootDir",
          "totalEntries",
          "coreCount",
          "topicsCount",
          "sessionsCount",
          "topics",
          "projects",
          "hits",
        ],
        additionalProperties: false,
      },
    },
    store: {
      input: {
        $schema: DRAFT_2020_12,
        type: "object",
        properties: {
          id: { type: "string" },
          topic: { type: "string" },
          tags: { type: "string" },
          fact: { type: "string" },
          project: { type: "string" },
          core: { type: "boolean" },
          supersedes: { type: "string" },
        },
        required: ["topic", "tags", "fact"],
        additionalProperties: false,
      },
      output: {
        $schema: DRAFT_2020_12,
        type: "object",
        properties: {
          entry: {
            type: "object",
            properties: {
              id: { type: "string" },
              date: { type: "string" },
              file: { type: "string" },
              tags: { type: "string" },
              fact: { type: "string" },
              project: { type: "string" },
              core: { type: "boolean" },
              updated: { type: "boolean" },
              superseded: { type: "array", items: { type: "string" } },
            },
            required: ["id", "date", "file", "tags", "fact", "project", "core", "updated", "superseded"],
            additionalProperties: false,
          },
        },
        required: ["entry"],
        additionalProperties: false,
      },
    },
    remove: {
      input: {
        $schema: DRAFT_2020_12,
        type: "object",
        properties: {
          id: { type: "string" },
        },
        required: ["id"],
        additionalProperties: false,
      },
      output: {
        $schema: DRAFT_2020_12,
        type: "object",
        properties: {
          deleted: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string" },
                file: { type: "string" },
              },
              required: ["id", "file"],
              additionalProperties: false,
            },
          },
          notFound: { type: "array", items: { type: "string" } },
          total: { type: "number" },
        },
        required: ["deleted", "notFound", "total"],
        additionalProperties: false,
      },
    },
    sync: {
      input: {
        $schema: DRAFT_2020_12,
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      output: {
        $schema: DRAFT_2020_12,
        type: "object",
        properties: {
          total: { type: "number" },
          embedded: { type: "number" },
          reused: { type: "number" },
          vecFile: { type: "string" },
        },
        required: ["total", "embedded", "reused", "vecFile"],
        additionalProperties: false,
      },
    },
    importMemory: {
      input: {
        $schema: DRAFT_2020_12,
        type: "object",
        properties: {
          limit: { type: "number" },
        },
        additionalProperties: false,
      },
      output: {
        $schema: DRAFT_2020_12,
        type: "object",
        properties: {
          importedFactsCount: { type: "number" },
          skippedFacts: { type: "number" },
          importedSessionsCount: { type: "number" },
          skippedSessions: { type: "number" },
          total: { type: "number" },
        },
        required: [
          "importedFactsCount",
          "skippedFacts",
          "importedSessionsCount",
          "skippedSessions",
          "total",
        ],
        additionalProperties: false,
      },
    },
    getSessionMarkdown: {
      input: {
        $schema: DRAFT_2020_12,
        type: "object",
        properties: {
          file: { type: "string" },
        },
        required: ["file"],
        additionalProperties: false,
      },
      output: {
        $schema: DRAFT_2020_12,
        type: "object",
        properties: {
          file: { type: "string" },
          markdown: { type: "string" },
        },
        required: ["file", "markdown"],
        additionalProperties: false,
      },
    },
  },
  events: {},
};

export default MemoryRpc;
