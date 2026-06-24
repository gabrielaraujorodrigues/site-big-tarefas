import { Router, type IRouter } from "express";
import { desc } from "drizzle-orm";
import { db, logsTable, surveysTable, automationRunsTable } from "@workspace/db";
import {
  GetAutomationStatusResponse,
  StartAutomationResponse,
  StopAutomationResponse,
  GetAutomationLogsQueryParams,
  GetAutomationLogsResponse,
  GetAutomationSurveysResponse,
  GetAutomationStatsResponse,
} from "@workspace/api-zod";
import { getState, startAutomation, requestStop } from "../lib/automation";

const router: IRouter = Router();

router.get("/automation/status", async (_req, res): Promise<void> => {
  const s = getState();
  res.json(
    GetAutomationStatusResponse.parse({
      running: s.running,
      phase: s.phase,
      pointsEarned: s.pointsEarned,
      surveysCompleted: s.surveysCompleted,
      startedAt: s.startedAt,
      lastError: s.lastError,
    }),
  );
});

router.post("/automation/start", async (_req, res): Promise<void> => {
  await startAutomation();
  const s = getState();
  res.json(
    StartAutomationResponse.parse({
      running: s.running,
      phase: s.phase,
      pointsEarned: s.pointsEarned,
      surveysCompleted: s.surveysCompleted,
      startedAt: s.startedAt,
      lastError: s.lastError,
    }),
  );
});

router.post("/automation/stop", async (_req, res): Promise<void> => {
  requestStop();
  const s = getState();
  res.json(
    StopAutomationResponse.parse({
      running: s.running,
      phase: s.phase,
      pointsEarned: s.pointsEarned,
      surveysCompleted: s.surveysCompleted,
      startedAt: s.startedAt,
      lastError: s.lastError,
    }),
  );
});

router.get("/automation/logs", async (req, res): Promise<void> => {
  const query = GetAutomationLogsQueryParams.safeParse(req.query);
  const limit = query.success ? (query.data.limit ?? 50) : 50;

  const logs = await db
    .select()
    .from(logsTable)
    .orderBy(desc(logsTable.timestamp))
    .limit(limit);

  res.json(
    GetAutomationLogsResponse.parse(
      logs.map((l) => ({
        id: l.id,
        timestamp: l.timestamp.toISOString(),
        level: l.level,
        message: l.message,
        detail: l.detail ?? null,
      })),
    ),
  );
});

router.get("/automation/surveys", async (_req, res): Promise<void> => {
  const surveys = await db
    .select()
    .from(surveysTable)
    .orderBy(desc(surveysTable.completedAt))
    .limit(100);

  res.json(
    GetAutomationSurveysResponse.parse(
      surveys.map((s) => ({
        id: s.id,
        title: s.title,
        points: s.points,
        status: s.status,
        completedAt: s.completedAt.toISOString(),
        durationSeconds: s.durationSeconds ?? null,
      })),
    ),
  );
});

router.get("/automation/stats", async (_req, res): Promise<void> => {
  const runs = await db.select().from(automationRunsTable);
  const surveys = await db.select().from(surveysTable);

  const totalPointsEarned = surveys
    .filter((s) => s.status === "completed")
    .reduce((sum, s) => sum + s.points, 0);

  const totalSurveysCompleted = surveys.filter((s) => s.status === "completed").length;
  const totalSurveysFailed = surveys.filter((s) => s.status === "failed").length;
  const total = totalSurveysCompleted + totalSurveysFailed;
  const successRate = total === 0 ? 0 : Math.round((totalSurveysCompleted / total) * 100) / 100;

  const lastRun = runs.sort(
    (a, b) => b.startedAt.getTime() - a.startedAt.getTime(),
  )[0];

  res.json(
    GetAutomationStatsResponse.parse({
      totalPointsEarned,
      totalSurveysCompleted,
      totalSurveysFailed,
      successRate,
      totalRuns: runs.length,
      lastRunAt: lastRun?.startedAt.toISOString() ?? null,
    }),
  );
});

export default router;
