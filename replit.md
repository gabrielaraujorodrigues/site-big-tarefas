# BigPesquisa Bot

Bot automático para o site bigpesquisa.com que faz login com número de telefone, detecta pesquisas disponíveis, responde automaticamente usando heurísticas inteligentes (sem OpenAI) e exibe tudo em um painel de controle web.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — rodar API (porta 8080)
- `pnpm run typecheck` — typecheck completo
- `pnpm run build` — typecheck + build
- `pnpm --filter @workspace/api-spec run codegen` — regenerar hooks e schemas Zod do OpenAPI
- `pnpm --filter @workspace/db run push` — aplicar schema no banco (só dev)
- Env obrigatório: `DATABASE_URL`, `BIGPESQUISA_PHONE`, `BIGPESQUISA_PASSWORD`

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- Automação: Playwright (playwright-core + @playwright/browser-chromium)
- DB: PostgreSQL + Drizzle ORM
- Frontend: React + Vite + TailwindCSS + shadcn/ui
- Validação: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (ESM bundle) — playwright-core é `external`

## Where things live

- `artifacts/api-server/src/lib/automation.ts` — motor de automação Playwright
- `artifacts/api-server/src/routes/automation.ts` — rotas REST da automação
- `artifacts/dashboard/src/pages/dashboard.tsx` — painel de controle
- `lib/api-spec/openapi.yaml` — contrato OpenAPI (fonte da verdade)
- `lib/db/src/schema/automation.ts` — tabelas: automation_logs, automation_surveys, automation_runs
- `lib/api-client-react/src/generated/api.ts` — hooks React Query gerados

## Architecture decisions

- **Heurísticas sem OpenAI**: perguntas de escala → 70° percentil, frequência → "às vezes", sim/não → análise de palavras-chave, texto → respostas pré-definidas em pt-BR
- **playwright-core como external no esbuild**: necessário porque o pacote tem dependências nativas que o bundler não consegue resolver
- **URLs relativas no frontend**: `/api/...` roteado pelo proxy Replit — funciona em dev e produção sem configuração extra
- **Chromium via @playwright/browser-chromium**: instalado como dependência runtime, postinstall baixa o binário

## Product

- Painel web com botão INITIALIZE / HALT ENGINE
- Terminal Stream: log de atividades em tempo real (polling 2s)
- Acquisition Ledger: histórico de pesquisas concluídas com pontos e duração
- Lifetime Metrics: total de pontos, pesquisas e taxa de sucesso
- O bot responde perguntas inteligentemente: escalas, múltipla escolha, sim/não, texto livre

## User preferences

- Automação deve funcionar quando publicado via Republish do Replit (não só no preview de dev)
- Sem OpenAI — usar heurísticas locais
- Login por número de telefone (BIGPESQUISA_PHONE), não email
- Repositório GitHub: gabrielaraujorodrigues/site-big-tarefas

## Gotchas

- **playwright-core DEVE ser external no build.mjs** — senão o esbuild falha tentando resolver `chromium-bidi`
- O binário do Chromium precisa estar instalado antes de iniciar automação. Em produção, o postinstall do `@playwright/browser-chromium` cuida disso.
- O `2>/dev/null` no script de build é necessário no Linux mas pode não funcionar em outros SOs
- Não usar `git push --force` no agente principal — operação destrutiva bloqueada

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
