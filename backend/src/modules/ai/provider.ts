import { env } from '../../config/env';
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

export interface GovernanceArtifactOutput extends GenerationOutput {
  raciTable?: RaciRow[];
  riskRegister?: RiskRow[];
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

export interface GovernanceRecommendationOutput {
  candidates: { fieldKey: string; value: string }[];
  recommendedApproach: string;
  confidence: number;
  confidenceLevel: 'HIGH' | 'MEDIUM' | 'LOW';
  rationale: string;
  reasons: string[];
  evidence: string[];
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
    throw new Error(`Anthropic API error ${response.status}: ${await response.text()}`);
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
  if (data.stop_reason === 'max_tokens') {
    throw new Error(
      `Anthropic response was truncated at the ${MAX_OUTPUT_TOKENS}-token ceiling, so the JSON is incomplete.`,
    );
  }
  if (data.stop_reason === 'refusal') {
    throw new Error(
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

  if (!text) throw new Error(`Anthropic returned no text content (stop_reason: ${data.stop_reason ?? 'unknown'})`);

  try {
    return JSON.parse(text) as T;
  } catch (error) {
    throw new Error(
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
  never a task ("Confirm the sponsor").
- You draft; the PM approves. Never state that anything is approved or baselined.

Write 2-5 sentences per section in professional PM English.`;

const SYSTEM_PROMPT = `You are the NextPM planning agent, drafting one planning document.

${NO_FABRICATION_RULES}

Return strict JSON and nothing else:
{ "sections": [{ "title": string, "content": string }],
  "gaps": [{ "token": "{{gap:1}}", "question": string }],
  "unresolved": string[] }
"unresolved" is a short plain-English list of what was left blank, for the audit trail.`;

function buildPrompt(context: GenerationContext): string {
  const inputs = context.verifiedInputs.map((input) => `- ${input.label}: ${input.value}`).join('\n');
  const reasons = context.reasons.map((reason) => `- ${reason}`).join('\n');

  return [
    `Document to write: ${context.documentName}`,
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
function mockGenerate(context: GenerationContext): GenerationOutput {
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

  return { sections, gaps, unresolved, provider: 'mock' };
}

export async function generateDocument(context: GenerationContext): Promise<GenerationOutput> {
  if (env.ai.provider === 'anthropic' && env.ai.anthropicKey) {
    try {
      const result = await callAnthropicJson<Omit<GenerationOutput, 'provider'>>({
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
// Project Charter, Organization Chart, RACI Matrix, Communication Plan,
// Change / Escalation Flow, Risk Plan). Structure varies by governance model.
// ---------------------------------------------------------------------------

const GOVERNANCE_ARTIFACT_SYSTEM_PROMPT = `You are the NextPM planning agent, drafting one governance artifact after the PM
has confirmed a governance model.
Follow the structure guidance given for this artifact under this governance model — it tells you
which sections this artifact needs.

${NO_FABRICATION_RULES}

- If the artifact is "RACI Matrix", also return "raciTable": an array of
  { activity, responsible, accountable, consulted, informed } rows covering the project's key
  activities under this governance model's structure. A role you do not know is a gap token too.
- If the artifact is "Risk Plan", also return "riskRegister": an array of
  { risk, severity, owner, mitigation } rows (severity is one of Critical, High, Medium, Low).

Return strict JSON and nothing else:
{ "sections": [{ "title": string, "content": string }],
  "gaps": [{ "token": "{{gap:1}}", "question": string }],
  "unresolved": string[], "raciTable"?: [...], "riskRegister"?: [...] }`;

function buildGovernanceArtifactPrompt(context: GovernanceArtifactContext): string {
  const inputs = context.verifiedInputs.map((input) => `- ${input.label}: ${input.value}`).join('\n');
  const reasons = context.reasons.map((reason) => `- ${reason}`).join('\n');

  return [
    `Artifact: ${context.artifactName} for governance model ${context.approach}`,
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

  if (context.artifactName === 'Risk Plan') {
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
        mitigation: `Handled via this model's change control path (see Change / Escalation Flow).`,
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
- For free-text fields, answer in the language of the document, so the PM sees the customer's own
  wording. Dates: return ISO format (YYYY-MM-DD), or "YYYY-MM-DD..YYYY-MM-DD" for a date range.

Rules you must never break:
- Answer a field ONLY when the document actually states or clearly implies it. Omit every field
  you are unsure about — a blank the PM fills in is far better than a confident wrong answer.
- Never infer a value from the field name, from typical industry practice, or from the other
  fields. Documents are your only source.
- "evidence" must be a short verbatim quote from the document, in its original language.

Return strict JSON and nothing else:
{ "values": [{ "fieldKey": string, "value": string, "evidence": string }] }
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
  if (!context.fields.length || !context.documents.length) return { values: [], provider: 'mock' };

  if (env.ai.provider === 'anthropic' && env.ai.anthropicKey) {
    try {
      const result = await callAnthropicJson<{ values: InputExtractionOutput['values'] }>({
        system: INPUT_EXTRACTION_SYSTEM_PROMPT,
        prompt: buildInputExtractionPrompt(context),
        label: 'skill0:input-extraction',
      });
      return { values: result.values ?? [], provider: 'anthropic' };
    } catch (error) {
      console.error('[ai] input extraction failed, no values proposed:', error);
    }
  }

  // There is no useful mock for this: the deterministic matcher already ran and found nothing,
  // and guessing here would put invented values in front of the PM.
  return { values: [], provider: 'mock' };
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

Language:
- Inputs and documents may be in ANY language (Vietnamese, Korean, Japanese, English...). Read
  them in their original language; never refuse for lack of a translation.
- Quote evidence in the language it was written in, so the PM can find the sentence in the source.
  Write your rationale, reasons and risks in English.
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
(2-3 sentences), "reasons": string[] (key reasons, each traceable to evidence), "evidence": string[]
(the specific inputs/document statements the reasons are grounded in), "risks": string[] (risks or
limitations of the recommendation), "alternatives": [{ "approach": string, "score": number,
"rationale": string }] (every other model scored), "summary": string (one sentence describing what
was read), "candidates": [{ "fieldKey": string, "value": string }] (only for fields you can
confidently answer from the document text; for SELECT fields use one of the given options
verbatim) }`;

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
    'Project description document (verbatim, may be truncated):',
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
    evidence: primary.hits,
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
      return { ...result, provider: 'anthropic' };
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
