import { env } from '../../config/env';
import { serviceUnavailable } from '../../lib/http-error';
import { tableSchema } from '../../data/table-documents';
import { DEFAULT_GOVERNANCE_MODELS } from '../../data/governance-models';

/**
 * Three independent LLM "skills", called at three different points in the planning flow —
 * their system prompts are never combined into one request:
 *
 * Skill 0 — extractInputValues(): reads the uploaded documents and answers the still-empty
 *   input fields from them. Called when the PM presses "Verify input", as stage 2 behind the
 *   deterministic matcher in lib/option-match.ts.
 * Skill 1 — recommendGovernanceModel(): reads verified inputs + the project description
 *   document and proposes a governance model with a confidence score, reasons, evidence,
 *   risks and scored alternatives. Called once the PM asks for a recommendation.
 * Skill 2 — generateDocument() / generateGovernanceArtifact(): drafts one planning
 *   document's sections once the PM has confirmed a governance model.
 */

export interface GenerationContext {
  projectName: string;
  projectType: string;
  approach: string;
  rigor: string;
  documentName: string;
  /** Only PM-verified inputs are handed to the model. */
  verifiedInputs: { label: string; value: string }[];
  /** Why this governance model was recommended/confirmed — for grounding, not proof. */
  reasons: string[];
}

export interface GeneratedSection {
  title: string;
  content: string;
}

/**
 * A fact the document needs but the project data does not contain.
 *
 * The model writes `token` verbatim into the section text instead of guessing, and asks `question`.
 * Once the PM answers, "Fill out the document" substitutes the answer for that exact token — which
 * is why the token has to survive into the stored content untouched.
 */
export interface DocumentGap {
  token: string;
  question: string;
  answer?: string | null;
}

export interface GenerationOutput {
  sections: GeneratedSection[];
  gaps: DocumentGap[];
  /** Human-readable list of what was left blank — mirrors `gaps`, for the audit trail. */
  unresolved: string[];
  provider: AiProvider;
}

export interface RaciRow {
  activity: string;
  responsible: string;
  accountable: string;
  consulted: string;
  informed: string;
}

export interface RiskRow {
  risk: string;
  severity: 'Critical' | 'High' | 'Medium' | 'Low';
  owner: string;
  mitigation: string;
}

export interface GovernanceArtifactContext extends GenerationContext {
  /** One of GOVERNANCE_ARTIFACT_NAMES from data/governance-models.ts. */
  artifactName: string;
  /** Model-specific structure hint from data/governance-models.ts's mapping table. */
  structureGuidance: string;
}

/**
 * One box on the org chart: the role, and who holds it. `person` may be a `{{gap:N}}` token —
 * an unnamed role is the normal state early in planning, and a box reading "[ answer needed ]"
 * is the honest rendering of it.
 */
export interface OrgChartNode {
  role: string;
  person: string;
  /** Marks a box the chart should emphasise — the PM, the sponsor, the single point of control. */
  lead?: boolean;
}

/** A team inside an organisation. `name` is null when the organisation has no sub-teams. */
export interface OrgChartGroup {
  name: string | null;
  nodes: OrgChartNode[];
}

/**
 * The org chart as data rather than prose, so it can be *drawn*.
 *
 * Columns are organisations — the customer, the delivery partner, us — laid out left to right, the
 * same shape the SKAX kickoff deck uses for its own chart. That is the layout PMs in this domain
 * read, and it is what "who is on the other side of this project" actually looks like; a tree with
 * one root cannot express it.
 */
export interface OrgChart {
  columns: { organisation: string; groups: OrgChartGroup[] }[];
}

/**
 * A register-style document: the table *is* the deliverable. `columns` is echoed back from the
 * schema it was asked for so the renderer never has to guess the header row, and every cell is a
 * plain string that may hold a `{{gap:N}}` token.
 */
export interface DocumentTable {
  columns: string[];
  rows: string[][];
}

export interface GovernanceArtifactOutput extends GenerationOutput {
  raciTable?: RaciRow[];
  riskRegister?: RiskRow[];
  orgChart?: OrgChart;
  table?: DocumentTable;
}

export interface GovernanceRecommendationField {
  fieldKey: string;
  label: string;
  options: string[];
}

export interface GovernanceRecommendationContext {
  projectName: string;
  projectType: string;
  verifiedInputs: { label: string; value: string }[];
  /** Extracted text from the uploaded project description document, if any. */
  documentText: string | null;
  /** That document's file name, so a piece of evidence can say which file it came from. */
  documentName?: string | null;
  fields: GovernanceRecommendationField[];
}

export interface GovernanceAlternative {
  approach: string;
  score: number;
  rationale: string;
}

/**
 * Which writer actually produced a result. Every call below falls back to the deterministic mock
 * when the API errors, so without this the caller cannot tell a real recommendation from a
 * keyword heuristic — and neither can the PM.
 */
export type AiProvider = 'anthropic' | 'mock';

/**
 * One piece of evidence behind a recommendation, in both languages.
 *
 * The app's interface is English, so `english` is what the screen reads. `original` is the same
 * sentence exactly as the source writes it, kept because that — and only that — is what lets a PM
 * or an auditor find it in the uploaded file; a translation cannot be searched for in a Korean
 * document. `source` names the file or the verified input it came from, which the UI shows in bold
 * red, since evidence whose provenance is unstated is not evidence.
 */
export interface EvidenceItem {
  english: string;
  /** Omitted when the source is already English — there is nothing to show twice. */
  original?: string;
  source: string;
}

/** One block of the Planning Review's top panel — what the project *is*, read from its documents. */
export interface OverviewSection {
  /** Stable key so the UI can pick an icon and an order: scope, requirements, resources… */
  key: string;
  label: string;
  /** One or two sentences. The headline a PM reads first. */
  summary: string;
  /** The specifics behind it, one short line each — this is what stops the panel being a wall of prose. */
  points: string[];
}

/** Something the project still lacks before it can start. */
export interface PlanningGap {
  title: string;
  /** Why it matters for *this* project, not a generic definition of the artefact. */
  why: string;
  /**
   * The catalog document that would close it, named exactly as the catalog names it. This is the
   * link that lets the Planning Studio show only what is missing — a gap the model cannot tie to a
   * document is still shown to the PM, it just filters nothing.
   */
  documentName: string | null;
  severity: 'HIGH' | 'MEDIUM' | 'LOW';
}

/** A contradiction or anomaly found across the uploaded documents. */
export interface AnalysisFinding {
  title: string;
  detail: string;
  /** Where it was seen, so the PM can go and look rather than take it on trust. */
  evidence: EvidenceItem[];
}

/** One governance model scored against the nine criteria. */
export interface ScoredApproach {
  approach: string;
  score: number;
  reasons: string[];
  /**
   * Empty when the PM had already chosen the approach: there we are explaining a decision the PM
   * made, not making a case for one, so quoting the documents back at them is noise.
   */
  evidence: EvidenceItem[];
  /** Per-criterion breakdown, so a score is auditable rather than a number to take on faith. */
  criteria: { name: string; score: number; weight: number; note: string }[];
}

export interface PlanningAnalysisOutput {
  /**
   * RECOMMENDED — the PM had no approach in mind, so the model proposes one and ranks up to four.
   * PM_CHOSEN  — the PM named one on Project Input, so the model only scores that one.
   */
  mode: 'RECOMMENDED' | 'PM_CHOSEN';
  overview: OverviewSection[];
  approaches: ScoredApproach[];
  planningGaps: PlanningGap[];
  findings: AnalysisFinding[];
  summary: string;
  confidenceLevel: 'HIGH' | 'MEDIUM' | 'LOW';
  /**
   * The organisation this project is delivered FOR, read from the same documents.
   *
   * Folded into this call rather than left as its own: it used to ride along with "Verify input",
   * and removing that button would otherwise have silently killed the customer proposal — which
   * gates the customer checklist and whose kickoff template gets filled. Still a *candidate*, never
   * applied: the PM accepts it on the banner exactly as before.
   */
  customer: { name: string; evidence: string } | null;
  provider: AiProvider;
}

export interface GovernanceRecommendationOutput {
  candidates: { fieldKey: string; value: string }[];
  recommendedApproach: string;
  confidence: number;
  confidenceLevel: 'HIGH' | 'MEDIUM' | 'LOW';
  rationale: string;
  reasons: string[];
  evidence: EvidenceItem[];
  risks: string[];
  alternatives: GovernanceAlternative[];
  summary: string;
  provider: AiProvider;
}

/** Skill 0 — reading uploaded documents to prefill the input form. */
export interface InputExtractionField {
  fieldKey: string;
  label: string;
  fieldType: string;
  options: string[];
}

export interface InputExtractionContext {
  projectName: string;
  projectType: string;
  /** One entry per uploaded file that text could be read from. */
  documents: { label: string; text: string }[];
  /** Only fields that are still empty — the PM's own answers are never overwritten. */
  fields: InputExtractionField[];
}

export interface InputExtractionOutput {
  values: { fieldKey: string; value: string; evidence?: string }[];
  /**
   * The organisation the project is delivered *for*, if the documents say so unambiguously.
   * A proposal, never a decision: the caller stores it as a suggestion for the PM to confirm.
   */
  customer?: { name: string; evidence: string } | null;
  provider: AiProvider;
}

/** One earlier turn of the same chat, replayed so follow-up questions make sense. */
export interface AgentTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface AgentReplyContext {
  /** The whole project as text — inputs, governance decision, documents. Built by agent.service. */
  projectContext: string;
  history: AgentTurn[];
  question: string;
}

/**
 * Output ceiling for every skill. Generous on purpose: current models think before answering and
 * that reasoning is billed against the same ceiling, so a tight budget does not save money — it
 * truncates the JSON mid-string and the whole call is wasted. Responses here are a few KB, so
 * this is a safety limit, not a target.
 */
const MAX_OUTPUT_TOKENS = 16000;

/**
 * `output_config.effort` steers how much the model thinks before answering. Returns an empty
 * object when AI_EFFORT is `off`, so the parameter is omitted rather than sent as a bad value.
 */
function outputConfig(): { output_config?: { effort: string } } {
  const effort = env.ai.effort.toLowerCase();
  if (effort === 'off' || effort === 'none') return {};
  return { output_config: { effort } };
}

interface AnthropicResponse {
  content: { type: string; text?: string }[];
  stop_reason?: string;
  stop_details?: { type: string; category?: string | null; explanation?: string } | null;
  usage?: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
}

