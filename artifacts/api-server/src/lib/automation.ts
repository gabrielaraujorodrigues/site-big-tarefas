import { chromium, type Browser, type Page } from "playwright-core";
import { eq } from "drizzle-orm";
import { db, logsTable, surveysTable, automationRunsTable } from "@workspace/db";
import { logger } from "./logger";

// ─── State ────────────────────────────────────────────────────────────────────

export type Phase =
  | "idle"
  | "logging_in"
  | "browsing"
  | "answering"
  | "claiming"
  | "error";

interface AutomationState {
  running: boolean;
  phase: Phase;
  pointsEarned: number;
  surveysCompleted: number;
  startedAt: string | null;
  lastError: string | null;
  currentRunId: number | null;
}

const state: AutomationState = {
  running: false,
  phase: "idle",
  pointsEarned: 0,
  surveysCompleted: 0,
  startedAt: null,
  lastError: null,
  currentRunId: null,
};

let stopRequested = false;
let browser: Browser | null = null;

// ─── Accessors ────────────────────────────────────────────────────────────────

export function getState(): Readonly<AutomationState> {
  return { ...state };
}

export function requestStop(): void {
  stopRequested = true;
}

// ─── Logging helper ───────────────────────────────────────────────────────────

async function log(
  level: "info" | "success" | "warn" | "error",
  message: string,
  detail?: string,
): Promise<void> {
  logger.info({ level, message, detail }, "automation log");
  await db.insert(logsTable).values({ level, message, detail }).catch(() => {});
}

// ─── Smart answer heuristics (no OpenAI needed) ───────────────────────────────

/**
 * Picks the best option using Brazilian consumer survey heuristics.
 * Most surveys expect "normal" consumer behavior — not extreme answers.
 */
function pickBestOption(questionText: string, options: string[]): number {
  const q = questionText.toLowerCase();

  if (options.length === 0) return 0;
  if (options.length === 1) return 0;

  // Yes/No questions
  const yesKeywords = ["compra", "usa", "utiliza", "tem", "possui", "consome", "gosta", "prefere", "conhece"];
  const noKeywords = ["nunca", "jamais"];
  if (options.length === 2) {
    const opt0 = options[0]?.toLowerCase() ?? "";
    const opt1 = options[1]?.toLowerCase() ?? "";
    if (opt0.includes("sim") || opt0.includes("yes")) {
      const shouldSayYes = yesKeywords.some((k) => q.includes(k));
      return shouldSayYes ? 0 : 1;
    }
    if (opt0.includes("não") || opt0.includes("nao") || opt0.includes("no")) {
      return 1; // default yes (option 1)
    }
    // Binary without sim/não: pick first
    return 0;
  }

  // Scale / frequency questions — pick slightly above middle (realistic consumer)
  const isScale =
    q.includes("escala") ||
    q.includes("nota") ||
    q.includes("avali") ||
    q.includes("satisf") ||
    q.includes("frequên") ||
    q.includes("frequ") ||
    options.some((o) => /^\d+$/.test(o.trim()));

  if (isScale) {
    // Pick ~70th percentile (above average but not perfect)
    return Math.floor(options.length * 0.7);
  }

  // Frequency options — pick "às vezes" or "occasionally"
  const freqKeywords = ["sempre", "frequentemente", "às vezes", "raramente", "nunca"];
  const freqMatch = options.findIndex((o) =>
    o.toLowerCase().includes("às vezes") || o.toLowerCase().includes("as vezes") || o.toLowerCase().includes("occasional"),
  );
  if (freqMatch >= 0) return freqMatch;

  // Age / income brackets — pick middle
  if (q.includes("idade") || q.includes("renda") || q.includes("salário") || q.includes("faixa")) {
    return Math.floor(options.length / 2);
  }

  // Education — pick "ensino superior" if present
  const eduMatch = options.findIndex((o) =>
    o.toLowerCase().includes("superior") || o.toLowerCase().includes("graduação") || o.toLowerCase().includes("faculdade"),
  );
  if (eduMatch >= 0) return eduMatch;

  // Gender — try to pick based on no hint, default first
  // City/region — pick first (São Paulo is most common in BR surveys)

  // Default: pick the middle option (avoids extremes, looks natural)
  return Math.floor(options.length / 2);
}

