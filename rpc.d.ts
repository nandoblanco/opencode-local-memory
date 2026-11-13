import type { JsonSchema, Rpc } from "@opencode/plugin/rpc";

export type MemoryTypeFilter = "all" | "core" | "topics" | "sessions";
export type MemoryModeFilter = "hybrid" | "keyword" | "regex";

export interface MemoryRpcEntry {
  id: string;
  date: string;
  file: string;
  tags: string;
  fact: string;
  project?: string;
  core?: boolean;
}

export interface MemoryRpcHit {
  score: number;
  semanticScore: number;
  entry: MemoryRpcEntry;
}

export interface MemoryRpcQueryInput {
  query?: string;
  typeFilter?: MemoryTypeFilter;
  topicFilter?: string;
  mode?: MemoryModeFilter;
  projectFilter?: string;
  coreOnly?: boolean;
  limit?: number;
}

export interface MemoryRpcQueryOutput {
  rootDir: string;
  totalEntries: number;
  coreCount: number;
  topicsCount: number;
  sessionsCount: number;
  topics: string[];
  projects: string[];
  hits: MemoryRpcHit[];
}

export interface MemoryRpcStoreInput {
  id?: string;
  topic: string;
  tags: string;
  fact: string;
  project?: string;
  core?: boolean;
  supersedes?: string;
}

export interface MemoryRpcStoreOutput {
  entry: {
    id: string;
    date: string;
    file: string;
    tags: string;
    fact: string;
    project: string;
    core: boolean;
    updated: boolean;
    superseded: string[];
  };
}

export interface MemoryRpcRemoveInput {
  id: string;
}

export interface MemoryRpcRemoveOutput {
  deleted: Array<{ id: string; file: string }>;
  notFound: string[];
  total: number;
}

export interface MemoryRpcSyncInput {}

export interface MemoryRpcSyncOutput {
  total: number;
  embedded: number;
  reused: number;
  vecFile: string;
}

export interface MemoryRpcImportInput {
  limit?: number;
}

export interface MemoryRpcImportOutput {
  importedFactsCount: number;
  skippedFacts: number;
  importedSessionsCount: number;
  skippedSessions: number;
  total: number;
}

export interface MemoryRpcSessionMarkdownInput {
  file: string;
}

export interface MemoryRpcSessionMarkdownOutput {
  file: string;
  markdown: string;
}

type SchemaFor<T> = JsonSchema.JsonSchema & { readonly __type?: T };

export declare const MemoryRpc: Rpc.Definition<
  "opencode-local-memory",
  {
    query: {
      input: SchemaFor<MemoryRpcQueryInput>;
      output: SchemaFor<MemoryRpcQueryOutput>;
    };
    store: {
      input: SchemaFor<MemoryRpcStoreInput>;
      output: SchemaFor<MemoryRpcStoreOutput>;
    };
    remove: {
      input: SchemaFor<MemoryRpcRemoveInput>;
      output: SchemaFor<MemoryRpcRemoveOutput>;
    };
    sync: {
      input: SchemaFor<MemoryRpcSyncInput>;
      output: SchemaFor<MemoryRpcSyncOutput>;
    };
    importMemory: {
      input: SchemaFor<MemoryRpcImportInput>;
      output: SchemaFor<MemoryRpcImportOutput>;
    };
    getSessionMarkdown: {
      input: SchemaFor<MemoryRpcSessionMarkdownInput>;
      output: SchemaFor<MemoryRpcSessionMarkdownOutput>;
    };
  },
  Record<never, never>
>;

export default MemoryRpc;