async function callAnthropicJson<T>(params: { system: string; prompt: string; label: string }): Promise<T> {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': env.ai.anthropicKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: env.ai.model,
      max_tokens: MAX_OUTPUT_TOKENS,
      ...outputConfig(),
      system: params.system,
      messages: [{ role: 'user', content: params.prompt }],
    }),
  });

  if (!response.ok) {
    throw serviceUnavailable(`Anthropic API error ${response.status}: ${await response.text()}`);
  }

  const data = (await response.json()) as AnthropicResponse;

  // Token accounting per call. Without this there is no way to answer "what does one document
  // cost?" other than guessing — and no way to notice a prompt that quietly grew.
  if (data.usage) {
    // Logged raw, every field: a summary that drops a field is exactly how a billing surprise
    // hides (cache writes and server-tool use are billed but are not `output_tokens`).
    console.log(
      `[ai:usage] ${params.label} · ${env.ai.model} · effort=${env.ai.effort} · ${JSON.stringify(data.usage)}`,
    );
  }

  // Check why generation stopped before parsing. A truncated or declined response is still HTTP
  // 200, and parsing it first turns a diagnosable cause into "Unterminated string in JSON".
  // These are all "the model gave us nothing usable", never a fault in this server. Thrown as HTTP
  // errors so the reason survives to the screen: the calls with no mock fallback let them through,
  // and the error handler replaces any plain Error with "Unexpected server error" in production.
  if (data.stop_reason === 'max_tokens') {
    throw serviceUnavailable(
      `Anthropic response was truncated at the ${MAX_OUTPUT_TOKENS}-token ceiling, so the JSON is incomplete.`,
    );
  }
  if (data.stop_reason === 'refusal') {
    throw serviceUnavailable(
      `Anthropic declined this request (${data.stop_details?.category ?? 'unspecified'}): ${
        data.stop_details?.explanation ?? 'no explanation given'
      }`,
    );
  }

  // Only text blocks — a response may also carry thinking blocks, which are not the answer.
  const text = data.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text ?? '')
    .join('\n')
    .replace(/```json|```/g, '')
    .trim();

  if (!text) {
    throw serviceUnavailable(`Anthropic returned no text content (stop_reason: ${data.stop_reason ?? 'unknown'})`);
  }

  try {
    return JSON.parse(text) as T;
  } catch (error) {
    throw serviceUnavailable(
      `Anthropic returned text that is not valid JSON (${(error as Error).message}). First 200 chars: ${text.slice(0, 200)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Skill 2a — generic document draft (the ~15 non-governance-mandated documents)
// ---------------------------------------------------------------------------

/**
 * Shared across both Skill 2 prompts: the model owns the structure, and never fills a gap in the
 * project data with a plausible guess.
 */
/**
 * Shared by both Skill 2 prompts. Only reaches the model when the document being written has a
 * schema in `data/table-documents.ts`; the caller supplies the columns.
 */
const TABLE_DOCUMENT_RULES = `If this document is given a COLUMN LIST below, then the table IS the document:
- Return "table": { "columns": [...exactly the columns you were given, in that order...],
                    "rows": [ [cell, cell, ...], ... ] } — one array per row, one cell per column,
  every cell a plain string.
- Return "sections": [] — no prose, no introduction, no notes, no explanation of the table. The
  grid is the deliverable and anything around it is noise the PM asked not to receive.
- A cell you cannot fill from the project data is a "{{gap:N}}" token with a matching question,
  exactly as in prose. Never write "TBD", "N/A" or an invented name to fill a cell.
- Order the rows the way the document is read: a flow in step order, a log newest-first, a work
  breakdown in WBS ID order.
- Only rows the project data supports. A short honest table beats a padded one.`;

const NO_FABRICATION_RULES = `You decide the section structure yourself. Choose the sections this document type genuinely
needs for this project type and governance model, in a sensible reading order — do not pad it with
sections the project has no information for.

NEVER INVENT ANYTHING. This is the rule that matters most:
- Use only the verified inputs supplied. Never invent a date, name, number, owner, budget,
  system, vendor or organisation — not even a plausible-sounding example or placeholder name.
- When the document needs a fact the inputs do not contain, do NOT guess and do NOT write
  "TBD". Write the exact token "{{gap:N}}" (N = 1, 2, 3... unique across the whole document) at
  that spot in the sentence, and add a matching entry to "gaps" asking the PM for exactly that
  fact. Reuse the same token if the same fact is needed twice.
- The sentence around a token must still read naturally once the token is replaced by the answer,
  e.g. "The executive sponsor is {{gap:1}}." not "Executive sponsor: {{gap:1}} (to be confirmed)".
- Each gap question must be specific and answerable in one line ("Who is the executive sponsor?"),
  never a task ("Confirm the sponsor"). **Write every gap question in English**, whatever language
  the project data is in — the PM reads these in the application, and the application is English.
- You draft; the PM approves. Never state that anything is approved or baselined.

Write 2-5 sentences per section in professional PM English.`;

const SYSTEM_PROMPT = `You are the NextPM planning agent, drafting one planning document.

${NO_FABRICATION_RULES}

${TABLE_DOCUMENT_RULES}

- If the document's name mentions RACI, also return "raciTable": an array of
  { activity, responsible, accountable, consulted, informed } rows covering the project's key
  activities. A role you do not know is a gap token too. The prose sections then explain the
  matrix — do not repeat its rows as a list inside them.
- If the document is a kickoff deck, each section is ONE SLIDE. Write it as short lines, one point
  per line, never paragraphs — this is read in a room, on a screen. Aim for 4-6 lines a slide and
  8-12 slides covering, in this order: purpose and objective; scope in and out; the delivery team
  and who does what; schedule and milestones; ways of working (cadence, meetings, reporting);
  communication and escalation; risks and dependencies; and what happens next. Skip any of those
  the project data cannot support rather than padding it, and leave unknown names, dates and
  owners as gap tokens.

Return strict JSON and nothing else:
{ "sections": [{ "title": string, "content": string }],
  "gaps": [{ "token": "{{gap:1}}", "question": string }],
  "unresolved": string[], "raciTable"?: [...], "table"?: { "columns": [...], "rows": [[...]] } }
"unresolved" is a short plain-English list of what was left blank, for the audit trail.`;

/** The column list for a register-style document, or nothing for a prose one. */
function tableInstruction(documentName: string): string[] {
  const schema = tableSchema(documentName);
  if (!schema) return [];
  return [
    '',
    `COLUMN LIST for "${documentName}" — return a table with exactly these columns and no sections:`,
    schema.columns.map((column, index) => `  ${index + 1}. ${column}`).join('\n'),
    `Each row is ${schema.rowMeaning}`,
  ];
}

function buildPrompt(context: GenerationContext): string {
  const inputs = context.verifiedInputs.map((input) => `- ${input.label}: ${input.value}`).join('\n');
  const reasons = context.reasons.map((reason) => `- ${reason}`).join('\n');

  return [
    `Document to write: ${context.documentName}`,
    ...tableInstruction(context.documentName),
    `Project: ${context.projectName} · type ${context.projectType} · governance model ${context.approach} · ${context.rigor}`,
    '',
    'Verified inputs (your only source of facts):',
    inputs || '- none verified yet',
    '',
    'Why this governance model was chosen:',
    reasons || '- none recorded',
  ].join('\n');
}

/**
 * Deterministic stand-in used when no API key is configured, or when the call fails. It keeps the
 * same contract as the model — including leaving gaps rather than inventing facts — so the rest of
 * the flow (preview, answer, fill, export) behaves identically without a key.
 */
function mockGenerate(context: GenerationContext): GovernanceArtifactOutput {
  const lookup = new Map(context.verifiedInputs.map((input) => [input.label.toLowerCase(), input.value]));
  const pick = (...labels: string[]) => labels.map((label) => lookup.get(label.toLowerCase())).find(Boolean);

  const objective = pick('business objective', 'service objective', 'product vision');
  const measure = pick('success measure', 'target outcome');
  const window = pick('target dates', 'target window', 'service term', 'planning horizon');

  const gaps: DocumentGap[] = [];
  const unresolved: string[] = [];
  /** Mirrors the model's contract: a token in the prose plus a question, never a guess. */
  const gap = (question: string, label: string) => {
    const token = `{{gap:${gaps.length + 1}}}`;
    gaps.push({ token, question });
    unresolved.push(label);
    return token;
  };

  const sections: GeneratedSection[] = [
    {
      title: 'Purpose and objective',
      content: `${context.projectName} exists to ${objective ?? gap('What is the business objective of this project?', 'Business objective')}. Success is measured as ${measure ?? gap('How will success be measured?', 'Success measure')} within ${window ?? gap('What is the committed delivery window?', 'Target dates')}. The ${context.approach} governance model (${context.rigor}) was recommended by the AI and confirmed by the PM.`,
    },
    {
      title: 'Scope and boundaries',
      content: `In scope: the delivery needed to reach the stated objective under the confirmed ${context.approach} controls. Out of scope: anything not listed in the verified input profile. Scope changes follow the change control path attached to this governance model, with ${gap('Who approves a scope change?', 'Scope change approver')} as the approving authority.`,
    },
    {
      title: 'Milestones and acceptance',
      content: `Milestones derive from the committed window. Each carries an acceptance owner and exit criteria, and is complete only once its acceptance evidence is recorded. The final acceptance authority for this document is ${gap('Who is the final acceptance authority?', 'Acceptance authority')}.`,
    },
    {
      title: 'Risks and dependencies',
      content: `Key exposures flagged by the recommendation: ${context.reasons.filter((reason) => /depend|risk/i.test(reason)).join(', ') || 'none flagged'}. Every dependency needs a named owner and a fallback before this section can be approved.`,
    },
  ];

  // A register document is a table and nothing else — the mock has to produce that shape too, or
  // the no-key demo would show prose where the real path shows a grid.
  const schema = tableSchema(context.documentName);
  if (schema) {
    const rows = [0, 1].map((index) =>
      schema.columns.map((column, columnIndex) =>
        columnIndex === 0
          ? `${index + 1}`
          : gap(`For ${context.documentName} row ${index + 1}, what is the "${column}"?`, column),
      ),
    );
    return { sections: [], gaps, unresolved, table: { columns: schema.columns, rows }, provider: 'mock' };
  }

  // A RACI document exports as a spreadsheet, so the mock owes it rows as well as prose.
  if (/raci/i.test(context.documentName)) {
    const raciTable: RaciRow[] = [
      { activity: 'Day-to-day delivery of the agreed scope', responsible: 'Delivery lead', accountable: 'PM', consulted: 'Team', informed: 'Stakeholders' },
      { activity: 'Acceptance of completed work', responsible: 'PM', accountable: gap('Who accepts completed work?', 'Acceptance owner'), consulted: 'Delivery lead', informed: 'Team' },
      { activity: 'Escalation and change handling', responsible: 'PM', accountable: gap('Who is the escalation authority?', 'Escalation authority'), consulted: 'Delivery lead', informed: 'Stakeholders' },
    ];
    return { sections, gaps, unresolved, raciTable, provider: 'mock' };
  }

  return { sections, gaps, unresolved, provider: 'mock' };
}

/**
 * Returns `GovernanceArtifactOutput` rather than plain `GenerationOutput` because a catalog
 * document outside the six mandated artifacts can still carry a RACI table, and those export as a
 * spreadsheet, which needs the rows.
 */
export async function generateDocument(context: GenerationContext): Promise<GovernanceArtifactOutput> {
  if (env.ai.provider === 'anthropic' && env.ai.anthropicKey) {
    try {
      const result = await callAnthropicJson<Omit<GovernanceArtifactOutput, 'provider'>>({
        system: SYSTEM_PROMPT,
        prompt: buildPrompt(context),
        label: `skill2:document:${context.documentName}`,
      });
      return { ...result, gaps: result.gaps ?? [], unresolved: result.unresolved ?? [], provider: 'anthropic' };
    } catch (error) {
      console.error('[ai] falling back to mock generator:', error);
    }
  }
  return mockGenerate(context);
}

// ---------------------------------------------------------------------------
// Skill 2b — governance artifact draft (the 6 documents required for every model:
// Project Charter, Organization Chart, RACI Matrix, Communications Management Plan,
// Issue Escalation Procedure, Risk Management Plan). Structure varies by governance model.
// ---------------------------------------------------------------------------

const GOVERNANCE_ARTIFACT_SYSTEM_PROMPT = `You are the NextPM planning agent, drafting one governance artifact after the PM
has confirmed a governance model.
Follow the structure guidance given for this artifact under this governance model — it tells you
which sections this artifact needs.

${NO_FABRICATION_RULES}

${TABLE_DOCUMENT_RULES}

- If the artifact is "RACI Matrix", also return "raciTable": an array of
  { activity, responsible, accountable, consulted, informed } rows covering the project's key
  activities under this governance model's structure. A role you do not know is a gap token too.
- If the artifact is "Risk Management Plan", also return "riskRegister": an array of
  { risk, severity, owner, mitigation } rows (severity is one of Critical, High, Medium, Low).
- If the artifact is "Organization Chart", the deliverable IS the chart. Return "orgChart" and
  return "sections": [] — no prose, no narrative, no notes. The chart is:
    { "columns": [ { "organisation": string,
                     "groups": [ { "name": string|null,
                                   "nodes": [ { "role": string, "person": string, "lead"?: bool } ] } ] } ] }
  * One column per ORGANISATION involved, left to right: the customer first, then any partner or
    vendor, then the delivering team. This is a project org chart — who sits on each side of the
    engagement — not a single company's internal tree.
  * "groups" splits a column into named teams where that is real (e.g. "On-shore Team",
    "Off-shore Development Team"); use one group with "name": null when it is not.
  * "role" is the position ("Project Manager", "QA Lead"). "person" is who holds it — and a person
    you were not told about is a gap token, never a guess and never "TBD".
  * Mark "lead": true on the one box per column that holds decision authority.
  * Keep it to the roles this project's data actually supports. Do not pad it out.

Return strict JSON and nothing else:
{ "sections": [{ "title": string, "content": string }],
  "gaps": [{ "token": "{{gap:1}}", "question": string }],
  "unresolved": string[], "raciTable"?: [...], "riskRegister"?: [...], "orgChart"?: {...},
  "table"?: { "columns": [...], "rows": [[...]] } }`;

function buildGovernanceArtifactPrompt(context: GovernanceArtifactContext): string {
  const inputs = context.verifiedInputs.map((input) => `- ${input.label}: ${input.value}`).join('\n');
  const reasons = context.reasons.map((reason) => `- ${reason}`).join('\n');

  return [
    `Artifact: ${context.artifactName} for governance model ${context.approach}`,
    ...tableInstruction(context.artifactName),
    `Structure guidance for this artifact under this model: ${context.structureGuidance}`,
    `Project: ${context.projectName} · type ${context.projectType} · ${context.rigor}`,
    '',
    'Verified inputs (your only source of facts):',
    inputs || '- none verified yet',
    '',
    'Why this governance model was chosen:',
    reasons || '- none recorded',
  ].join('\n');
}

function mockGenerateGovernanceArtifact(context: GovernanceArtifactContext): GovernanceArtifactOutput {
  const base = mockGenerate(context);
  const lookup = new Map(context.verifiedInputs.map((input) => [input.label.toLowerCase(), input.value]));

  // Unknown roles and owners become gap tokens here too, so the table has the same "never guess"
  // behaviour as the prose and the same answers fill both.
  const gaps = [...base.gaps];
  const unresolved = [...base.unresolved];
  const gap = (question: string, label: string) => {
    const token = `{{gap:${gaps.length + 1}}}`;
    gaps.push({ token, question });
    unresolved.push(label);
    return token;
  };

  if (context.artifactName === 'RACI Matrix') {
    const raciTable: RaciRow[] = [
      { activity: 'Confirm governance model & baseline', responsible: 'PM', accountable: gap('Who is the accountable sponsor?', 'Sponsor'), consulted: 'Delivery lead', informed: 'Stakeholders' },
      { activity: 'Requirements / backlog management', responsible: gap('Who owns requirements / the backlog?', 'Backlog owner'), accountable: 'PM', consulted: 'Delivery team', informed: 'Sponsor' },
      { activity: `${context.approach} cadence & reporting`, responsible: 'Delivery lead', accountable: 'PM', consulted: 'Team', informed: 'Sponsor' },
      { activity: 'Risk & escalation handling', responsible: 'PM', accountable: 'Sponsor', consulted: gap('Who is the named risk owner?', 'Risk owner'), informed: 'Stakeholders' },
    ];
    return { ...base, gaps, unresolved, raciTable };
  }

  if (context.artifactName === 'Organization Chart') {
    // The chart is the whole deliverable, so the mock returns no prose either — matching the real
    // prompt, so the two paths produce the same shape of document.
    const customer = lookup.get('client') ?? lookup.get('customer') ?? 'Customer';
    const orgChart: OrgChart = {
      columns: [
        {
          organisation: customer,
          groups: [
            {
              name: null,
              nodes: [
                { role: 'Sponsor', person: gap('Who is the sponsor on the customer side?', 'Customer sponsor'), lead: true },
                { role: 'Business owner', person: gap('Who is the customer’s business owner?', 'Business owner') },
              ],
            },
          ],
        },
        {
          organisation: 'Delivery team',
          groups: [
            {
              name: null,
              nodes: [
                { role: 'Project Manager', person: gap('Who is the project manager?', 'Project manager'), lead: true },
                { role: 'Delivery lead', person: gap('Who is the delivery lead?', 'Delivery lead') },
                { role: 'QA lead', person: gap('Who is the QA lead?', 'QA lead') },
              ],
            },
          ],
        },
      ],
    };
    return { ...base, sections: [], gaps, unresolved, orgChart };
  }

  if (context.artifactName === 'Risk Management Plan') {
    const complexity = lookup.get('integration complexity') ?? lookup.get('technical uncertainty');
    const riskRegister: RiskRow[] = [
      {
        risk: complexity ? `Delivery risk from: ${complexity}` : gap('What is the main delivery risk?', 'Primary delivery risk'),
        severity: 'Medium',
        owner: gap('Who owns the primary delivery risk?', 'Risk owner'),
        mitigation: `Weekly review under the ${context.approach} risk cadence.`,
      },
      {
        risk: 'Scope/requirement change beyond agreed control',
        severity: 'Medium',
        owner: 'PM',
        mitigation: `Handled via this model's change control path (see the Change Management Plan).`,
      },
    ];
    return { ...base, gaps, unresolved, riskRegister };
  }

  return base;
}

