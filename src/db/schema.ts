import { index, integer, jsonb, pgEnum, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid, varchar } from "drizzle-orm/pg-core";

export type MemoryScope = Record<string, string | number | boolean | null>;
export type MemoryDetails = Record<string, unknown>;

export const memoryKindEnum = pgEnum("memory_kind", ["semantic", "procedural"]);
export const memoryStatusEnum = pgEnum("memory_status", ["candidate", "active", "disputed", "superseded", "archived"]);
export const memoryEvidenceRelationEnum = pgEnum("memory_evidence_relation", ["supports", "contradicts", "updates"]);

export const memoryEvents = pgTable("memory_events", {
  id: uuid("id").defaultRandom().primaryKey(),
  tenantId: text("tenant_id").notNull(),
  repository: text("repository").notNull(),
  sourceType: varchar("source_type", { length: 60 }).notNull(),
  sourceId: varchar("source_id", { length: 255 }).notNull(),
  sourceUrl: text("source_url"),
  eventType: varchar("event_type", { length: 100 }).notNull(),
  actorId: text("actor_id"),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
  details: jsonb("details").$type<MemoryDetails>().notNull().default({}),
  recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  sourceIdentity: uniqueIndex("memory_events_source_identity").on(
    table.tenantId,
    table.repository,
    table.sourceType,
    table.sourceId,
  ),
  repositoryTimeline: index("memory_events_repository_timeline").on(table.tenantId, table.repository, table.occurredAt),
}));

export const memories = pgTable("memories", {
  id: uuid("id").defaultRandom().primaryKey(),
  tenantId: text("tenant_id").notNull(),
  domain: varchar("domain", { length: 100 }).notNull(),
  repository: text("repository").notNull(),
  kind: memoryKindEnum("kind").notNull(),
  title: varchar("title", { length: 240 }).notNull(),
  summary: text("summary").notNull(),
  scope: jsonb("scope").$type<MemoryScope>().notNull().default({}),
  content: jsonb("content").$type<MemoryDetails>().notNull().default({}),
  status: memoryStatusEnum("status").notNull().default("candidate"),
  confidence: varchar("confidence", { length: 16 }),
  authority: text("authority"),
  effectiveFrom: timestamp("effective_from", { withTimezone: true }).notNull().defaultNow(),
  effectiveUntil: timestamp("effective_until", { withTimezone: true }),
  version: integer("version").notNull().default(1),
  supersedesId: uuid("supersedes_id"),
  createdBy: text("created_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  repositoryStatus: index("memories_repository_status").on(table.tenantId, table.repository, table.status),
}));

export const memoryEvidence = pgTable("memory_evidence", {
  memoryId: uuid("memory_id").notNull().references(() => memories.id, { onDelete: "cascade" }),
  eventId: uuid("event_id").notNull().references(() => memoryEvents.id, { onDelete: "restrict" }),
  relation: memoryEvidenceRelationEnum("relation").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  identity: primaryKey({ columns: [table.memoryId, table.eventId, table.relation] }),
}));

export const memoryApplications = pgTable("memory_applications", {
  id: uuid("id").defaultRandom().primaryKey(),
  tenantId: text("tenant_id").notNull(),
  domain: varchar("domain", { length: 100 }).notNull(),
  repository: text("repository").notNull(),
  analysisId: varchar("analysis_id", { length: 255 }).notNull(),
  resultSummary: text("result_summary"),
  appliedAt: timestamp("applied_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  analysisIdentity: uniqueIndex("memory_applications_analysis_identity").on(
    table.tenantId,
    table.repository,
    table.analysisId,
  ),
  repositoryTimeline: index("memory_applications_repository_timeline").on(table.tenantId, table.repository, table.appliedAt),
}));

export const memoryApplicationItems = pgTable("memory_application_items", {
  applicationId: uuid("application_id").notNull().references(() => memoryApplications.id, { onDelete: "cascade" }),
  memoryId: uuid("memory_id").notNull().references(() => memories.id, { onDelete: "restrict" }),
  reason: text("reason").notNull(),
}, (table) => ({
  identity: primaryKey({ columns: [table.applicationId, table.memoryId] }),
}));
