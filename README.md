# NextPM Adaptive

Full-stack implementation of the approved `NextPM_Adaptive_Developer_Handoff.html` prototype.
The product takes a minimum set of PM inputs plus an optional uploaded project description
document, asks an LLM to recommend a project governance model (Waterfall, Scrum, Kanban, Hybrid,
Iterative, Predictive/Stage-Gate, or another it justifies from evidence) with a confidence score
and alternatives, and — once the PM confirms one — generates a planning document pack the PM
reviews and approves.

**Core principle preserved from the handoff:** the agent verifies, recommends and drafts —
the PM confirms every decision and approves every baseline. Uploaded files never become
approved facts automatically, and the AI never applies a decision on its own.

## Stack

| Layer | Choice | Why |
| --- | --- | --- |
| Database | PostgreSQL 16 + Prisma ORM | Relational hierarchy (portfolio → program → project), JSON columns for recommendation snapshots |
| Backend | Node 20, TypeScript, Express, Zod | Modular services, one module per planning flow step |
| Frontend | React 18, TypeScript, Vite, TanStack Query | The prototype CSS is reused byte-for-byte in `frontend/src/styles/app.css` |
| Auth | JWT + bcrypt, role-based | Only PM roles can confirm governance models and approve outputs |
| AI | Anthropic Messages API, with a deterministic mock fallback | Runs with no API key for demos and tests — see "The two AI skills" below |

## Quick start (local)

```bash
# 1. Database
docker compose up -d db

# 2. Backend
cd backend
cp .env.example .env          # adjust DATABASE_URL / JWT_SECRET if needed
npm install
npx prisma migrate dev --name init
npm run db:seed               # 1 portfolio, 4 programs, 8 project workspaces
npm run dev                   # http://localhost:4000

# 3. Frontend (new terminal)
cd frontend
cp .env.example .env
npm install
npm run dev                   # http://localhost:5173
```

Seeded sign-in: `lina.vuong@nextpm.local` / `NextPM!2026`

### Everything in Docker

```bash
docker compose up --build     # web on :8080, api on :4000, db on :5432
```

### Enabling real AI generation

Set in `backend/.env`:

```
AI_PROVIDER=anthropic
ANTHROPIC_API_KEY=sk-ant-...
ANTHROPIC_MODEL=claude-sonnet-4-6
```

With `AI_PROVIDER=mock` (the default) the deterministic writers in
`backend/src/modules/ai/provider.ts` produce plausible recommendations and document content —
never invented facts, everything derivable is used, everything else is marked
`TBD — PM confirmation required` — so the whole flow runs with no API key. Swapping providers only
touches that one file.

## Project layout

```
nextpm/
├── backend/
│   ├── prisma/
│   │   ├── schema.prisma          # models covering the whole domain
│   │   └── seed.ts                # reproduces the prototype data set
│   └── src/
│       ├── data/                  # input schemas, document catalog, governance-model metadata
│       ├── modules/
│       │   ├── auth/              # login, JWT, roles
│       │   ├── portfolio/         # portfolio → program → project + readiness roll-up
│       │   ├── input/             # flow 1: values, verification, references, actions
│       │   ├── rules/             # flow 2: AI recommendation snapshot + PM decision gate
│       │   ├── documents/         # flow 3: catalog, templates, generation, approval, .docx/.html export
│       │   ├── dashboard/         # control-center aggregation + widget layout
│       │   ├── agent/             # planning agent conversation
│       │   ├── audit/             # traceable event log
│       │   └── ai/                # the two LLM "skills" — see below
│       ├── app.ts                 # route wiring, helmet, cors, rate limit
│       └── server.ts
├── frontend/
│   └── src/
│       ├── api/                   # typed client + endpoint map
│       ├── pages/
│       │   ├── PortfolioPage.tsx  # portfolio overview screen
│       │   └── workspace/         # DashboardView, InputView, ApproachView, StudioView, AgentDrawer
│       └── styles/app.css         # design system from the handoff, unchanged
├── docs/
│   ├── ARCHITECTURE.md
│   ├── API.md
│   └── DATA-MODEL.md
└── docker-compose.yml
```