export async function generateGovernanceArtifact(context: GovernanceArtifactContext): Promise<GovernanceArtifactOutput> {
  if (env.ai.provider === 'anthropic' && env.ai.anthropicKey) {
    try {
      const result = await callAnthropicJson<Omit<GovernanceArtifactOutput, 'provider'>>({
        system: GOVERNANCE_ARTIFACT_SYSTEM_PROMPT,
        prompt: buildGovernanceArtifactPrompt(context),
        label: `skill2:artifact:${context.artifactName}`,
      });
      return { ...result, gaps: result.gaps ?? [], unresolved: result.unresolved ?? [], provider: 'anthropic' };
    } catch (error) {
      console.error('[ai] falling back to mock governance artifact generator:', error);
    }
  }
  return mockGenerateGovernanceArtifact(context);
}

// ---------------------------------------------------------------------------
// Skill 0 — reading uploaded documents to prefill the input form
//
// Runs when the PM presses "Verify input", before and separately from Skill 1: this one only
// reads documents and answers form fields, it never scores a governance model.
// ---------------------------------------------------------------------------

const INPUT_EXTRACTION_SYSTEM_PROMPT = `You read project documents a PM uploaded (SOW, proposal, requirement list,
org chart, schedule...) and answer the fields of a project profile form from them.

Language:
- The documents may be in ANY language — Vietnamese, Korean, Japanese, English and others. Read
  them in their original language and never refuse for lack of a translation. Date and number
  formats are local too: "31/03/2027" is 31 March 2027, "1.000.000" is one million.
- The field list below is in English, and every SELECT option is a fixed identifier. Work out
  which option the document's meaning corresponds to, then return that option EXACTLY as written
  in the list, character for character. Never translate an option, reword it, or invent a new one.
  If no option fits the evidence, omit the field.
- For free-text fields, answer in **English** — this application's interface is English and every
  document it generates is written in English, so a Korean answer here would have to be translated
  again further down the line. Names are the exception: a person, a company, a system, a place or a
  product keeps the spelling the document uses. Never transliterate or translate a proper noun.
  Dates: return ISO format (YYYY-MM-DD), or "YYYY-MM-DD..YYYY-MM-DD" for a date range.

Rules you must never break:
- Answer a field ONLY when the document actually states or clearly implies it. Omit every field
  you are unsure about — a blank the PM fills in is far better than a confident wrong answer.
- Never infer a value from the field name, from typical industry practice, or from the other
  fields. Documents are your only source.
- "evidence" must be a short verbatim quote from the document, in its original language.

Also identify the CUSTOMER — the organisation this project is delivered FOR:
- It is the client, not the supplier. The company writing the proposal, staffing the team or
  signing as the vendor is NOT the customer. If a document is an FPT proposal to LG CNS, the
  customer is LG CNS.
- It is not a partner, a subcontractor, a system vendor, or a company merely mentioned in passing.
  A name that appears only inside a list of interfaces or third-party products is not the customer.
- Return the organisation's name as the document writes it, with no added suffix or expansion.
- Omit "customer" entirely unless the documents make it unambiguous. This is the one answer a
  wrong guess is most expensive on, so silence is strongly preferred to a plausible name.

Return strict JSON and nothing else:
{ "values": [{ "fieldKey": string, "value": string, "evidence": string }],
  "customer": { "name": string, "evidence": string } }
"customer" is optional — omit the key when the documents do not make it unambiguous.
Return { "values": [] } when the documents support no field at all.`;

function buildInputExtractionPrompt(context: InputExtractionContext): string {
  const fields = context.fields
    .map((field) =>
      `- ${field.fieldKey} (${field.label}, ${field.fieldType})${
        field.options.length ? `: must be exactly one of [${field.options.join(' | ')}]` : ''
      }`,
    )
    .join('\n');

  const documents = context.documents
    .map((document) => `--- ${document.label} ---\n${document.text}`)
    .join('\n\n');

  return [
    `Project: ${context.projectName} · type ${context.projectType}`,
    '',
    'Fields still empty — answer only these:',
    fields || '- none',
    '',
    'Uploaded documents (verbatim, may be truncated):',
    documents || '- no readable document was uploaded',
  ].join('\n');
}

/**
 * Stage 2 of extraction. The caller has already run the deterministic option matcher and passes
 * only the fields it could not resolve, so this call is as small as the remaining work.
 */
export async function extractInputValues(context: InputExtractionContext): Promise<InputExtractionOutput> {
  // No documents means nothing to read. Note this does *not* bail when every field is already
  // filled: the call still has a job then, identifying the customer.
  if (!context.documents.length) return { values: [], customer: null, provider: 'mock' };

  if (env.ai.provider === 'anthropic' && env.ai.anthropicKey) {
    try {
      const result = await callAnthropicJson<{
        values: InputExtractionOutput['values'];
        customer?: { name?: string; evidence?: string } | null;
      }>({
        system: INPUT_EXTRACTION_SYSTEM_PROMPT,
        prompt: buildInputExtractionPrompt(context),
        label: 'skill0:input-extraction',
      });
      // A customer without evidence is a guess wearing a citation's clothes — drop it.
      const customer =
        result.customer?.name?.trim() && result.customer.evidence?.trim()
          ? { name: result.customer.name.trim(), evidence: result.customer.evidence.trim() }
          : null;
      return { values: result.values ?? [], customer, provider: 'anthropic' };
    } catch (error) {
      console.error('[ai] input extraction failed, no values proposed:', error);
    }
  }

  // There is no useful mock for this: the deterministic matcher already ran and found nothing,
  // and guessing here would put invented values in front of the PM.
  return { values: [], customer: null, provider: 'mock' };
}

// ---------------------------------------------------------------------------
// Skill 2c — filling a customer's own document template
//
// Same no-fabrication contract as the other Skill 2 calls, applied to placeholders instead of
// prose: a blank the project data cannot answer becomes a {{gap:N}} token plus a question, so the
// deck reaches the PM with visible holes rather than invented names.
// ---------------------------------------------------------------------------

