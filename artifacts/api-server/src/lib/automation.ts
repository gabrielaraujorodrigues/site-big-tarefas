import { chromium, type Browser, type Page } from "playwright-core";
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { eq } from "drizzle-orm";
import { db, logsTable, surveysTable, automationRunsTable } from "@workspace/db";
import { logger } from "./logger";

function findChromiumExecutable(): string | undefined {
  // 1. Try system chromium (installed via nix on Replit)
  const candidates = [
    "/run/current-system/sw/bin/chromium",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/google-chrome",
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  // 2. Try `which chromium`
  try {
    const p = execSync("which chromium 2>/dev/null || which chromium-browser 2>/dev/null || which google-chrome-stable 2>/dev/null", { encoding: "utf8" }).trim().split("\n")[0];
    if (p && existsSync(p)) return p;
  } catch { /* ignore */ }
  // 3. Try nix store path directly
  try {
    const nixPath = execSync("find /nix/store -name 'chromium' -type f -path '*/bin/chromium' 2>/dev/null | head -1", { encoding: "utf8" }).trim();
    if (nixPath && existsSync(nixPath)) return nixPath;
  } catch { /* ignore */ }
  // 4. Let playwright use its own downloaded browser (may fail without system libs)
  return undefined;
}

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

    const executablePath = findChromiumExecutable();
    logger.info({ executablePath: executablePath ?? "playwright-default" }, "launching browser");

    browser = await chromium.launch({
      headless: true,
      executablePath,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--no-zygote",
        "--disable-extensions",
      ],
    });

    const context = await browser.newContext({
      userAgent:
        "Mozilla/5.0 (Linux; Android 11; SM-G991B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36",
      viewport: { width: 390, height: 844 },
    });

    const page = await context.newPage();

    // Discover login URL by starting from homepage
    await log("info", "Acessando bigpesquisa.com...");
    await page.goto("https://bigpesquisa.com", {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });
    await sleep(3000);

    // Save screenshot of homepage for debugging
    try {
      await page.screenshot({ path: "/tmp/bigpesquisa-home.png", fullPage: false });
    } catch { /* ignore */ }

    const homeUrl = page.url();
    await log("info", `Homepage carregada: ${homeUrl}`);

    // Try to find and navigate to login page
    const loginCandidates = [
      "https://bigpesquisa.com/entrar",
      "https://bigpesquisa.com/login",
      "https://bigpesquisa.com/signin",
      "https://bigpesquisa.com/auth",
      "https://bigpesquisa.com/auth/login",
    ];

    // First try clicking a login button on homepage
    const loginBtn = page.locator(
      'a:has-text("Entrar"), a:has-text("Login"), a:has-text("Acessar"), a:has-text("Já tenho conta"), button:has-text("Entrar"), a[href*="login"], a[href*="entrar"], a[href*="signin"]'
    ).first();

    if ((await loginBtn.count()) > 0) {
      const href = await loginBtn.getAttribute("href").catch(() => null);
      await log("info", `Botao login encontrado, href: ${href ?? "(click)"}`);
      await loginBtn.click();
      await page.waitForLoadState("domcontentloaded").catch(() => {});
      await sleep(3000);
    } else {
      // Try candidate URLs
      let found = false;
      for (const candidate of loginCandidates) {
        await page.goto(candidate, { waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => {});
        await sleep(2000);
        const status = await page.evaluate(() => document.body.innerHTML.includes("404")).catch(() => true);
        if (!status) {
          await log("info", `Login URL encontrada: ${candidate}`);
          found = true;
          break;
        }
      }
      if (!found) {
        await log("warn", "URL de login nao encontrada, tentando homepage como fallback");
      }
    }

    await sleep(2000);
    const loginUrl = page.url();
    await log("info", `Pagina de login: ${loginUrl}`);

    // Check if CloudFront blocked us before even trying login
    const loginPageBlocked = await page.evaluate(() => {
      const t = document.body.innerText ?? "";
      return t.includes("403") || t.includes("Request blocked") || t.includes("Too Many");
    }).catch(() => false);

    if (loginPageBlocked) {
      await log("warn", "Pagina de login bloqueada (403/429) — aguardando 60s antes de tentar novamente");
      await sleep(60000);
      // Retry loading the login page
      await page.goto(loginUrl, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
      await sleep(5000);
      const stillBlocked = await page.evaluate(() => {
        const t = document.body.innerText ?? "";
        return t.includes("403") || t.includes("Request blocked");
      }).catch(() => false);
      if (stillBlocked) throw new Error("Bloqueio CloudFront persistente. Tente novamente em alguns minutos.");
    }

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
        // Skip surveys with no valid href
        if (!survey.href) {
          await log("warn", `Pulando "${survey.title}" (sem href)`);
          continue;
        }
        await completeSurvey(page, survey);
        // Delay between surveys to avoid rate limiting (429)
        if (!stopRequested) await sleep(8000);
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
    // Wait up to 60s for ANY input to appear (SPA apps can be slow)
    await log("info", "Aguardando pagina de login carregar...");
    await page.waitForSelector("input, [data-testid], form", { timeout: 60000 }).catch(() => {});
    await sleep(3000);

    // Debug: log the page URL and title
    const url = page.url();
    const title = await page.title().catch(() => "?");
    await log("info", `Pagina: ${title} | URL: ${url}`);

    // Save screenshot and HTML for debugging
    try {
      const { writeFileSync } = await import("node:fs");
      const html = await page.content();
      writeFileSync("/tmp/bigpesquisa-login.html", html);
      await page.screenshot({ path: "/tmp/bigpesquisa-login.png", fullPage: true });
      await log("info", "Screenshot e HTML salvos em /tmp/");
    } catch { /* ignore */ }

    // Log visible elements for debugging
    const elemSummary = await page.evaluate(() => {
      const inputs = document.querySelectorAll("input, textarea, [contenteditable], [role='textbox'], ion-input, mat-input, [data-input]");
      const forms = document.querySelectorAll("form");
      return {
        inputCount: inputs.length,
        formCount: forms.length,
        bodySnippet: document.body.innerHTML.slice(0, 500),
      };
    }).catch(() => ({ inputCount: -1, formCount: -1, bodySnippet: "error" }));
    await log("info", `DOM: ${elemSummary.inputCount} inputs, ${elemSummary.formCount} forms | body: ${elemSummary.bodySnippet.slice(0, 200)}`);

    // Try filling phone — ordered from most to least specific
    let phoneFound = false;
    const phoneSelectors = [
      'input[type="tel"]',
      'input[inputmode="tel"]',
      'input[inputmode="numeric"]',
      'input[placeholder*="telefone" i]',
      'input[placeholder*="celular" i]',
      'input[placeholder*="phone" i]',
      'input[placeholder*="número" i]',
      'input[placeholder*="numero" i]',
      'input[name*="phone" i]',
      'input[name*="telefone" i]',
      'input[name*="mobile" i]',
      'input[autocomplete="tel"]',
      'input:not([type="password"]):not([type="hidden"]):not([type="email"]):not([type="checkbox"])',
      'input[type="text"]',
      'input',
    ];

    for (const sel of phoneSelectors) {
      const count = await page.locator(sel).count();
      if (count > 0) {
        await page.locator(sel).first().fill(phone);
        phoneFound = true;
        await log("info", `Campo telefone encontrado com: ${sel}`);
        break;
      }
    }

    if (!phoneFound) {
      throw new Error("Campo de telefone nao encontrado na pagina");
    }

    await sleep(600);

    // Advance to password step if multi-step form
    const nextBtn = page.locator(
      'button:has-text("Continuar"), button:has-text("Próximo"), button:has-text("Proximo"), button:has-text("Next"), button:has-text("Avançar")',
    ).first();
    if ((await nextBtn.count()) > 0) {
      await nextBtn.click();
      await sleep(2500);
      await log("info", "Avancado para etapa de senha");
    }

    // Fill password
    const pwInput = page.locator('input[type="password"]').first();
    if ((await pwInput.count()) > 0) {
      await pwInput.fill(password);
      await log("info", "Senha inserida");
      await sleep(400);
    }

    // Click submit
    const submitSelectors = [
      'button[type="submit"]',
      'input[type="submit"]',
      'button:has-text("Entrar")',
      'button:has-text("Login")',
      'button:has-text("Acessar")',
      'button:has-text("Confirmar")',
      'button:has-text("Continuar")',
    ];
    let submitted = false;
    for (const sel of submitSelectors) {
      const btn = page.locator(sel).first();
      if ((await btn.count()) > 0) {
        await btn.click();
        submitted = true;
        await log("info", `Formulario enviado com: ${sel}`);
        break;
      }
    }
    if (!submitted) {
      await page.keyboard.press("Enter");
      await log("info", "Formulario enviado via Enter");
    }

    // Wait for navigation/redirect after login
    await page.waitForTimeout(5000);
    const postUrl = page.url();
    await log("success", `Login concluido | URL: ${postUrl}`);
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
  href: string; // direct URL to navigate — avoids overlay/click issues
}

async function detectSurveys(page: Page): Promise<SurveyItem[]> {
  try {
    const currentUrl = page.url();
    if (!currentUrl.includes("bigpesquisa.com/app")) {
      await page.goto("https://bigpesquisa.com/app", { waitUntil: "domcontentloaded", timeout: 20000 });
    }

    // Wait for the fade-in animation overlay to disappear
    await page.waitForSelector("div.animate-fade-in", { state: "detached", timeout: 8000 }).catch(() => {});

    // Wait until "Carregando..." is gone (SPA async loading)
    await page.waitForFunction(() => !document.body.innerText.includes("Carregando"), { timeout: 15000 }).catch(() => {});
    await sleep(3000);

    // Dump page HTML for debugging on first run
    try {
      const { writeFileSync } = await import("node:fs");
      const html = await page.content();
      writeFileSync("/tmp/bigpesquisa-app.html", html);
      await page.screenshot({ path: "/tmp/bigpesquisa-app.png", fullPage: true });
      await log("info", `App HTML salvo (${html.length} bytes)`);
    } catch { /* ignore */ }

    return await page.evaluate(() => {
      const results: Array<{ title: string; points: number; index: number; href: string }> = [];
      const seen = new Set<string>();
      const base = "https://bigpesquisa.com";

      // Strategy 1: find <a> tags whose href points to a survey/pesquisa URL
      const allLinks = Array.from(document.querySelectorAll("a[href]"));
      for (let i = 0; i < allLinks.length; i++) {
        const a = allLinks[i] as HTMLAnchorElement;
        const href = a.getAttribute("href") ?? "";
        const fullHref = href.startsWith("http") ? href : base + href;
        const text = a.textContent?.trim() ?? "";

        // Only accept bigpesquisa.com URLs — no external links (instagram, etc.)
        const isInternal =
          href.startsWith("/") ||
          fullHref.startsWith("https://bigpesquisa.com") ||
          fullHref.startsWith("http://bigpesquisa.com");
        if (!isInternal) continue;

        // Skip navigation links (home, login, etc.)
        if (href === "/" || href === "/app" || href === "/app/" || href.includes("login") || href.includes("entrar")) continue;
        if (text.length < 3) continue;

        // Only accept specific survey pages: /app/surveys/{id}/ (not the list /app/surveys/)
        // Exclude: /app/transactions/, /app/profile/, /app/rewards/, /app/embaixador/,
        //          /app/pesquisas-cpx/, /app/surveys/ (bare list)
        const EXCLUDED = ["/app/", "/app/surveys/", "/app/transactions/", "/app/profile/",
          "/app/rewards/", "/app/embaixador/", "/app/pesquisas-cpx/"];
        const isExcluded = EXCLUDED.includes(href) || EXCLUDED.includes(href + "/");
        const isSurveyLink = href.startsWith("/app/surveys/") && href !== "/app/surveys/" && href !== "/app/surveys";
        if (!isSurveyLink || isExcluded) continue;

        const fullText = a.closest("section, article, li, div[class*='card'], div[class*='item']")?.textContent?.trim() ?? text;

        // Extract points — handles "+100", "+100 BigPontos", "100 pts", etc.
        const pointsMatch = fullText.match(/\+\s*(\d+)\s*(?:BigPontos?|pontos?|pts)?/i)
          ?? fullText.match(/(\d+)\s*(?:BigPontos?|pontos?|pts)/i);
        const points = pointsMatch ? parseInt(pointsMatch[1], 10) : 0;

        // Extract best title: prefer heading inside card, fallback to link text
        const container = a.closest("section, article, li, div[class*='card'], div[class*='item']");
        const headingEl = container?.querySelector("h1,h2,h3,h4,strong,p");
        const title = (headingEl?.textContent?.trim() || text).slice(0, 80);

        if (seen.has(fullHref)) continue;
        seen.add(fullHref);

        results.push({ title, points, index: i, href: fullHref });
      }

      // Strategy 2: if no links found, look for survey cards with BigPonto mentions
      if (results.length === 0) {
        const cards = Array.from(document.querySelectorAll(
          "article, li[class], div[class*='card'], div[class*='survey'], div[class*='pesquisa'], section"
        ));
        for (let i = 0; i < cards.length; i++) {
          const card = cards[i];
          const text = card.textContent?.trim() ?? "";
          if (text.length < 5) continue;
          const hasPoints = text.includes("BigPonto") || /\d+\s*(pontos?|pts)/i.test(text);
          if (!hasPoints) continue;

          // Find clickable link inside card
          const innerLink = card.querySelector("a[href]") as HTMLAnchorElement | null;
          const href = innerLink?.getAttribute("href") ?? "";
          const fullHref = href.startsWith("http") ? href : href ? base + href : "";

          const pointsMatch = text.match(/\+\s*(\d+)\s*(?:BigPontos?|pontos?|pts)?/i)
            ?? text.match(/(\d+)\s*(?:BigPontos?|pontos?|pts)/i);
          const points = pointsMatch ? parseInt(pointsMatch[1], 10) : 0;

          const headingEl = card.querySelector("h1,h2,h3,h4,strong,p");
          const title = (headingEl?.textContent?.trim() ?? `Pesquisa ${i + 1}`).slice(0, 80);

          if (seen.has(title)) continue;
          seen.add(title);
          results.push({ title, points, index: i, href: fullHref });
        }
      }

      return results.slice(0, 10);
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
    const context = page.context();

    // Navigate directly to survey URL (avoids overlay/animation click issues)
    if (!survey.href) {
      await log("warn", `Sem href para: "${survey.title}" — pulando`);
      return;
    }

    await log("info", `Navegando para: ${survey.href}`);

    let activePage: Page = page;

    // Some survey links open in a new tab — listen before navigating
    const newPagePromise = context.waitForEvent("page", { timeout: 6000 }).catch(() => null);

    await page.goto(survey.href, { waitUntil: "domcontentloaded", timeout: 25000 }).catch(async () => {
      // If goto fails, it may have opened in new tab
    });

    await sleep(2000);

    // Check if a new tab opened instead
    const newPage = await newPagePromise;
    if (newPage && !newPage.isClosed()) {
      await newPage.waitForLoadState("domcontentloaded").catch(() => {});
      await sleep(2000);
      await log("info", `Nova aba aberta: ${newPage.url()}`);
      activePage = newPage;
    }

    const urlAfter = activePage.url();
    await log("info", `URL pesquisa: ${urlAfter}`);

    // Screenshot and DOM dump after clicking survey
    try {
      const { writeFileSync } = await import("node:fs");
      await activePage.screenshot({ path: "/tmp/bigpesquisa-survey.png", fullPage: false });
      const bodySnippet = await activePage.evaluate(() => document.body.innerHTML.slice(0, 1000)).catch(() => "err");
      writeFileSync("/tmp/bigpesquisa-survey-body.txt", bodySnippet);
      await log("info", `DOM pesquisa: ${bodySnippet.slice(0, 300)}`);
    } catch { /* ignore */ }

    // If we got rate-limited or blocked, wait and skip
    const pageStatus = await activePage.evaluate(() => {
      const t = document.body.innerText ?? "";
      if (t.includes("429") || t.includes("Too Many") || t.includes("403") || t.includes("blocked")) return "blocked";
      return "ok";
    }).catch(() => "ok");

    if (pageStatus === "blocked") {
      await log("warn", `Pesquisa "${survey.title}" bloqueada (429/403) — aguardando 30s`);
      await sleep(30000);
      return;
    }

    // Wait for the survey landing page content to fully load (Next.js SPA)
    await activePage.waitForFunction(
      () => !document.body.innerText.includes("Carregando"),
      { timeout: 12000 }
    ).catch(() => {});
    await sleep(2000);

    // Log full landing page body for debugging
    const landingBody = await activePage.evaluate(() => document.body.innerText.slice(0, 500)).catch(() => "");
    await log("info", `Landing page: ${landingBody.slice(0, 300)}`);

    // Click "Começar / Participar / Iniciar / Responder" button on landing page
    const startClicked = await activePage.evaluate(() => {
      const btns = Array.from(document.querySelectorAll("a, button"));
      const start = btns.find((b) => {
        const t = (b.textContent ?? "").toLowerCase().trim();
        return /^(começar|comecar|participar|iniciar|responder|start|entrar|ir para a pesquisa|abrir pesquisa|fazer pesquisa|acessar)/.test(t)
          || t.includes("começar") || t.includes("participar") || t.includes("iniciar");
      });
      if (start) { (start as HTMLElement).click(); return (start as HTMLElement).textContent?.trim() ?? "ok"; }
      return null;
    });

    if (startClicked) {
      await log("info", `Botao inicio clicado: "${startClicked}"`);
      // Listen for new tab from this click
      const afterClickNewPage = activePage.context().waitForEvent("page", { timeout: 6000 }).catch(() => null);
      await activePage.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 10000 }).catch(() => {});
      await sleep(3000);
      const afterNewTab = await afterClickNewPage;
      if (afterNewTab && !afterNewTab.isClosed()) {
        await afterNewTab.waitForLoadState("domcontentloaded").catch(() => {});
        await sleep(2000);
        await log("info", `Nova aba (inicio): ${afterNewTab.url()}`);
        activePage = afterNewTab;
      }
      await log("info", `URL apos inicio: ${activePage.url()}`);
    } else {
      await log("info", "Nenhum botao de inicio encontrado — tentando responder diretamente");
    }

    // Check for iframe that contains the survey
    const hasIframe = await activePage.locator("iframe").count() > 0;
    if (hasIframe) {
      await log("info", "Survey em iframe detectado");
    }

    // Save full HTML for debugging (first 6000 chars)
    const surveyHtmlFull = await activePage.evaluate(() => document.body.innerHTML.slice(0, 6000)).catch(() => "");
    try { require("fs").writeFileSync("/tmp/bigpesquisa-survey-full.html", surveyHtmlFull); } catch {}

    // Wait for actual survey question content to appear (not just the app shell header)
    // Strategy: wait until there's meaningful non-header text (> 100 chars outside header/nav)
    await activePage.waitForFunction(
      () => {
        const mainEl = document.querySelector("main, [class*='main'], [id*='main'], [class*='content'], form");
        if (mainEl && (mainEl.textContent?.trim().length ?? 0) > 20) return true;
        // Fallback: body has substantial text beyond just the header
        const bodyText = document.body.innerText ?? "";
        const lines = bodyText.split("\n").map(l => l.trim()).filter(l => l.length > 5);
        return lines.length > 5;
      },
      { timeout: 12000 }
    ).catch(() => {});
    await sleep(2000);

    // Log what we see now
    const surveyBodyPreview = await activePage.evaluate(() => document.body.innerText?.slice(0, 600) ?? "").catch(() => "");
    await log("info", `Survey body: ${surveyBodyPreview.slice(0, 400)}`);

    // Answer all questions
    let questionCount = 0;
    const MAX_QUESTIONS = 80;
    let consecutiveNoQuestion = 0;
    let reallyDone = false;

    while (questionCount < MAX_QUESTIONS && !stopRequested) {
      const result = await answerCurrentQuestion(activePage);

      if (result === "done") {
        reallyDone = true;
        state.phase = "claiming";
        await log("success", `Pesquisa "${survey.title}" concluida com ${questionCount} respostas!`);
        await sleep(3000);
        break;
      }

      if (result === "no_question") {
        consecutiveNoQuestion++;

        // Take a screenshot after first miss to understand the state
        if (consecutiveNoQuestion === 1) {
          try {
            await activePage.screenshot({ path: "/tmp/bigpesquisa-noquestion.png", fullPage: false });
            const snippet = await activePage.evaluate(() => ({
              url: location.href,
              title: document.title,
              body: document.body.textContent?.slice(0, 400) ?? "",
              html: document.body.innerHTML.slice(0, 600),
            })).catch(() => ({ url: "", title: "", body: "", html: "" }));
            await log("warn", `Sem pergunta | URL: ${snippet.url} | texto: ${snippet.body.slice(0, 200)}`);
          } catch { /* ignore */ }
        }

        if (consecutiveNoQuestion >= 4) {
          const url = activePage.url();
          if (
            url.includes("conclu") ||
            url.includes("obrigado") ||
            url.includes("finish") ||
            url.includes("complet") ||
            url.includes("encerr") ||
            url.includes("sucesso") ||
            url.includes("thank")
          ) {
            reallyDone = true;
            await log("success", `Pesquisa "${survey.title}" finalizada (URL conclusao)`);
            break;
          }
          await log("warn", `Sem perguntas detectadas apos ${questionCount} respostas. Desistindo.`);
          break;
        }
        await sleep(2000);
        continue;
      }

      consecutiveNoQuestion = 0;
      questionCount++;
      await sleep(800);
    }

    // Close new tab if opened
    if (newPage && !newPage.isClosed()) {
      await newPage.close().catch(() => {});
    }

    const duration = Math.round((Date.now() - start) / 1000);

    // Only count as truly completed if questions were answered or done signal received
    if (questionCount > 0 || reallyDone) {
      state.surveysCompleted++;
      state.pointsEarned += survey.points;
      await db.insert(surveysTable).values({
        title: survey.title,
        points: survey.points,
        status: "completed",
        durationSeconds: duration,
      });
      await log("success", `Concluida: ${questionCount} perguntas em ${duration}s | Total: ${state.pointsEarned} pts`);
    } else {
      await db.insert(surveysTable).values({
        title: survey.title,
        points: 0,
        status: "failed",
        durationSeconds: duration,
      });
      await log("warn", `Pesquisa "${survey.title}" nao respondida (0 perguntas detectadas)`);
    }

    // Return to survey list
    await page.goto("https://bigpesquisa.com/app", { waitUntil: "domcontentloaded", timeout: 20000 }).catch(() => {});
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
      .goto("https://bigpesquisa.com/app", { waitUntil: "domcontentloaded", timeout: 20000 })
      .catch(() => {});
  }
}

async function answerCurrentQuestion(page: Page): Promise<"answered" | "done" | "no_question"> {
  try {
    const data = await page.evaluate(() => {
      const bodyText = document.body.textContent ?? "";

      // ── Done signals ────────────────────────────────────────────────────────
      const doneWords = ["obrigado", "parabéns", "parabens", "concluída", "concluida",
        "finalizada", "completed", "encerrada", "sucesso", "thank you", "você ganhou",
        "voce ganhou", "pontos adicionados", "resgatado"];
      const isDone = doneWords.some((w) => bodyText.toLowerCase().includes(w));
      if (isDone) return { isDone: true, questionText: "", options: [], type: "done", optionEls: [] };

      // ── Question text ───────────────────────────────────────────────────────
      let questionText = "";
      const questionSelectors = [
        "legend",
        "[class*='question']", "[class*='pergunta']", "[class*='titulo']",
        "[class*='prompt']", "[class*='enunciado']",
        "label.title", "p.question",
        "h1", "h2", "h3", "h4",
        "p", "span",
      ];
      for (const sel of questionSelectors) {
        const els = Array.from(document.querySelectorAll(sel));
        for (const el of els) {
          // Skip elements inside app chrome (header, nav, footer)
          if (el.closest("header, nav, footer, [class*='header'], [class*='nav'], [class*='bottom-nav'], [class*='topbar']")) continue;
          // Skip style/script content
          if (el.closest("style, script, noscript")) continue;
          const t = el.textContent?.trim() ?? "";
          // Must look like a real question (meaningful length, not a nav label)
          if (t.length > 8 && t.length < 500) {
            questionText = t;
            break;
          }
        }
        if (questionText) break;
      }

      if (!questionText) return { isDone: false, questionText: "", options: [], type: "none", optionEls: [] };

      // ── Radio / Checkbox ────────────────────────────────────────────────────
      const radios = Array.from(document.querySelectorAll('input[type="radio"], input[type="checkbox"]'));
      if (radios.length > 0) {
        const radioOptions = radios.map((r) => {
          const label =
            r.closest("label") ??
            document.querySelector(`label[for="${(r as HTMLInputElement).id}"]`) ??
            r.parentElement;
          return label?.textContent?.trim() ?? (r as HTMLInputElement).value ?? "";
        }).filter(Boolean);
        return { isDone: false, questionText, options: radioOptions, type: "radio", optionEls: [] };
      }

      // ── Select ──────────────────────────────────────────────────────────────
      const select = document.querySelector("select");
      if (select) {
        const selectOptions = Array.from(select.options)
          .filter((o) => o.value !== "")
          .map((o) => o.textContent?.trim() ?? "");
        return { isDone: false, questionText, options: selectOptions, type: "select", optionEls: [] };
      }

      // ── Text input (check BEFORE clickable buttons — CEP, name, number fields) ──
      const textInput = document.querySelector(
        'input[type="text"], input[type="number"], input[type="tel"], input[inputmode="numeric"], input[inputmode="text"], textarea'
      );
      if (textInput) return { isDone: false, questionText, options: [], type: "text", optionEls: [] };

      // ── Styled button/div options (common in mobile survey apps) ────────────
      // Navigation words to exclude from option lists
      const NAV_WORDS = ["próximo", "proximo", "voltar", "anterior", "back", "next", "cancelar", "sair", "fechar"];
      const isNavBtn = (t: string) => NAV_WORDS.some((w) => t.toLowerCase().includes(w));

      const clickableGroups = [
        '[class*="option"]', '[class*="choice"]', '[class*="alternativa"]',
        '[class*="answer"]', '[class*="resposta"]',
        'li[class]', 'div[role="option"]', 'div[role="radio"]',
        'button:not([type="submit"])',
      ];
      for (const sel of clickableGroups) {
        const els = Array.from(document.querySelectorAll(sel));
        const texts = els
          .map((e) => e.textContent?.trim() ?? "")
          .filter((t) => t.length > 1 && t.length < 150 && !isNavBtn(t));
        // Accept 1-10 options (single-button screens like intro "Vamos lá!")
        if (texts.length >= 1 && texts.length <= 10) {
          return { isDone: false, questionText, options: texts, type: "clickable:" + sel, optionEls: [] };
        }
      }

      // ── Scale buttons (1-5, 1-10, NPS, stars) ──────────────────────────────
      const allButtons = Array.from(document.querySelectorAll("button"));
      const scaleButtons = allButtons.filter((b) => /^\d+$/.test(b.textContent?.trim() ?? ""));
      if (scaleButtons.length >= 3) {
        const nums = scaleButtons.map((b) => parseInt(b.textContent?.trim() ?? "0", 10));
        return { isDone: false, questionText, options: nums.map(String), type: "scale-btn", optionEls: [] };
      }

      // (text input already checked above, before clickable buttons)

      return { isDone: false, questionText: "", options: [], type: "none", optionEls: [] };
    });

    if (data.isDone) return "done";
    if (data.type === "none" || !data.questionText) return "no_question";

    const q = data.questionText;
    await log("info", `Pergunta: "${q.slice(0, 60)}" | tipo: ${data.type} | opcoes: ${data.options.length}`);

    // ── Answer by type ───────────────────────────────────────────────────────
    if (data.type === "text") {
      const answer = getTextAnswer(q);
      await page.locator('input[type="text"], input[type="number"], textarea').first().fill(answer);
      await log("info", `Texto: "${answer}"`);

    } else if (data.type === "radio") {
      const idx = pickBestOption(q, data.options);
      await page.evaluate((idx) => {
        const radios = Array.from(document.querySelectorAll('input[type="radio"], input[type="checkbox"]'));
        const t = radios[idx] as HTMLInputElement | undefined;
        if (t) { t.click(); t.checked = true; t.dispatchEvent(new Event("change", { bubbles: true })); }
      }, idx);
      await log("info", `Radio[${idx}]: "${data.options[idx]}"`);

    } else if (data.type === "select") {
      const idx = pickBestOption(q, data.options);
      await page.evaluate((idx) => {
        const s = document.querySelector("select") as HTMLSelectElement | null;
        if (s) {
          const o = Array.from(s.options).filter((x) => x.value !== "")[idx];
          if (o) { s.value = o.value; s.dispatchEvent(new Event("change", { bubbles: true })); }
        }
      }, idx);
      await log("info", `Select[${idx}]: "${data.options[idx]}"`);

    } else if (data.type === "scale-btn") {
      // Pick ~70th percentile
      const idx = Math.floor(data.options.length * 0.7);
      await page.evaluate((val) => {
        const btns = Array.from(document.querySelectorAll("button"));
        const t = btns.find((b) => b.textContent?.trim() === val);
        if (t) t.click();
      }, data.options[idx]);
      await log("info", `Escala: ${data.options[idx]}`);

    } else if (data.type.startsWith("clickable:")) {
      const sel = data.type.replace("clickable:", "");
      const idx = pickBestOption(q, data.options);
      const chosenText = data.options[idx];
      await page.evaluate(({ sel, chosenText }) => {
        const els = Array.from(document.querySelectorAll(sel));
        const t = els.find((e) => e.textContent?.trim() === chosenText);
        if (t) (t as HTMLElement).click();
      }, { sel, chosenText });
      await log("info", `Clicavel[${idx}]: "${chosenText}"`);
    }

    await sleep(600);

    // ── Advance to next question ─────────────────────────────────────────────
    const advanced = await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll("button, input[type='submit'], a"));
      const next = buttons.find((b) => {
        const t = (b.textContent ?? (b as HTMLInputElement).value ?? "").toLowerCase().trim();
        return /^(próximo|proximo|continuar|avançar|avancar|next|ok|confirmar|enviar|submit|ir|seguinte|responder|votar)$/.test(t)
          || t.startsWith("próxim") || t.startsWith("proxim") || t.startsWith("continu");
      });
      if (next) { (next as HTMLElement).click(); return (next as HTMLElement).textContent?.trim() ?? "found"; }

      const submit = document.querySelector('button[type="submit"], input[type="submit"]');
      if (submit) { (submit as HTMLElement).click(); return "submit"; }

      return null;
    });

    if (advanced) {
      await log("info", `Avancu: "${advanced}"`);
    } else {
      await log("warn", "Botao de avancar nao encontrado");
    }

    // Wait longer for page animation/transition between questions
    await page.waitForTimeout(3500);
    return "answered";
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await log("warn", `answerCurrentQuestion erro: ${msg.slice(0, 100)}`);
    return "no_question";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