## The three planning flows

**1 · Input & verify** — `InputFieldDefinition` drives a type-specific form (SI / SM / Product).
Values save as `PM_INPUT` and stay unverified until the PM runs *Verify input & continue*.
Optional reference files are classified, produce candidate values, and are flagged for PM
confirmation — never applied silently. A separate, optional **project description document**
(PDF/DOCX/TXT) is read for its actual text on upload; the AI only reads that text once the PM
asks for a recommendation (flow 2), not on verify.

**2 · Governance model recommendation** — the PM asks the AI for a recommendation
(`modules/rules/rules.service.ts`'s `runEvaluation()`, calling Skill 1 —
`recommendGovernanceModel()` in `modules/ai/provider.ts`). It reads verified inputs plus the
project description document and returns a governance model, a 0-100 suitability score,
confidence level, reasons, evidence, risks and every scored alternative — as strict JSON, saved as
an `AiApproachSuggestion` snapshot. Confirming or overriding freezes the document pack (every
catalog document for the project type — existence no longer depends on which model was picked,
only structure does) as the generation contract.

**3 · Template, generate & approve** — the PM picks one of three PMBOK-aligned templates,
edits the section list, and generates (Skill 2). Only checked sections are written. A required
action item blocks generation of the document it guards. Generated documents download as real
`.docx`; the project overview dashboard downloads as a real, self-contained `.html`.

## The two AI skills

Two independent prompts, `backend/src/modules/ai/provider.ts`, never sent together:

- **Skill 1 — `recommendGovernanceModel()`.** Extraction + scoring + alternatives, per
  `instruction.md`/`SKILL.md`'s methodology-scoring section. Default candidate models and their
  display metadata live in `backend/src/data/governance-models.ts`.
- **Skill 2 — `generateDocument()` / `generateGovernanceArtifact()`.** Document drafting.
  `generateGovernanceArtifact()` covers the six documents required for every project regardless of
  model (Project Charter, Organization Chart, RACI Matrix, Communication Plan, Change / Escalation
  Flow, Risk Plan) using per-model structure guidance from `governance-models.ts`, and can return a
  `raciTable` / `riskRegister` for the two that need one. `generateDocument()` handles every other
  catalog document generically.

## Extending the governance-model list or a document's structure guidance

Everything both skills need is in `backend/src/data/governance-models.ts` — add a governance
model to `DEFAULT_GOVERNANCE_MODELS` + `GOVERNANCE_MODEL_META`, or a structure hint to
`GOVERNANCE_ARTIFACT_GUIDANCE`, and nothing else needs to change (unknown models/artifacts fall
back to a generic entry, so the app never breaks on an AI-proposed model outside the default list).

## Tests and checks

```bash
npm --workspace backend run lint     # tsc --noEmit
npm --workspace frontend run lint
npm --workspace backend run test     # readiness formula unit tests
```

## What is intentionally left as an integration point

- **Document parsing for the four classified reference groups** (Commitment, Scope, Organization,
  Schedule) — `extractCandidates()` in `input.service.ts` still returns fixed candidates. The
  project description document *is* parsed for real (`lib/extract-text.ts`, via `pdf-parse` /
  `mammoth`); wire the same approach into the classified groups if they need it too.
- **Organization Chart as a graphic** — rendered as a structured text/table representation in the
  `.docx` export today, not a graphical diagram; a real org-chart renderer would slot into
  `documents.service.ts`'s `renderDocumentDocx`.
- **Approved-baseline export** (`createExport`) still only records the job and returns approved
  content as JSON; it has not been upgraded to bundle a real multi-document package the way the
  per-document `.docx` / dashboard `.html` downloads were.
- **File storage** — uploads go to local disk via multer; switch `storageKey` to S3/Blob for production.