export interface TemplateFillContext {
  projectName: string;
  projectType: string;
  customerName: string;
  approach: string | null;
  documentType: string;
  verifiedInputs: { label: string; value: string }[];
  /** Supporting prose already approved for this project, so names and dates stay consistent. */
  relatedDocuments: { name: string; excerpt: string }[];
  /** The blanks in the customer's file, with where each appears so the model can read intent. */
  placeholders: { token: string; occurrences: number; locations: string[] }[];
}

export interface TemplateFillOutput {
  /** One entry per placeholder. `value` may itself contain `{{gap:N}}` tokens. */
  values: { token: string; value: string }[];
  gaps: DocumentGap[];
  unresolved: string[];
  provider: 'anthropic' | 'mock';
}

const TEMPLATE_FILL_SYSTEM_PROMPT = `You fill in a customer's own document template for one project. The template is
already designed — you are only supplying the text that goes into its blanks.

${NO_FABRICATION_RULES}

Applied to placeholders:
- Work out what each placeholder means from its own name and from the slides/pages it appears on.
- Fill it ONLY from the project data you are given. A person's name, an email address, a room, a
  date or a team member you were not told about is NOT something to invent — it becomes a gap.
- A placeholder that appears several times (a name and email repeated down a team table) still gets
  ONE value. If the project data names fewer people than the template has slots, fill the ones you
  know and make each remaining slot its own gap.
- Keep values short: these go into a slide or a spreadsheet cell, not a paragraph. A person
  placeholder gets a name, not a sentence.
- Write values in English, like every other document this application generates. A proper noun —
  a person's name, a company, a system, a place — keeps the spelling the project data uses; do not
  transliterate or translate one.
- **Every gap question is in English**, whatever language the template or the project data is in:
  the PM answers these inside the application, and the application is English.

Not every bracketed string is a blank. A large template also brackets its own **guidance and worked
examples** — "<The following section can be replaced with the project's own diagram>", "<Group
review or one-person review>", "<Weekly>", "<Describe how changes are approved>". Those show the PM
what belongs there; they are not gaps waiting on a fact.

So there are three things you can do with a token, and choosing the right one matters more than
filling everything:
1. **Fill it** when the project data actually answers it. This is the only case that produces a value.
2. **Omit it** when the project data does not answer it but the template's own text is sensible
   guidance or a reasonable example. An omitted token is left exactly as the template wrote it, so
   the PM keeps that guidance and can edit it. For a large template most tokens end up here — that
   is the correct outcome, not a failure.
3. **Make it a gap** only when the token names a specific project fact that MUST be this project's
   own — its name, code, dates, the PM, the customer, a signatory — and the data does not have it.
   Leaving the template's example there would be a lie about this project; a gap is honest.
Never turn a paragraph of guidance into a gap: that deletes advice and replaces it with a blank.

Return strict JSON and nothing else:
{ "values": [{ "token": string, "value": string }],
  "gaps": [{ "token": "{{gap:1}}", "question": string }],
  "unresolved": string[] }
Each placeholder you were given appears at most once in "values" — once if it is a blank to fill,
not at all if it is the template's own guidance. "gaps" describes the {{gap:N}} tokens you put
inside those values — the question must tell the PM precisely what to supply, naming the
placeholder it belongs to.`;

function buildTemplateFillPrompt(context: TemplateFillContext): string {
  const inputs = context.verifiedInputs.map((input) => `- ${input.label}: ${input.value}`).join('\n');
  const related = context.relatedDocuments
    .map((document) => `--- ${document.name} ---\n${document.excerpt}`)
    .join('\n\n');
  const placeholders = context.placeholders
    .map(
      (placeholder) =>
        `- ${placeholder.token} (appears ${placeholder.occurrences}× on ${placeholder.locations.join(', ')})`,
    )
    .join('\n');

  return [
    `Template: ${context.customerName}'s ${context.documentType}`,
    `Project: ${context.projectName} · type ${context.projectType}${
      context.approach ? ` · governance model ${context.approach}` : ''
    }`,
    '',
    'PM-verified project inputs (your only source of facts):',
    inputs || '- none verified yet',
    '',
    'Planning documents already written for this project (for consistent names and dates):',
    related || '- none yet',
    '',
    `Placeholders to fill (${context.placeholders.length}):`,
    placeholders,
  ].join('\n');
}

/**
 * How many placeholders go into one model call.
 *
 * The kickoff decks have 16 and 4 blanks and fit in a single call each. The house Project Plan
 * workbook has **274**, whose answers alone would run past the output ceiling and take the JSON
 * with them — so the blanks are filled in batches. The cost of batching is that the project context
 * is re-sent per batch (a kilobyte or so); the cost of not batching is a truncated response and a
 * wasted call, which is strictly worse.
 */
const PLACEHOLDERS_PER_CALL = 50;

/**
 * Gap tokens are numbered per call, so the second batch hands back another `{{gap:1}}` that would
 * collide with the first batch's — and a collision means one PM answer silently lands in two places.
 * Each batch's tokens are therefore remapped onto a fresh, strictly increasing global sequence,
 * inside the values as well as in the gap list, since the token is embedded in the text the PM
 * reads. Remapping rather than adding an offset is deliberate: a model that numbers its gaps
 * 1, 2, 5 would still collide under a simple `+3`.
 */
function renumberGaps(batch: Omit<TemplateFillOutput, 'provider'>, offset: number) {
  if (!offset) return batch;

  const mapping = new Map<string, string>();
  for (const gap of batch.gaps) {
    if (!mapping.has(gap.token)) mapping.set(gap.token, `{{gap:${offset + mapping.size + 1}}}`);
  }
  const shift = (text: string) =>
    text.replace(/\{\{gap:\d+\}\}/g, (token) => mapping.get(token) ?? token);

  return {
    values: batch.values.map((value) => ({ ...value, value: shift(value.value ?? '') })),
    gaps: batch.gaps.map((gap) => ({ ...gap, token: shift(gap.token) })),
    unresolved: batch.unresolved,
  };
}

export async function fillTemplatePlaceholders(context: TemplateFillContext): Promise<TemplateFillOutput> {
  if (!context.placeholders.length) return { values: [], gaps: [], unresolved: [], provider: 'mock' };

  if (env.ai.provider === 'anthropic' && env.ai.anthropicKey) {
    const values: TemplateFillOutput['values'] = [];
    const gaps: DocumentGap[] = [];
    const unresolved: string[] = [];
    let degraded = false;

    for (let index = 0; index < context.placeholders.length; index += PLACEHOLDERS_PER_CALL) {
      const slice = context.placeholders.slice(index, index + PLACEHOLDERS_PER_CALL);
      // Each batch is caught on its own. A failure on batch 4 of 6 must not throw away three calls
      // that already succeeded and were already paid for — those blanks stay filled, and only the
      // batch that failed degrades into visible, answerable gaps.
      let batch: Omit<TemplateFillOutput, 'provider'>;
      try {
        const result = await callAnthropicJson<Omit<TemplateFillOutput, 'provider'>>({
          system: TEMPLATE_FILL_SYSTEM_PROMPT,
          prompt: buildTemplateFillPrompt({ ...context, placeholders: slice }),
          label: `skill2c:template-fill:${context.documentType}:${index + 1}-${index + slice.length}`,
        });
        batch = { values: result.values ?? [], gaps: result.gaps ?? [], unresolved: result.unresolved ?? [] };
      } catch (error) {
        console.error(`[ai] template fill batch ${index + 1}-${index + slice.length} failed:`, error);
        degraded = true;
        batch = mockFillTemplate({ ...context, placeholders: slice });
      }

      const shifted = renumberGaps(batch, gaps.length);
      values.push(...shifted.values);
      gaps.push(...shifted.gaps);
      unresolved.push(...shifted.unresolved);
    }

    // `mock` here means "not all of this came from the model" — the PM must not read a partly
    // degraded fill as a complete one, which is the same reason Skill 1 carries its provenance.
    return { values, gaps, unresolved, provider: degraded ? 'mock' : 'anthropic' };
  }
  return mockFillTemplate(context);
}

/**
 * Every placeholder becomes a gap. That is not a cop-out: without a model there is nothing that
 * could legitimately answer "who is the QA lead", so the honest mock output is a deck full of
 * visible, answerable blanks — exactly what the PM would get from a real call that knew nothing.
 */
function mockFillTemplate(context: TemplateFillContext): TemplateFillOutput {
  const lookup = new Map(context.verifiedInputs.map((input) => [input.label.toLowerCase(), input.value]));
  const gaps: DocumentGap[] = [];
  const unresolved: string[] = [];

  const values = context.placeholders.map((placeholder) => {
    // The project name is the one thing the mock genuinely knows.
    if (/project\s*name/i.test(placeholder.token)) {
      return { token: placeholder.token, value: context.projectName };
    }
    const direct = lookup.get(placeholder.token.replace(/[[\]<>]/g, '').trim().toLowerCase());
    if (direct) return { token: placeholder.token, value: direct };

    const token = `{{gap:${gaps.length + 1}}}`;
    gaps.push({
      token,
      question: `What goes in ${placeholder.token} on ${placeholder.locations.join(', ')}?`,
    });
    unresolved.push(placeholder.token);
    return { token: placeholder.token, value: token };
  });

  return { values, gaps, unresolved, provider: 'mock' };
}

// ---------------------------------------------------------------------------
// Skill 3 — assessing the project against its customer's checklist
//
// Runs on "Re-assess readiness", and again (for the not-yet-MET items only) when a document is
// approved. Like Skill 0 it has NO mock fallback: a guessed "MET" would tell a PM that a customer
// requirement is covered when nothing covers it, which is worse than an honest UNKNOWN.
// ---------------------------------------------------------------------------

export type ChecklistVerdict = 'MET' | 'PARTIAL' | 'NOT_MET' | 'NOT_APPLICABLE' | 'UNKNOWN';

export interface ChecklistAssessmentContext {
  projectName: string;
  projectType: string;
  customerName: string;
  approach: string | null;
  /** PM-verified inputs only — the same "verified precedes everything" rule as the other skills. */
  verifiedInputs: { label: string; value: string }[];
  /** What has actually been produced, with enough text to be evidence rather than a title list. */
  documents: { name: string; status: string; excerpt: string }[];
  items: { id: string; section: string | null; text: string; guidance: string | null }[];
}

export interface ChecklistAssessmentOutput {
  verdicts: { id: string; status: ChecklistVerdict; evidence: string; reason: string }[];
  provider: 'anthropic' | 'none';
}

const CHECKLIST_ASSESSMENT_SYSTEM_PROMPT = `You audit one project against a checklist its customer requires. For each checklist
item, decide whether the project's own evidence shows the item is satisfied.

The checklist may be in any language (Korean, Vietnamese, English...). Read it in its original
language. **Write "evidence" and "reason" in English** — this application's interface is English and
the PM reads these on screen. The one exception is a verbatim quote: keep the quoted words exactly
as the source wrote them, inside quotation marks, and put your English rendering around them, so
the PM can still find the sentence in the file.

Status — choose exactly one per item:
- "MET": the supplied project evidence clearly satisfies the item. You must be able to point at
  the specific input or document section that does it.
- "PARTIAL": the evidence covers part of the item, or covers it but is not yet PM-approved.
- "NOT_MET": the evidence is sufficient to conclude the item is genuinely not covered yet.
- "NOT_APPLICABLE": the item cannot apply to this project — a different service type, or the
  checklist's own scope section excludes it.
- "UNKNOWN": you cannot tell from what you were given. Use this freely.

Rules you must never break:
- The supplied inputs and documents are your ONLY source. Never assume a project does something
  because projects usually do, because the governance model implies it, or because the item sounds
  routine. That assumption is exactly how a readiness score becomes a lie.
- "MET" REQUIRES a quote or a named section from the evidence. If you cannot cite it, it is not MET.
- Prefer "UNKNOWN" to a confident guess. An honest blank costs a PM one look; a wrong "MET" costs
  them the finding at the customer's audit.
- "evidence" is a short verbatim quote or the exact name of the input/document section it rests on.
  For UNKNOWN and NOT_MET, say what would settle it instead.
- Return a verdict for EVERY item id you were given, and invent no ids.

Return strict JSON and nothing else:
{ "verdicts": [{ "id": string, "status": "MET"|"PARTIAL"|"NOT_MET"|"NOT_APPLICABLE"|"UNKNOWN",
                 "evidence": string, "reason": string }] }`;