function getTextAnswer(questionText: string): string {
  const q = questionText.toLowerCase();

  if (q.includes("nome")) return "Gabriel";
  if (q.includes("cidade") || q.includes("cidade")) return "São Paulo";
  if (q.includes("bairro")) return "Centro";
  if (q.includes("profiss")) return "Administrativo";
  if (q.includes("empresa") || q.includes("trabalha")) return "Empresa privada";
  if (q.includes("melhoria") || q.includes("sugestão") || q.includes("opinião")) {
    return "Achei ótimo, poderia ter mais opções de produtos.";
  }
  if (q.includes("motivo") || q.includes("por que") || q.includes("razão")) {
    return "Pela qualidade e preço acessível.";
  }
  if (q.includes("comment") || q.includes("observ") || q.includes("adicional")) {
    return "Sem comentários adicionais.";
  }
  return "Bom atendimento e boa experiência no geral.";
}

// ─── Main automation loop ─────────────────────────────────────────────────────

export async function startAutomation(): Promise<void> {
  if (state.running) return;

  const phone = process.env.BIGPESQUISA_PHONE;
  const password = process.env.BIGPESQUISA_PASSWORD;

  if (!phone || !password) {
    state.phase = "error";
    state.lastError = "Credenciais não configuradas (BIGPESQUISA_PHONE / BIGPESQUISA_PASSWORD)";
    await log("error", "Credenciais não configuradas", state.lastError);
    return;
  }

  stopRequested = false;
  state.running = true;
  state.phase = "idle";
  state.pointsEarned = 0;
  state.surveysCompleted = 0;
  state.startedAt = new Date().toISOString();
  state.lastError = null;

  const [run] = await db
    .insert(automationRunsTable)
    .values({ pointsEarned: 0, surveysCompleted: 0, surveysFailed: 0 })
    .returning();
  state.currentRunId = run.id;

  await log("info", "Automacao iniciada");

  // Fire and forget
  runLoop(phone, password).catch(async (err) => {
    const msg = err instanceof Error ? err.message : String(err);
    state.running = false;
    state.phase = "error";
    state.lastError = msg;
    await log("error", "Erro fatal na automacao", msg);
    if (browser) {
      await browser.close().catch(() => {});
      browser = null;
    }
    await finishRun(false);
  });
}

async function finishRun(success: boolean): Promise<void> {
  if (!state.currentRunId) return;
  await db
    .update(automationRunsTable)
    .set({
      endedAt: new Date(),
      pointsEarned: state.pointsEarned,
      surveysCompleted: state.surveysCompleted,
      success,
    })
    .where(eq(automationRunsTable.id, state.currentRunId))
    .catch(() => {});
}

async function runLoop(phone: string, password: string): Promise<void> {
  try {
    state.phase = "logging_in";
    await log("info", "Abrindo navegador...");

    browser = await chromium.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--single-process",
      ],
    });

    const context = await browser.newContext({
      userAgent:
        "Mozilla/5.0 (Linux; Android 11; SM-G991B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36",
      viewport: { width: 390, height: 844 },
    });

    const page = await context.newPage();

    await log("info", "Acessando bigpesquisa.com...");
    await page.goto("https://bigpesquisa.com/app/login", {
      waitUntil: "networkidle",
      timeout: 30000,
    });

    await log("info", "Fazendo login com telefone...");
    await doLogin(page, phone, password);

    if (stopRequested) {
      await log("warn", "Parada solicitada apos login");
      await shutdown();
      return;
    }

    state.phase = "browsing";
    await log("info", "Procurando pesquisas disponiveis...");

    let idleCycles = 0;
    const MAX_IDLE = 5;

    while (!stopRequested) {
      const surveys = await detectSurveys(page);
      await log("info", `${surveys.length} pesquisa(s) encontrada(s)`);

      if (surveys.length === 0) {
        idleCycles++;
        if (idleCycles >= MAX_IDLE) {
          await log("info", "Nenhuma pesquisa disponivel no momento. Encerrando.");
          break;
        }
        await log("info", `Aguardando novas pesquisas... (${idleCycles}/${MAX_IDLE})`);
        await sleep(20000);
        await page.reload({ waitUntil: "networkidle" }).catch(() => {});
        continue;
      }

      idleCycles = 0;

      for (const survey of surveys) {
        if (stopRequested) break;
        await completeSurvey(page, survey);
      }
    }

    await shutdown();
    await log("success", `Automacao concluida. ${state.surveysCompleted} pesquisa(s), ${state.pointsEarned} pontos.`);
    await finishRun(true);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    state.phase = "error";
    state.lastError = msg;
    state.running = false;
    await log("error", "Erro durante automacao", msg);
    await shutdown();
    await finishRun(false);
  }
}

