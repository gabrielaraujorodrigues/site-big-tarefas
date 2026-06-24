import { pgTable, serial, text, integer, timestamp, boolean, real } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const logsTable = pgTable("automation_logs", {
  id: serial("id").primaryKey(),
  timestamp: timestamp("timestamp").defaultNow().notNull(),
  level: text("level").notNull(), // info | success | warn | error
  message: text("message").notNull(),
  detail: text("detail"),
});

export const surveysTable = pgTable("automation_surveys", {
  id: serial("id").primaryKey(),
  title: text("title").notNull(),
  points: integer("points").notNull().default(0),
  status: text("status").notNull().default("completed"), // completed | failed | skipped
  completedAt: timestamp("completed_at").defaultNow().notNull(),
  durationSeconds: integer("duration_seconds"),
});

export const automationRunsTable = pgTable("automation_runs", {
  id: serial("id").primaryKey(),
  startedAt: timestamp("started_at").defaultNow().notNull(),
  endedAt: timestamp("ended_at"),
  pointsEarned: integer("points_earned").notNull().default(0),
  surveysCompleted: integer("surveys_completed").notNull().default(0),
  surveysFailed: integer("surveys_failed").notNull().default(0),
  success: boolean("success"),
});

export const insertLogSchema = createInsertSchema(logsTable).omit({ id: true, timestamp: true });
export const insertSurveySchema = createInsertSchema(surveysTable).omit({ id: true, completedAt: true });
export const insertRunSchema = createInsertSchema(automationRunsTable).omit({ id: true, startedAt: true });

export type Log = typeof logsTable.$inferSelect;
export type Survey = typeof surveysTable.$inferSelect;
export type AutomationRun = typeof automationRunsTable.$inferSelect;
export type InsertLog = z.infer<typeof insertLogSchema>;
export type InsertSurvey = z.infer<typeof insertSurveySchema>;