// ---------------------------------------------------------------------------
// Checklist translation — run once, when a checklist is uploaded
//
// Not a "skill": it decides nothing and asserts nothing about a project. It exists because the
// application's interface is English while the checklists it audits against are usually Korean,
// and a PM cannot act on a requirement they cannot read. It runs at upload rather than at display
// time so the cost is paid once per file instead of once per viewer, and so an item's English
// reading belongs to the checklist itself rather than to one project's assessment.
//
// Like Skill 0 and Skill 3 it has no mock: an invented translation of a customer requirement is
// worse than the untranslated original, which the UI shows anyway.
// ---------------------------------------------------------------------------

export interface ChecklistTranslationItem {
  id: string;
  text: string;
  section?: string | null;
  guidance?: string | null;
}

export interface ChecklistTranslation {
  id: string;
  textEn?: string;
  sectionEn?: string;
  guidanceEn?: string;
}

/** Same reasoning as Skill 3's batch size: the checklists we have fit in one call, a larger one degrades. */
const TRANSLATION_ITEMS_PER_CALL = 40;

const CHECKLIST_TRANSLATION_SYSTEM_PROMPT = `You translate a customer's project checklist into English for a project-management
application whose interface is English. The checklist is usually Korean, sometimes Vietnamese or
Japanese.

This is translation, not interpretation:
- Translate what the item says. Do not expand it, explain it, shorten it, or turn a question into
  an instruction. The PM will be audited against the original wording, so a "helpful" rewording is
  a defect.
- Keep the source's own terms of art where they are names rather than words: a system name, a
  document code, a standard (ISO 27001), a tool, a company. Do not transliterate a proper noun.
- An item already written in English needs no translation — omit it from your answer entirely.
- Keep it to one line per field, like the original.

Return strict JSON and nothing else:
{ "items": [{ "id": string, "textEn": string, "sectionEn": string, "guidanceEn": string }] }
Omit "sectionEn" / "guidanceEn" when that field was not supplied or is already English, and omit an
item completely when nothing about it needs translating. Never invent an id.`;

function buildChecklistTranslationPrompt(items: ChecklistTranslationItem[]): string {
  return [
    `Translate these ${items.length} checklist entries into English:`,
    ...items.map((item) =>
      [
        `- id ${item.id}`,
        `  text: ${item.text}`,
        item.section ? `  section: ${item.section}` : null,
        item.guidance ? `  note: ${item.guidance}` : null,
      ]
        .filter(Boolean)
        .join('\n'),
    ),
  ].join('\n');
}

export async function translateChecklistItems(items: ChecklistTranslationItem[]): Promise<ChecklistTranslation[]> {
  if (!items.length) return [];
  if (env.ai.provider !== 'anthropic' || !env.ai.anthropicKey) return [];

  const translated: ChecklistTranslation[] = [];
  for (let index = 0; index < items.length; index += TRANSLATION_ITEMS_PER_CALL) {
    const batch = items.slice(index, index + TRANSLATION_ITEMS_PER_CALL);
    try {
      const result = await callAnthropicJson<{ items?: ChecklistTranslation[] }>({
        system: CHECKLIST_TRANSLATION_SYSTEM_PROMPT,
        prompt: buildChecklistTranslationPrompt(batch),
        label: `checklist-translation:${batch.length}-items`,
      });
      translated.push(...(result.items ?? []));
    } catch (error) {
      // A failed batch leaves those items untranslated and the upload succeeds regardless: losing
      // the English reading is a blemish, losing the uploaded checklist over it is not.
      console.error('[ai] checklist translation batch failed, items stay in their own language:', error);
    }
  }
  return translated;
}

/**
 * Rewrites PM-facing questions into English.
 *
 * `PlanningDocument.pmQuestions` is written once, at generation time, so documents drafted before
 * the English rule existed hold questions in the project's own language — the prompt that produced
 * them cannot reach back and fix them. Regenerating would fix it too, but it costs a full drafting
 * call and throws away any answers the PM has already given; rewriting the question text keeps the
 * token and the answer exactly as they are.
 *
 * No mock, for the same reason as the other translation pass: a guessed question is worse than one
 * the PM can at least read in the original.
 */
export async function translateGapQuestions(
  items: { id: string; text: string }[],
): Promise<{ id: string; english: string }[]> {
  if (!items.length) return [];
  if (env.ai.provider !== 'anthropic' || !env.ai.anthropicKey) return [];

  const system = `You translate questions that a project manager is asked inside an English-language
application. The questions are currently written in another language (usually Korean).

- Translate the question, do not answer it, expand it or merge it with another.
- Keep every proper noun exactly as written: a person, company, system, product, place, or a
  bracketed placeholder such as [PM Name] or <Code of the project>. Never transliterate one.
- A question already in English needs no work — omit it from your answer.
- Keep it to a single line, phrased as a question the PM can answer in one sentence.

Return strict JSON and nothing else: { "items": [{ "id": string, "english": string }] }
Never invent an id.`;

  const prompt = [
    `Translate these ${items.length} questions into English:`,
    ...items.map((item) => `- id ${item.id}\n  ${item.text}`),
  ].join('\n');

  try {
    const result = await callAnthropicJson<{ items?: { id: string; english: string }[] }>({
      system,
      prompt,
      label: `gap-question-translation:${items.length}-questions`,
    });
    return result.items ?? [];
  } catch (error) {
    console.error('[ai] gap question translation failed, questions left as they are:', error);
    return [];
  }
}

function buildChecklistAssessmentPrompt(context: ChecklistAssessmentContext): string {
  const inputs = context.verifiedInputs.map((input) => `- ${input.label}: ${input.value}`).join('\n');
  const documents = context.documents
    .map((document) => `--- ${document.name} (${document.status}) ---\n${document.excerpt}`)
    .join('\n\n');
  const items = context.items
    .map((item) =>
      `- id ${item.id}${item.section ? ` · section: ${item.section}` : ''}\n  check: ${item.text}${
        item.guidance ? `\n  source note: ${item.guidance}` : ''
      }`,
    )
    .join('\n');

  return [
    `Project: ${context.projectName} · type ${context.projectType} · customer ${context.customerName}`,
    context.approach ? `Confirmed governance model: ${context.approach}` : 'No governance model confirmed yet.',
    '',
    'PM-verified project inputs (evidence):',
    inputs || '- none verified yet',
    '',
    'Planning documents produced so far (evidence, may be truncated):',
    documents || '- none generated yet',
    '',
    `Checklist items to assess (${context.items.length}):`,
    items,
  ].join('\n');
}

export async function assessChecklistItems(
  context: ChecklistAssessmentContext,
): Promise<ChecklistAssessmentOutput> {
  if (!context.items.length) return { verdicts: [], provider: 'none' };

  if (env.ai.provider === 'anthropic' && env.ai.anthropicKey) {
    try {
      const result = await callAnthropicJson<{ verdicts: ChecklistAssessmentOutput['verdicts'] }>({
        system: CHECKLIST_ASSESSMENT_SYSTEM_PROMPT,
        prompt: buildChecklistAssessmentPrompt(context),
        label: `skill3:checklist:${context.items.length}-items`,
      });
      return { verdicts: result.verdicts ?? [], provider: 'anthropic' };
    } catch (error) {
      console.error('[ai] checklist assessment failed, items left unknown:', error);
    }
  }

  // No mock: see the note above the prompt. Items simply stay UNKNOWN, and the UI says so.
  return { verdicts: [], provider: 'none' };
}

// ---------------------------------------------------------------------------
// Skill 1 — governance model recommendation (extraction + scoring + alternatives)
// ---------------------------------------------------------------------------

const GOVERNANCE_RECOMMENDATION_SYSTEM_PROMPT = `You are the NextPM planning agent. A PM has given you verified project inputs and,
optionally, the text of an uploaded project description document (SOW, brief, proposal...).
Your job has two parts:

1. Extract project characteristics: scope stability, requirement volatility, delivery
   predictability, customer involvement, contract/commercial model, compliance need,
   technical uncertainty, team/delivery setup, and risk/dependency complexity. Only use what
   the supplied inputs and document actually state or clearly imply — never invent a fact.

2. Score each governance model in ${DEFAULT_GOVERNANCE_MODELS.join(', ')} from 0-100 using these
   weighted dimensions: scope stability 20%, requirement volatility 15%, delivery predictability
   15%, customer involvement 10%, contract/commercial model 10%, compliance/governance 10%,
   technical uncertainty 10%, team/delivery setup 5%, risk/dependency profile 5%. A dimension you
   have no evidence for is left out of that model's score rather than guessed at 50%.
   Interpret the top score as: 90-100 very strong fit, 80-89 strong fit, 70-79 good fit,
   60-69 moderate fit, below 60 weak fit. If the top two models score within 10 points of each
   other and both score above 60, prefer HYBRID as the recommendation and explain the trade-off.
   You may recommend a model outside the default list (e.g. PRINCE2, Lean) only when the evidence
   clearly calls for it.

Language — the application's interface is English, whatever language the documents are in:
- Inputs and documents may be in ANY language (Vietnamese, Korean, Japanese, English...). Read
  them in their original language; never refuse for lack of a translation.
- Write the rationale, every reason and every risk in English. No exceptions: these are read on an
  English screen.
- Each piece of evidence carries BOTH languages. "english" is the statement in English, so the PM
  reads it without a translator. "original" is the same sentence copied VERBATIM from the source,
  in the source's own language, so it can be found in the file — omit "original" only when the
  source sentence is already English. "source" names where it came from: the exact document file
  name as given below, or the label of the verified input.
- Governance model codes and SELECT option strings are fixed identifiers: return them exactly as
  given, in English, character for character. Never translate or reword one.

Rules you must never break:
- Every reason and every piece of evidence must be traceable to a specific verified input or a
  specific statement in the document text. Never fabricate.
- List every alternative model you scored, not just the top one — do not hide options.
- This is an AI suitability assessment, not a statistical probability, and it is advisory only:
  the PM makes the final call.
Return strict JSON: { "recommendedApproach": one of the model codes, "confidence": number (0-100,
the suitability score), "confidenceLevel": "HIGH" | "MEDIUM" | "LOW", "rationale": string
(2-3 sentences), "reasons": string[] (key reasons, each traceable to evidence),
"evidence": [{ "english": string, "original": string (omit when the source is English),
"source": string }] (the specific inputs/document statements the reasons are grounded in),
"risks": string[] (risks or
limitations of the recommendation), "alternatives": [{ "approach": string, "score": number,
"rationale": string }] (every other model scored), "summary": string (one sentence describing what
was read), "candidates": [{ "fieldKey": string, "value": string }] (only for fields you can
confidently answer from the document text; for SELECT fields use one of the given options
verbatim) }`;

// ---------------------------------------------------------------------------
// Skill 1b — "Analyze planning needs"
//
// The single call behind the Planning Review screen, and the only model call on the path from
// Project Input to a document pack. It replaces the old two-button flow (Verify input, then
// Suggest governance model): the PM presses once, and everything the uploaded documents and the
// typed inputs can say is read in one pass.
//
// It answers four questions at once, because they are all read from the same material and splitting
// them would mean paying to read it four times:
//   1. what is this project (overview)
//   2. which governance model fits — or how well does the PM's own choice fit (approaches)
//   3. what is missing before it can start (planningGaps)
//   4. what contradicts itself in the documents (findings)
// ---------------------------------------------------------------------------