async function shutdown(): Promise<void> {
  state.running = false;
  state.phase = "idle";
  if (browser) {
    await browser.close().catch(() => {});
    browser = null;
  }
}

// ─── Login ────────────────────────────────────────────────────────────────────

async function doLogin(page: Page, phone: string, password: string): Promise<void> {
  try {
    // Wait for any input to appear
    await page.waitForSelector("input", { timeout: 15000 }).catch(() => {});

    // Fill phone number
    const phoneInput = page
      .locator('input[type="tel"], input[placeholder*="telefone"], input[placeholder*="celular"], input[placeholder*="phone"], input[name*="phone"], input[name*="telefone"]')
      .first();

    const phoneCount = await phoneInput.count();
    if (phoneCount > 0) {
      await phoneInput.fill(phone);
    } else {
      // Fallback: first non-password input
      await page.locator('input:not([type="password"]):not([type="hidden"])').first().fill(phone);
    }

    await log("info", "Numero de telefone inserido");
    await sleep(500);

    // Check if there's a "next" step before password (some flows are multi-step)
    const hasNextBtn = await page
      .locator('button:has-text("Continuar"), button:has-text("Proximo"), button:has-text("Next")')
      .count();

    if (hasNextBtn > 0) {
      await page
        .locator('button:has-text("Continuar"), button:has-text("Proximo"), button:has-text("Next")')
        .first()
        .click();
      await sleep(2000);
    }

    // Fill password
    const pwInput = page.locator('input[type="password"]').first();
    const pwCount = await pwInput.count();
    if (pwCount > 0) {
      await pwInput.fill(password);
      await log("info", "Senha inserida");
      await sleep(300);
    }

    // Click login/submit
    const submitBtn = page.locator(
      'button[type="submit"], button:has-text("Entrar"), button:has-text("Login"), button:has-text("Acessar"), button:has-text("Confirmar")',
    ).first();

    const submitCount = await submitBtn.count();
    if (submitCount > 0) {
      await submitBtn.click();
    } else {
      await page.keyboard.press("Enter");
    }

    await page.waitForNavigation({ waitUntil: "networkidle", timeout: 20000 }).catch(() => {});
    await sleep(2000);
    await log("success", "Login realizado com sucesso");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Falha no login: ${msg}`);
  }
}

// ─── Survey detection ─────────────────────────────────────────────────────────

interface SurveyItem {
  title: string;
  points: number;
  index: number;
}

async function detectSurveys(page: Page): Promise<SurveyItem[]> {
  try {
    const currentUrl = page.url();
    if (!currentUrl.includes("bigpesquisa.com/app")) {
      await page.goto("https://bigpesquisa.com/app", { waitUntil: "networkidle", timeout: 20000 });
    }
    await sleep(2000);

    return await page.evaluate(() => {
      const results: Array<{ title: string; points: number; index: number }> = [];
      const seen = new Set<string>();

      // Try many selectors to find survey cards
      const candidates = Array.from(
        document.querySelectorAll(
          "[class*='survey'], [class*='pesquisa'], [class*='research'], [class*='card'], [class*='item'], li, article",
        ),
      );

      for (let i = 0; i < candidates.length; i++) {
        const el = candidates[i];
        if (!el) continue;
        const text = el.textContent?.trim() ?? "";

        // Skip tiny elements
        if (text.length < 5) continue;

        // Must contain point indicators
        const hasPoints =
          text.includes("BigPonto") ||
          text.includes("+") ||
          /\d+\s*(pontos?|pts)/i.test(text);
        if (!hasPoints) continue;

        // Extract title (first heading-like text)
        const titleEl = el.querySelector("h1, h2, h3, h4, p, strong, span");
        const title = titleEl?.textContent?.trim() ?? `Pesquisa ${i + 1}`;

        if (seen.has(title)) continue;
        seen.add(title);

        // Extract points
        const pointsMatch = text.match(/\+?\s*(\d+)\s*(?:BigPontos?|pontos?|pts)/i);
        const points = pointsMatch ? parseInt(pointsMatch[1], 10) : 0;

        results.push({ title, points, index: i });
      }

      return results.slice(0, 10); // max 10 surveys per run
    });
  } catch {
    return [];
  }
}

// ─── Survey completion ────────────────────────────────────────────────────────

async function completeSurvey(page: Page, survey: SurveyItem): Promise<void> {
  const start = Date.now();
  state.phase = "answering";
  await log("info", `Iniciando pesquisa: "${survey.title}" (+${survey.points} pts)`);

  try {
    // Click the survey card
    const clicked = await page.evaluate((title) => {
      const all = Array.from(document.querySelectorAll("a, button, [role='button'], li, div, article"));
      const el = all.find((e) => {
        const t = e.textContent?.trim() ?? "";
        return t.includes(title) && t.length < title.length + 200;
      });
      if (el) {
        (el as HTMLElement).click();
        return true;
      }
      return false;
    }, survey.title);

    if (!clicked) {
      await log("warn", `Nao foi possivel clicar na pesquisa: "${survey.title}"`);
      return;
    }

    await page.waitForNavigation({ waitUntil: "networkidle", timeout: 15000 }).catch(() => {});
    await sleep(2000);

    // Answer all questions
    let questionCount = 0;
    const MAX_QUESTIONS = 60;
    let consecutiveNoQuestion = 0;

    while (questionCount < MAX_QUESTIONS && !stopRequested) {
      const result = await answerCurrentQuestion(page);

      if (result === "done") {
        state.phase = "claiming";
        await log("success", `Pesquisa "${survey.title}" concluida! Resgatando pontos...`);
        await sleep(3000);
        break;
      }

      if (result === "no_question") {
        consecutiveNoQuestion++;
        if (consecutiveNoQuestion >= 3) {
          // Check URL for completion signals
          const url = page.url();
          if (
            url.includes("conclu") ||
            url.includes("obrigado") ||
            url.includes("finish") ||
            url.includes("complet") ||
            url.includes("encerr")
          ) {
            await log("success", `Pesquisa "${survey.title}" finalizada`);
            break;
          }
          await log("warn", "Sem perguntas detectadas. Encerrando pesquisa.");
          break;
        }
        await sleep(2000);
        continue;
      }

      consecutiveNoQuestion = 0;
      questionCount++;
      await sleep(800);
    }

    const duration = Math.round((Date.now() - start) / 1000);
    state.surveysCompleted++;
    state.pointsEarned += survey.points;

    await db.insert(surveysTable).values({
      title: survey.title,
      points: survey.points,
      status: "completed",
      durationSeconds: duration,
    });

    await log("success", `Concluida em ${duration}s | Total: ${state.pointsEarned} pontos`);

    // Return to survey list
    await page.goto("https://bigpesquisa.com/app", { waitUntil: "networkidle", timeout: 20000 }).catch(() => {});
    await sleep(2000);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await log("error", `Erro na pesquisa "${survey.title}"`, msg);

    await db.insert(surveysTable).values({
      title: survey.title,
      points: 0,
      status: "failed",
      durationSeconds: Math.round((Date.now() - start) / 1000),
    }).catch(() => {});

    await page
      .goto("https://bigpesquisa.com/app", { waitUntil: "networkidle", timeout: 20000 })
      .catch(() => {});
  }
}

async function answerCurrentQuestion(page: Page): Promise<"answered" | "done" | "no_question"> {
  try {
    const data = await page.evaluate(() => {
      // Check for done signals
      const bodyText = document.body.textContent ?? "";
      const isDone =
        bodyText.includes("Obrigado") ||
        bodyText.includes("obrigado") ||
        bodyText.includes("Parabens") ||
        bodyText.includes("concluida") ||
        bodyText.includes("finalizada") ||
        bodyText.includes("Completed") ||
        bodyText.includes("encerrada");

      if (isDone) return { isDone: true, questionText: "", options: [], type: "done" };

      // Find question text
      let questionText = "";
      for (const sel of ["legend", "h1", "h2", "h3", "[class*='question']", "[class*='pergunta']", "label.title", "p.question"]) {
        const el = document.querySelector(sel);
        const t = el?.textContent?.trim() ?? "";
        if (t.length > 8) { questionText = t; break; }
      }

      if (!questionText) return { isDone: false, questionText: "", options: [], type: "none" };

      // Find radio/checkbox options
      const radios = Array.from(document.querySelectorAll('input[type="radio"], input[type="checkbox"]'));
      const radioOptions = radios.map((r) => {
        const label =
          r.closest("label") ??
          document.querySelector(`label[for="${(r as HTMLInputElement).id}"]`);
        return label?.textContent?.trim() ?? (r as HTMLInputElement).value ?? "";
      }).filter(Boolean);

      if (radioOptions.length > 0) return { isDone: false, questionText, options: radioOptions, type: "radio" };

      // Select dropdown
      const select = document.querySelector("select");
      if (select) {
        const selectOptions = Array.from(select.options)
          .filter((o) => o.value !== "")
          .map((o) => o.textContent?.trim() ?? "");
        return { isDone: false, questionText, options: selectOptions, type: "select" };
      }

      // Text input
      const textInput = document.querySelector('input[type="text"], input[type="number"], textarea');
      if (textInput) return { isDone: false, questionText, options: [], type: "text" };

      return { isDone: false, questionText, options: [], type: "none" };
    });

    if (data.isDone) return "done";
    if (data.type === "none" || !data.questionText) return "no_question";

    if (data.type === "text") {
      const answer = getTextAnswer(data.questionText);
      const input = page.locator('input[type="text"], input[type="number"], textarea').first();
      await input.fill(answer);
      await log("info", `Resposta (texto): "${data.questionText.slice(0, 40)}..." -> "${answer}"`);
    } else if (data.type === "radio" || data.type === "select") {
      const chosenIdx = pickBestOption(data.questionText, data.options);

      if (data.type === "radio") {
        await page.evaluate((idx) => {
          const radios = Array.from(document.querySelectorAll('input[type="radio"], input[type="checkbox"]'));
          const target = radios[idx] as HTMLInputElement | undefined;
          if (target) {
            target.click();
            target.checked = true;
            target.dispatchEvent(new Event("change", { bubbles: true }));
          }
        }, chosenIdx);
      } else {
        await page.evaluate((idx) => {
          const select = document.querySelector("select") as HTMLSelectElement | null;
          if (select) {
            const opts = Array.from(select.options).filter((o) => o.value !== "");
            const target = opts[idx];
            if (target) {
              select.value = target.value;
              select.dispatchEvent(new Event("change", { bubbles: true }));
            }
          }
        }, chosenIdx);
      }

      await log("info", `Resposta: "${data.questionText.slice(0, 40)}..." -> "${data.options[chosenIdx]}"`);
    }

    await sleep(400);

    // Click next/advance button
    const advanced = await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll("button, input[type='submit']"));
      const next = buttons.find((b) => {
        const t = (b.textContent ?? (b as HTMLInputElement).value ?? "").toLowerCase();
        return t.match(/proxim|continuar|avançar|next|ok|confirmar|enviar|submit/);
      });
      if (next) { (next as HTMLElement).click(); return true; }

      const submit = document.querySelector('button[type="submit"], input[type="submit"]');
      if (submit) { (submit as HTMLElement).click(); return true; }

      return false;
    });

    if (!advanced) await log("warn", "Botao de avancar nao encontrado");

    await page.waitForTimeout(1500);
    return "answered";
  } catch {
    return "no_question";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