export interface PlanningAnalysisContext {
  projectName: string;
  projectType: string;
  /** What the PM typed on Project Input. Few fields now — most of the signal is in the documents. */
  inputs: { label: string; value: string }[];
  /** Every uploaded file that text could be read from, labelled by file name. */
  documents: { label: string; text: string }[];
  /**
   * The governance model the PM had already decided on, or null. This one value decides the whole
   * shape of the answer, which is why it is passed explicitly rather than hidden among the inputs.
   */
  preferredApproach: string | null;
  /** Catalog documents this project type can produce, so a gap can name one exactly. */
  catalogDocuments: string[];
}

/**
 * The nine criteria, as the project's own methodology definition states them.
 *
 * They had drifted: an earlier set weighted scope stability at 20% and requirement volatility at
 * 15%, which put a third of the score on one underlying question, while dropping two criteria
 * entirely — **work type** (a finite delivery against continuous operation) and **team experience
 * and culture**. Losing work type mattered most: it is the criterion that tells Kanban apart from
 * Scrum and Waterfall, and every SM project in this application is continuous operation by nature,
 * so the one question that decides their model was not being asked.
 *
 * Weights are equal by default, because the definition says so. Judging one criterion twice as
 * important as another needs a reason from the material, not a number chosen in advance — so the
 * only way a weight moves is the document itself insisting on it, and the model has to say so.
 */
const NINE_CRITERIA = `Score the model against these nine criteria and return the full breakdown. Each carries an EQUAL
weight of 11.1% by default — nine criteria, one hundred points:

1. Requirement clarity — is scope fixed, or still changing? Clear and stable leans Waterfall;
   vague or evolving leans Scrum.
2. Customer / end-user involvement — does this need a continuous feedback loop? Yes leans
   Scrum or Kanban; no leans Waterfall.
3. Time and budget constraint — a hard fixed deadline and budget, or flexible to value? Hard
   leans Waterfall; flexible leans Scrum.
4. Compliance and regulation — is there an audit trail or phase sign-off requirement (construction,
   pharmaceutical, financial)? Heavy compliance leans Waterfall or Hybrid.
5. Scale and number of teams — one small team, several, or many coordinating? One leans Scrum;
   many large teams lean SAFe or Hybrid.
6. Work type — does this project have a clear end (delivered once), or is it continuous operation
   and support? A clear end leans Waterfall; continuous flow leans Kanban.
7. Team experience and culture — is the team used to agile, and does the organisation run a
   traditional PMO? Agile-experienced leans Scrum; a traditional PMO leans Waterfall or Hybrid.
8. Technical and technology risk — is the stack proven, or experimental and R&D? Experimental
   leans Scrum or Kanban.
9. External parties — are vendors or subcontractors engaged on fixed milestones, an SOW per phase?
   Yes leans Waterfall or Hybrid.

Two rules on the weights, and both come from the methodology rather than from convenience:

- A criterion you have **no evidence for** is left out of the weighted total rather than guessed at
  50%. Set its weight to 0, say so in its note, and score the model on what remains — a number
  invented to fill a gap is worse than a smaller honest denominator.
- You **may** raise one criterion's weight above 11.1 when the material insists on it — an SOW that
  says "fixed price, fixed scope" genuinely makes the time and budget constraint weigh more than
  team culture does. Do it only on that kind of explicit evidence, say which sentence justified it
  in that criterion's note, and keep the weights of the criteria you did score adding to 100.`;

const OVERVIEW_RULES = `"overview" is what the project IS, read from the material you were given. Use these keys, in this
order, and omit any the material genuinely cannot support: "scope", "requirements", "schedule",
"resources", "stakeholders", "commercial", "constraints". Each entry has a one-or-two sentence
"summary" and 2-5 short "points" — a specific fact each, not a restatement of the summary. This is
read as a briefing, so a point is "Go-live committed for 31 March 2027", never "The schedule is
discussed in the document".`;

const GAP_RULES = `"planningGaps" is what this project still lacks before it can start — an escalation path nobody
has defined, no organisation chart, no decision log, no acceptance criteria. Judge it against what
the documents actually contain, never against a generic checklist of good practice: a gap you
cannot point at a hole for is not a gap. Set "documentName" to the catalog document that would
close it, copied EXACTLY from the list you are given, or null when none fits.

"None fits" is a normal answer and you must give it rather than reach. The name you choose is a
navigation target: the PM presses a button on this gap and is taken to that document to work on it,
so a near-miss sends them to the wrong document with no hint that it is wrong. If the gap is about a
work breakdown and the list has no work-breakdown document, the answer is null — never the
nearest-sounding entry, never the charter because it is the most general one. Only name a document
when producing THAT document is what would close THIS gap.

"findings" is different and must not be padded with gaps: it is where two documents contradict each
other, where a date or a number disagrees with another, where something is stated that cannot be
true. Each carries evidence quoting both sides. An empty "findings" is a perfectly good answer.

Also identify the CUSTOMER — the organisation this project is delivered FOR:
- It is the client, not the supplier. The company writing the proposal, staffing the team or
  signing as the vendor is NOT the customer. If a document is an FPT proposal to LG CNS, the
  customer is LG CNS.
- Not a partner, a subcontractor, a system vendor, or a company merely mentioned in passing.
- Return the name as the document writes it, with a short verbatim quote as evidence.
- Set "customer" to null unless the documents make it unambiguous. A wrong customer means the
  project is scored against the wrong checklist and another company's template gets filled with it,
  so silence is strongly preferred to a plausible name.`;

const PLANNING_ANALYSIS_RECOMMEND_PROMPT = `You are the NextPM planning agent. A PM has given you a project's documents and a few typed
inputs. They have NOT decided how to govern the project and are asking you to read everything and
advise them.

${NINE_CRITERIA}

Score every model in ${DEFAULT_GOVERNANCE_MODELS.join(', ')} and return the FOUR best, highest
first. You may include one outside that list only when the evidence clearly calls for it. Each
carries its reasons and its supporting evidence, because you are making a case the PM has to be
able to check.

A model's score is how well IT fits this project, judged on its own — the four do not compete for a
share of anything and their scores do not add to 100.

SAFE is conditional on scale. Recommend it only for genuinely multi-team work that needs
coordinating; on one team the overhead of an Agile Release Train buys nothing that Scrum does not
already give, so score it low and say why rather than offering it as one more option.

**The Hybrid rule.** If the two highest-scoring models are within 10 points of each other and both
score above 60, lead with HYBRID as the primary recommendation instead, and say in its reasons
exactly which half comes from which model and why the combination beats either alone. Two models
that fit almost equally well is evidence that the project has both characters in it — picking one
and discarding the other throws away half of what you read. Still return four entries, with HYBRID
first; the two close models stay in the list as the alternatives the PM can switch to.

${OVERVIEW_RULES}

${GAP_RULES}

Language — the interface is English whatever the documents are in:
- Write every summary, point, reason, gap and finding in English.
- Evidence carries both: "english" is your rendering, "original" is the sentence copied VERBATIM
  from the source in its own language (omit when the source is already English), and "source" names
  the document exactly as its file name is given to you.
- Governance model codes are fixed identifiers — return them exactly as written.

Never invent. Every point, reason and gap must be traceable to the supplied material; where it is
silent, say less rather than filling the space.

Return strict JSON and nothing else:
{ "mode": "RECOMMENDED",
  "summary": string (one sentence on what you read),
  "confidenceLevel": "HIGH" | "MEDIUM" | "LOW",
  "overview": [{ "key": string, "label": string, "summary": string, "points": string[] }],
  "approaches": [{ "approach": string, "score": number, "reasons": string[],
                   "evidence": [{ "english": string, "original": string, "source": string }],
                   "criteria": [{ "name": string, "score": number, "weight": number, "note": string }] }],
  "planningGaps": [{ "title": string, "why": string, "documentName": string|null,
                     "severity": "HIGH"|"MEDIUM"|"LOW" }],
  "findings": [{ "title": string, "detail": string,
                 "evidence": [{ "english": string, "original": string, "source": string }] }],
  "customer": { "name": string, "evidence": string } | null }`;

const PLANNING_ANALYSIS_ASSESS_PROMPT = `You are the NextPM planning agent. A PM has given you a project's documents, a few typed inputs,
and the governance model they have ALREADY decided to use. You are not choosing a model — that
decision is made. You are telling them how well their choice fits what you read.

${NINE_CRITERIA}

Return exactly ONE entry in "approaches": the model the PM named, with its weighted score, its
per-criterion breakdown, and the key reasons behind that score — the honest ones, including where
the fit is poor. Leave "evidence" as an empty array: the PM is not being sold this model, so
quoting their own documents back at them adds nothing. Do not propose alternatives, and do not
score any other model.

${OVERVIEW_RULES}

${GAP_RULES}

Language — the interface is English whatever the documents are in: write every summary, point,
reason, gap and finding in English. Findings still carry evidence, with "original" holding the
source sentence verbatim and "source" naming the document.

Never invent. Every point, reason and gap must be traceable to the supplied material.

Return strict JSON and nothing else:
{ "mode": "PM_CHOSEN",
  "summary": string,
  "confidenceLevel": "HIGH" | "MEDIUM" | "LOW",
  "overview": [{ "key": string, "label": string, "summary": string, "points": string[] }],
  "approaches": [{ "approach": string (the model the PM chose, exactly as given), "score": number,
                   "reasons": string[], "evidence": [],
                   "criteria": [{ "name": string, "score": number, "weight": number, "note": string }] }],
  "planningGaps": [{ "title": string, "why": string, "documentName": string|null,
                     "severity": "HIGH"|"MEDIUM"|"LOW" }],
  "findings": [{ "title": string, "detail": string,
                 "evidence": [{ "english": string, "original": string, "source": string }] }],
  "customer": { "name": string, "evidence": string } | null }`;

function buildPlanningAnalysisPrompt(context: PlanningAnalysisContext): string {
  const inputs = context.inputs.map((input) => `- ${input.label}: ${input.value}`).join('\n');
  const documents = context.documents
    .map((document) => `--- ${document.label} ---\n${document.text}`)
    .join('\n\n');

  return [
    `Project: ${context.projectName} · type ${context.projectType}`,
    context.preferredApproach
      ? `Governance model the PM has already decided on: ${context.preferredApproach}`
      : 'The PM has not decided on a governance model.',
    '',
    'What the PM typed:',
    inputs || '- nothing beyond the project name',
    '',
    'Catalog documents this project can produce (use these names verbatim in planningGaps):',
    context.catalogDocuments.map((name) => `- ${name}`).join('\n') || '- none',
    '',
    `Uploaded documents (${context.documents.length}, verbatim, may be truncated):`,
    documents || '- none uploaded',
  ].join('\n');
}

/**
 * Deliberately has **no mock fallback**. Every screen downstream — the overview, the advisory, the
 * gap list, and the document pack the Studio then filters — is built from this one answer, and a
 * keyword heuristic dressed up as an analysis would put invented gaps and an invented model in
 * front of the PM. A failure here is reported as a failure.
 */
export async function analyzePlanningNeeds(context: PlanningAnalysisContext): Promise<PlanningAnalysisOutput> {
  if (env.ai.provider !== 'anthropic' || !env.ai.anthropicKey) {
    throw serviceUnavailable(
      'Planning analysis needs a model, and this server is running on the deterministic mock: set AI_PROVIDER=anthropic and ANTHROPIC_API_KEY. There is no offline fallback here on purpose, because an invented analysis is worse than none.',
    );
  }

  const chosen = Boolean(context.preferredApproach);
  const result = await callAnthropicJson<Omit<PlanningAnalysisOutput, 'provider'>>({
    system: chosen ? PLANNING_ANALYSIS_ASSESS_PROMPT : PLANNING_ANALYSIS_RECOMMEND_PROMPT,
    prompt: buildPlanningAnalysisPrompt(context),
    label: `skill1b:planning-analysis:${chosen ? 'pm-chosen' : 'recommend'}`,
  });

  const approaches = (result.approaches ?? []).map((entry) => ({
    approach: String(entry.approach ?? '').trim(),
    score: Number(entry.score ?? 0),
    reasons: (entry.reasons ?? []).map(String),
    // The PM-chosen mode is defined by having no evidence; enforce it rather than trusting the model.
    evidence: chosen ? [] : normalizeEvidence(entry.evidence),
    criteria: (entry.criteria ?? []).map((criterion) => ({
      name: String(criterion.name ?? ''),
      score: Number(criterion.score ?? 0),
      weight: Number(criterion.weight ?? 0),
      note: String(criterion.note ?? ''),
    })),
  }));

  return {
    mode: chosen ? 'PM_CHOSEN' : 'RECOMMENDED',
    overview: result.overview ?? [],
    // One entry when the PM chose; at most four when we are advising.
    approaches: chosen ? approaches.slice(0, 1) : approaches.slice(0, 4),
    planningGaps: result.planningGaps ?? [],
    findings: (result.findings ?? []).map((finding) => ({
      title: String(finding.title ?? ''),
      detail: String(finding.detail ?? ''),
      evidence: normalizeEvidence(finding.evidence),
    })),
    summary: result.summary ?? '',
    confidenceLevel: result.confidenceLevel ?? 'MEDIUM',
    // A customer without a verbatim quote is a guess wearing a citation's clothes — drop it.
    customer:
      result.customer?.name?.trim() && result.customer.evidence?.trim()
        ? { name: result.customer.name.trim(), evidence: result.customer.evidence.trim() }
        : null,
    provider: 'anthropic',
  };
}

// ---------------------------------------------------------------------------
// Skill 1c — "Analyze the change"
//
// The delta call behind Change plan mode. It answers a different question from `analyzePlanningNeeds`
// and therefore has a different prompt: not "what is this project", but "against the analysis you
// already have, what moved, and what in the existing plan is now wrong".
//
// **The model returns only the delta; the server merges it** (`lib/merge-snapshot.ts`). That is what
// makes this cheap: a full re-analysis writes ~11k output tokens, of which the overwhelming majority
// is a restatement of what did not change. Output is the expensive half — roughly five times input —
// so cutting it is the only optimisation here that matters. It also means every panel downstream
// keeps receiving an ordinary `AiApproachSuggestion` and none of them needs to know this mode exists.
// ---------------------------------------------------------------------------

/** One block of the previous overview that the change has moved. */
export interface OverviewChange {
  key: string;
  label: string;
  /** What the previous analysis said, so the PM can see the movement rather than only the result. */
  previous: string;
  summary: string;
  points: string[];
}

/** A generated document the change has made out of date. */
export interface AffectedDocument {
  /** Copied exactly from the list of this project's generated documents. */
  documentName: string;
  /** Why *this* document is now wrong — specific, not "the plan changed". */
  reason: string;
  severity: 'HIGH' | 'MEDIUM' | 'LOW';
}

export interface PlanChangeImpact {
  summary: string;
  /** Empty when the change turned out not to move the picture of the project. */
  changedOverview: OverviewChange[];
  newGaps: PlanningGap[];
  /**
   * Indices into the numbered list of previous gaps the prompt was given — never titles. A gap
   * title is free text and matching it back by string silently drops the ones whose wording drifted.
   */
  closedGaps: number[];
  newFindings: AnalysisFinding[];
  approach: {
    /** False only when the evidence genuinely no longer supports the model in force. */
    stillFits: boolean;
    score: number;
    note: string;
    /** A model to consider instead. A suggestion only — the PM re-decides on Planning Review. */
    suggested: string | null;
  };
  affectedDocuments: AffectedDocument[];
  provider: AiProvider;
}

export interface PlanChangeContext {
  projectName: string;
  projectType: string;
  approach: string;
  /** What the PM wrote. At least one of this and `changedDocuments` is always present. */
  note: string | null;
  /**
   * Every document this change brings, each with the version it replaces where it replaces one.
   * A change is rarely a single file.
   */
  changedDocuments: {
    label: string;
    text: string;
    replaces: { label: string; text: string } | null;
  }[];
  /**
   * The project's other current documents, unchanged by this change.
   *
   * They are here because `newFindings` asks for contradictions between the new material and what
   * was already on file — and without them the model cannot see what is already on file, so it was
   * being asked for something it had no way to produce. A whole project's corpus is a few thousand
   * tokens, so this costs cents and makes the answer real.
   */
  otherDocuments: { label: string; text: string }[];
  previous: {
    summary: string;
    overview: OverviewSection[];
    gaps: PlanningGap[];
    findings: AnalysisFinding[];
  };
  /** Documents already generated for this project, by name — the only ones that can be affected. */
  generatedDocuments: string[];
  catalogDocuments: string[];
}

const PLAN_CHANGE_SYSTEM_PROMPT = `You are the NextPM planning agent. This project already has an analysis and a confirmed governance
model. The PM is telling you something has changed. Your job is NOT to analyse the project again —
it is to say precisely what has moved since the analysis you are shown, and what in the existing
plan is now wrong.

Report only differences. If a part of the picture is unchanged, leave it out entirely; an empty
array is a good answer and is much more useful than a restatement. A change you cannot point at
evidence for did not happen.

"changedOverview" — only blocks whose substance has moved. Reuse the block's existing "key". Put
what the previous analysis said in "previous" and the new reading in "summary", so the PM sees the
movement and not just the result.

"closedGaps" — the NUMBERS of previously listed gaps the change has closed, from the numbered list
you are given. Use the numbers, never the titles. A gap is closed only when the change actually
settles it, not when it becomes less urgent.

"newGaps" — gaps the change has opened. Same rules as before: point at a hole, name the catalog
document that would close it copied EXACTLY from the list, or null.

"newFindings" — new contradictions the change creates. Two places to look, and both matter:
between a new document and the version it replaces, where the two disagree about a date, a number
or a commitment; and between a new document and the material ALREADY ON FILE, which the change was
not written against and may now contradict. Quote both sides. Do not re-raise a contradiction the
previous analysis already listed.

"approach" — does the governance model in force still fit what the project has become? Set
"stillFits" false only when the evidence genuinely no longer supports it, and name an alternative in
"suggested". You are advising: the PM re-decides this themselves, so an honest "still fits" is the
expected answer and a gratuitous switch wastes their time.

"affectedDocuments" — the heart of this call. For each ALREADY GENERATED document, in the list you
are given, that the change makes wrong, say specifically WHY it is wrong: which section, date,
number or commitment no longer holds. "The plan changed" is not a reason. Copy the document name
exactly. A document the change does not touch must not appear.

Language: write everything in English whatever language the documents are in. Proper nouns keep the
spelling their document uses. Evidence carries "english", the verbatim "original" where the source
is not English, and "source" naming the file exactly.

Return strict JSON and nothing else:
{ "summary": string (one sentence: what changed, in the PM's terms),
  "changedOverview": [{ "key": string, "label": string, "previous": string, "summary": string, "points": string[] }],
  "newGaps": [{ "title": string, "why": string, "documentName": string|null, "severity": "HIGH"|"MEDIUM"|"LOW" }],
  "closedGaps": number[],
  "newFindings": [{ "title": string, "detail": string,
                    "evidence": [{ "english": string, "original": string, "source": string }] }],
  "approach": { "stillFits": boolean, "score": number, "note": string, "suggested": string|null },
  "affectedDocuments": [{ "documentName": string, "reason": string, "severity": "HIGH"|"MEDIUM"|"LOW" }] }`;

function buildPlanChangePrompt(context: PlanChangeContext): string {
  const overview = context.previous.overview
    .map((block) => `- [${block.key}] ${block.label}: ${block.summary}`)
    .join('\n');
  // Numbered, because `closedGaps` refers to these positions. One-based: it reads naturally in a
  // prompt and the server subtracts one when merging.
  const gaps = context.previous.gaps
    .map((gap, index) => `${index + 1}. ${gap.title} — ${gap.why}${gap.documentName ? ` [${gap.documentName}]` : ''}`)
    .join('\n');
  const findings = context.previous.findings.map((finding) => `- ${finding.title}: ${finding.detail}`).join('\n');

  return [
    `Project: ${context.projectName} · type ${context.projectType}`,
    `Governance model in force: ${context.approach}`,
    '',
    '=== THE ANALYSIS AS IT STANDS ===',
    context.previous.summary,
    '',
    'Overview:',
    overview || '- none recorded',
    '',
    'Open planning gaps (refer to these by NUMBER in "closedGaps"):',
    gaps || '- none recorded',
    '',
    'Findings already raised:',
    findings || '- none',
    '',
    'Documents already generated for this project (only these can be affected):',
    context.generatedDocuments.map((name) => `- ${name}`).join('\n') || '- none generated yet',
    '',
    'Catalog documents this project can produce (use these names verbatim in newGaps):',
    context.catalogDocuments.map((name) => `- ${name}`).join('\n') || '- none',
    '',
    '=== WHAT HAS CHANGED ===',
    context.note ? `The PM writes:\n${context.note}` : 'The PM has not written a note; the change is in the documents below.',
    '',
    context.changedDocuments.length
      ? context.changedDocuments
          .map((document) =>
            [
              `--- ${document.label}${document.replaces ? ` (a new version of "${document.replaces.label}")` : ' (new document)'} ---`,
              document.text,
            ].join('\n'),
          )
          .join('\n\n')
      : '- no document uploaded; the note above is the whole change',
    '',
    // Kept in their own block rather than beside each new version: they are NOT current, and a
    // model reading them as current would report the project's own history back as a contradiction.
    context.changedDocuments.some((document) => document.replaces)
      ? [
          '=== REPLACED VERSIONS (for comparison only — these are NOT current) ===',
          'Compare each new version against the one it replaces and report what actually differs.',
          'Do not re-describe what both versions already said.',
          '',
          context.changedDocuments
            .filter((document) => document.replaces)
            .map((document) => `--- ${document.replaces!.label} (replaced by ${document.label}) ---\n${document.replaces!.text}`)
            .join('\n\n'),
        ].join('\n')
      : '=== REPLACED VERSIONS ===\n- nothing was replaced; every document above is new',
    '',
    context.otherDocuments.length
      ? [
          '=== ALREADY ON FILE (current, unchanged by this change) ===',
          'Use these to judge whether the change contradicts what the project already holds.',
          '',
          context.otherDocuments.map((document) => `--- ${document.label} ---\n${document.text}`).join('\n\n'),
        ].join('\n')
      : '=== ALREADY ON FILE ===\n- nothing else is on file',
  ].join('\n');
}

/**
 * No mock fallback, for the same reason as `analyzePlanningNeeds` and one more besides: this call's
 * output flags documents the PM has already approved. An invented delta would put "out of date" on a
 * signed baseline, which is worse than saying nothing at all.
 */
export async function analyzePlanChange(context: PlanChangeContext): Promise<PlanChangeImpact> {
  if (env.ai.provider !== 'anthropic' || !env.ai.anthropicKey) {
    throw serviceUnavailable(
      'Change analysis needs a model, and this server is running on the deterministic mock: set AI_PROVIDER=anthropic and ANTHROPIC_API_KEY. There is no offline fallback here on purpose, because an invented impact would flag documents the PM has already approved.',
    );
  }

  const result = await callAnthropicJson<Omit<PlanChangeImpact, 'provider'>>({
    system: PLAN_CHANGE_SYSTEM_PROMPT,
    prompt: buildPlanChangePrompt(context),
    label: 'skill1c:plan-change',
  });

  const gapCount = context.previous.gaps.length;
  const generated = new Set(context.generatedDocuments.map((name) => name.trim().toLowerCase()));

  return {
    summary: String(result.summary ?? ''),
    changedOverview: (result.changedOverview ?? []).map((block) => ({
      key: String(block.key ?? ''),
      label: String(block.label ?? ''),
      previous: String(block.previous ?? ''),
      summary: String(block.summary ?? ''),
      points: (block.points ?? []).map(String),
    })),
    newGaps: result.newGaps ?? [],
    // Out-of-range indices are dropped rather than trusted: a stray number would otherwise close a
    // gap the model never meant to name, and nothing downstream could tell that had happened.
    closedGaps: [...new Set((result.closedGaps ?? []).map(Number))].filter(
      (index) => Number.isInteger(index) && index >= 1 && index <= gapCount,
    ),
    newFindings: (result.newFindings ?? []).map((finding) => ({
      title: String(finding.title ?? ''),
      detail: String(finding.detail ?? ''),
      evidence: normalizeEvidence(finding.evidence),
    })),
    approach: {
      stillFits: result.approach?.stillFits !== false,
      score: Number(result.approach?.score ?? 0),
      note: String(result.approach?.note ?? ''),
      suggested: result.approach?.suggested?.trim() ? result.approach.suggested.trim() : null,
    },
    // Only documents that actually exist. The flag drives an amber banner on a real document and a
    // PM action pointing at it, so a name the model invented would produce a dead end.
    affectedDocuments: (result.affectedDocuments ?? [])
      .map((entry) => ({
        documentName: String(entry.documentName ?? '').trim(),
        reason: String(entry.reason ?? '').trim(),
        severity: entry.severity === 'HIGH' || entry.severity === 'LOW' ? entry.severity : ('MEDIUM' as const),
      }))
      .filter((entry) => entry.documentName && entry.reason && generated.has(entry.documentName.toLowerCase())),
    provider: 'anthropic',
  };
}

function buildGovernanceRecommendationPrompt(context: GovernanceRecommendationContext): string {
  const inputs = context.verifiedInputs.map((input) => `- ${input.label}: ${input.value}`).join('\n');
  const fields = context.fields
    .map((field) => `- ${field.fieldKey} (${field.label})${field.options.length ? `: one of [${field.options.join(' | ')}]` : ''}`)
    .join('\n');

  return [
    `Project: ${context.projectName} · type ${context.projectType}`,
    '',
    'Verified project inputs:',
    inputs || '- none verified yet',
    '',
    'Fields you may propose values for from the document text:',
    fields || '- none',
    '',
    // The file name is given so "source" can name it exactly. Evidence that cites "the document"
    // is unverifiable the moment a second file is uploaded.
    `Project description document — file name "${context.documentName ?? 'uploaded document'}" (verbatim, may be truncated):`,
    context.documentText ?? '- no document uploaded — score from verified inputs only',
  ].join('\n');
}

const MODEL_KEYWORDS: Record<string, string[]> = {
  WATERFALL: ['fixed price', 'fixed scope', 'waterfall', 'milestone sign-off', 'formal baseline', 'sequential phase', 'fixed launch date'],
  SCRUM: ['scrum', 'sprint', 'backlog', 'product owner', 'agile team', 'user story', 'increment every'],
  KANBAN: ['kanban', 'continuous flow', 'wip limit', 'support ticket', 'helpdesk', 'ongoing operations', '24×7', 'ticket variability'],
  HYBRID: ['hybrid', 'mixed', 'partially agile', 'phase plus sprint', 'rolling wave'],
  ITERATIVE: ['iterative', 'increment', 'phased delivery', 'progressive elaboration'],
  STAGE_GATE: ['stage-gate', 'stage gate', 'go/no-go', 'gate review', 'phase gate', 'compliance', 'regulation'],
};

/**
 * Deterministic fallback scorer: keyword heuristics over the document text + the
 * "label: value" verified inputs, so the recommendation works with no API key.
 */
function mockRecommendGovernanceModel(context: GovernanceRecommendationContext): GovernanceRecommendationOutput {
  const haystack = [
    context.documentText ?? '',
    ...context.verifiedInputs.map((input) => `${input.label}: ${input.value}`),
  ]
    .join('\n')
    .toLowerCase();

  const scored = DEFAULT_GOVERNANCE_MODELS.map((model) => {
    const hits = MODEL_KEYWORDS[model].filter((term) => haystack.includes(term));
    return { approach: model, hits, score: Math.min(95, 40 + hits.length * 12) };
  }).sort((a, b) => b.score - a.score);

  let [primary, runnerUp] = scored;
  let recommendedApproach = primary.approach;
  let rationale = `Keyword evidence points to ${primary.approach.toLowerCase()}: ${primary.hits.join(', ') || 'limited signal, defaulting to the highest-scoring model'}.`;

  if (runnerUp && primary.score - runnerUp.score < 10 && runnerUp.score > 60) {
    recommendedApproach = 'HYBRID';
    rationale = `${primary.approach} and ${runnerUp.approach} scored within 10 points of each other and both above 60 — recommending Hybrid to blend both sets of controls.`;
  }

  const candidates: { fieldKey: string; value: string }[] = [];
  for (const field of context.fields) {
    const match = field.options.find((option) => haystack.includes(option.toLowerCase()));
    if (match) candidates.push({ fieldKey: field.fieldKey, value: match });
  }

  const topScore = scored[0].score;
  const confidenceLevel: GovernanceRecommendationOutput['confidenceLevel'] = topScore >= 80 ? 'HIGH' : topScore >= 60 ? 'MEDIUM' : 'LOW';

  return {
    candidates,
    recommendedApproach,
    confidence: topScore,
    confidenceLevel,
    rationale,
    reasons: primary.hits.length ? primary.hits.map((hit) => `Evidence of "${hit}"`) : ['Limited evidence available — treat this as a low-confidence starting point'],
    // The mock matches English keywords, so there is no original-language sentence to show: it
    // never read one. Saying so is more honest than echoing the keyword into both fields.
    evidence: primary.hits.map((hit) => ({
      english: `The text contains "${hit}".`,
      source: context.documentName ?? (context.documentText ? 'uploaded document' : 'verified project inputs'),
    })),
    risks: topScore < 60 ? ['Not enough verified input or document evidence to score this confidently — PM should confirm the model directly.'] : [],
    alternatives: scored.slice(1).map((entry) => ({
      approach: entry.approach,
      score: entry.score,
      rationale: entry.hits.length ? `Evidence of ${entry.hits.join(', ')}` : 'No strong evidence found for this model',
    })),
    summary: context.documentText
      ? `Read ${context.documentText.length.toLocaleString()} characters from the project description document plus ${context.verifiedInputs.length} verified inputs.`
      : `Scored from ${context.verifiedInputs.length} verified inputs — no project description document uploaded.`,
    provider: 'mock',
  };
}

/**
 * Forces whatever the model returned onto `EvidenceItem`.
 *
 * Evidence used to be a plain `string[]`, and a model occasionally still answers that way. A bare
 * string is treated as the English statement with no citable original — the alternative is a
 * runtime crash on the one screen whose whole purpose is explaining the recommendation.
 */
export function normalizeEvidence(evidence: unknown): EvidenceItem[] {
  if (!Array.isArray(evidence)) return [];
  return evidence
    .map((entry): EvidenceItem | null => {
      if (typeof entry === 'string') {
        const text = entry.trim();
        return text ? { english: text, source: '' } : null;
      }
      if (!entry || typeof entry !== 'object') return null;
      const item = entry as { english?: unknown; original?: unknown; source?: unknown; text?: unknown };
      const english = String(item.english ?? item.text ?? '').trim();
      if (!english) return null;
      const original = String(item.original ?? '').trim();
      return {
        english,
        // A model that echoes the English back as the "original" is not giving a second language.
        ...(original && original !== english ? { original } : {}),
        source: String(item.source ?? '').trim(),
      };
    })
    .filter((entry): entry is EvidenceItem => entry !== null);
}

export async function recommendGovernanceModel(
  context: GovernanceRecommendationContext,
): Promise<GovernanceRecommendationOutput> {
  if (env.ai.provider === 'anthropic' && env.ai.anthropicKey) {
    try {
      const result = await callAnthropicJson<Omit<GovernanceRecommendationOutput, 'provider'>>({
        system: GOVERNANCE_RECOMMENDATION_SYSTEM_PROMPT,
        prompt: buildGovernanceRecommendationPrompt(context),
        label: 'skill1:governance-recommendation',
      });
      return { ...result, evidence: normalizeEvidence(result.evidence), provider: 'anthropic' };
    } catch (error) {
      console.error('[ai] falling back to mock governance recommendation:', error);
    }
  }
  return mockRecommendGovernanceModel(context);
}

// ---------------------------------------------------------------------------
// Chat — the planning agent PM can talk to directly from any screen
// ---------------------------------------------------------------------------

export async function answerAgentQuestion(context: AgentReplyContext): Promise<string> {
  if (env.ai.provider === 'anthropic' && env.ai.anthropicKey) {
    try {
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': env.ai.anthropicKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: env.ai.model,
          max_tokens: 700,
          ...outputConfig(),
          // The formatting rules are a contract with the chat renderer in AgentMessageText.tsx,
          // which deliberately understands only this subset. Widen one and the other must follow.
          system: [
            'You are the NextPM planning agent for one project. Answer the PM from the project data below.',
            'You may explain the governance-model recommendation, point out missing inputs, or offer to',
            'generate a planning document. You never apply a decision — the PM confirms everything in the UI.',
            '',
            'Answering rules:',
            '- Use ONLY the project data below. If it does not answer the question, say so plainly and name',
            '  what is missing. Never invent a date, name, owner or number.',
            '- A value marked "(NOT YET VERIFIED)" is a draft the PM has not confirmed — say so when you use it.',
            '',
            'Formatting rules:',
            '- Reply in short paragraphs separated by a blank line. Keep the whole answer under 150 words.',
            '- You may use "- " bullet lists, "1. " numbered lists, **bold** for key terms and `code` for',
            '  field names or values.',
            '- Do NOT use headings, tables, links, block quotes, code fences or nested lists.',
            '',
            '=== PROJECT DATA ===',
            context.projectContext,
          ].join('\n'),
          // Earlier turns first, so "explain that in more detail" has something to refer to.
          messages: [...context.history, { role: 'user', content: context.question }],
        }),
      });
      if (response.ok) {
        const data = (await response.json()) as AnthropicResponse;
        // This call has its own fetch (it returns prose, not JSON), so it needs its own usage
        // line — otherwise every agent chat message is billed but invisible in the token log.
        if (data.usage) {
          console.log(
            `[ai:usage] agent:chat · ${env.ai.model} · effort=${env.ai.effort} · ${JSON.stringify(data.usage)}`,
          );
        }
        return data.content
          .filter((b) => b.type === 'text')
          .map((b) => b.text ?? '')
          .join('\n')
          .trim();
      }
    } catch (error) {
      console.error('[ai] agent reply fallback:', error);
    }
  }

  // Mock fallback. It has the project context in hand but no way to reason over it, so it says
  // what it is rather than pretending to answer.
  return [
    'The AI provider could not be reached, so I cannot answer this properly.',
    '',
    'Here is what I can see about this project:',
    '',
    context.projectContext.split('\n').slice(0, 20).join('\n'),
  ].join('\n');
}
