import { env } from '../../config/env';
import { DEFAULT_GOVERNANCE_MODELS } from '../../data/governance-models';

/**
 * Two independent LLM "skills", called at two different points in the planning flow —
 * their system prompts are never combined into one request:
 *
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
  templateName: string;
  /** Only PM-verified inputs are handed to the model. */
  verifiedInputs: { label: string; value: string }[];
  /** Why this governance model was recommended/confirmed — for grounding, not proof. */
  reasons: string[];
  sections: { title: string; hint?: string | null }[];
}

export interface GeneratedSection {
  title: string;
  content: string;
}

export interface GenerationOutput {
  sections: GeneratedSection[];
  pmQuestions: string[];
  /** Values the agent could not derive from verified inputs. */
  unresolved: string[];
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
}

export interface AgentReplyContext {
  projectName: string;
  approach: string;
  question: string;
  verifiedCount: number;
  missingCount: number;
  reasons: string[];
}

async function callAnthropicJson<T>(params: { system: string; prompt: string; maxTokens: number }): Promise<T> {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': env.ai.anthropicKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: env.ai.model,
      max_tokens: params.maxTokens,
      system: params.system,
      messages: [{ role: 'user', content: params.prompt }],
    }),
  });

  if (!response.ok) {
    throw new Error(`Anthropic API error ${response.status}: ${await response.text()}`);
  }

  const data = (await response.json()) as { content: { type: string; text?: string }[] };
  const text = data.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text ?? '')
    .join('\n')
    .replace(/```json|```/g, '')
    .trim();

  return JSON.parse(text) as T;
}

// ---------------------------------------------------------------------------
// Skill 2a — generic document draft (the ~15 non-governance-mandated documents)
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are the NextPM planning agent.
Rules you must never break:
- Write only the sections you are given, in the given order.
- Use only the verified inputs supplied. Never invent dates, names, numbers or owners.
- When a value is missing, write "TBD — PM confirmation required" and list it as a PM question.
- You draft; the PM approves. Never state that anything is approved or baselined.
Return strict JSON: { "sections": [{ "title": string, "content": string }], "pmQuestions": string[], "unresolved": string[] }`;

function buildPrompt(context: GenerationContext): string {
  const inputs = context.verifiedInputs.map((input) => `- ${input.label}: ${input.value}`).join('\n');
  const reasons = context.reasons.map((reason) => `- ${reason}`).join('\n');
  const sections = context.sections
    .map((section, index) => `${index + 1}. ${section.title}${section.hint ? ` — ${section.hint}` : ''}`)
    .join('\n');

  return [
    `Document: ${context.documentName} (${context.templateName} template)`,
    `Project: ${context.projectName} · type ${context.projectType} · governance model ${context.approach} · ${context.rigor}`,
    '',
    'Verified inputs:',
    inputs || '- none verified yet',
    '',
    'Why this governance model was chosen:',
    reasons || '- none recorded',
    '',
    'Sections to write (the generation contract):',
    sections,
    '',
    'Write 2–5 sentences per section in professional PM English.',
  ].join('\n');
}

function mockGenerate(context: GenerationContext): GenerationOutput {
  const lookup = new Map(context.verifiedInputs.map((input) => [input.label.toLowerCase(), input.value]));
  const pick = (...labels: string[]) => labels.map((label) => lookup.get(label.toLowerCase())).find(Boolean);

  const objective = pick('business objective', 'service objective', 'product vision');
  const measure = pick('success measure', 'target outcome');
  const window = pick('target dates', 'target window', 'service term', 'planning horizon');
  const unresolved: string[] = [];
  const missing = (label: string) => {
    unresolved.push(label);
    return 'TBD — PM confirmation required';
  };

  const sections = context.sections.map((section) => {
    const title = section.title.toLowerCase();
    let content: string;

    if (title.includes('purpose') || title.includes('vision') || title.includes('objective')) {
      content = `${context.projectName} exists to ${objective ?? missing('Business objective')}. Success is measured as ${measure ?? missing('Success measure')} within ${window ?? missing('Target dates')}. The ${context.approach} governance model with ${context.rigor} was selected from the AI recommendation and confirmed by the PM.`;
    } else if (title.includes('scope') || title.includes('boundar')) {
      content = `In scope: the delivery needed to reach the stated objective under the confirmed ${context.approach} controls. Out of scope: anything not listed in the verified input profile. Scope changes follow the change control approach attached to this model.`;
    } else if (title.includes('milestone') || title.includes('acceptance') || title.includes('roadmap') || title.includes('release')) {
      content = `Milestones are derived from the committed window ${window ?? missing('Target dates')}. Each milestone carries an acceptance owner and exit criteria; a milestone is only complete once its acceptance evidence is recorded.`;
    } else if (title.includes('risk') || title.includes('dependen') || title.includes('assumption')) {
      const risks = context.reasons.filter((reason) => /depend|risk/i.test(reason));
      content = `Key exposures flagged by the recommendation: ${risks.length ? risks.join(', ') : 'none flagged'}. Every dependency needs a named owner and a fallback before this section can be approved.`;
    } else if (title.includes('financial') || title.includes('cost') || title.includes('budget')) {
      content = `Financial authorization follows the confirmed budget control scope. Where the customer owns the budget, this project tracks cost impact only and raises a commercial change request when a material threshold is crossed.`;
    } else {
      content = `This section follows the ${context.templateName} template for a ${context.projectType} project under a ${context.approach} governance model. It is drafted from ${context.verifiedInputs.length} verified inputs and needs PM review before it enters the baseline.`;
    }

    return { title: section.title, content };
  });

  return {
    sections,
    pmQuestions: unresolved.length
      ? [`Confirm the following before approval: ${unresolved.join(', ')}.`]
      : ['Select the final acceptance authority before approving this document.'],
    unresolved,
  };
}

export async function generateDocument(context: GenerationContext): Promise<GenerationOutput> {
  if (env.ai.provider === 'anthropic' && env.ai.anthropicKey) {
    try {
      return await callAnthropicJson<GenerationOutput>({ system: SYSTEM_PROMPT, prompt: buildPrompt(context), maxTokens: 4000 });
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
Rules you must never break:
- Follow the given structure guidance for this artifact under this governance model.
- Use only the verified inputs and reasons supplied. Never invent names, dates or numbers.
- Never write an empty placeholder ("TBD", "to be updated") when the supplied data already answers it.
  Only mark "PM confirmation required" for a genuinely missing, specific fact (e.g. a named owner).
- You draft; the PM approves. Never state that anything is approved or baselined.
- If the artifact is "RACI Matrix", also return "raciTable": an array of
  { activity, responsible, accountable, consulted, informed } rows covering the project's key
  activities under this governance model's structure.
- If the artifact is "Risk Plan", also return "riskRegister": an array of
  { risk, severity, owner, mitigation } rows (severity is one of Critical, High, Medium, Low).
Return strict JSON: { "sections": [{ "title": string, "content": string }], "pmQuestions": string[], "unresolved": string[], "raciTable"?: [...], "riskRegister"?: [...] }`;

function buildGovernanceArtifactPrompt(context: GovernanceArtifactContext): string {
  const inputs = context.verifiedInputs.map((input) => `- ${input.label}: ${input.value}`).join('\n');
  const reasons = context.reasons.map((reason) => `- ${reason}`).join('\n');
  const sections = context.sections
    .map((section, index) => `${index + 1}. ${section.title}${section.hint ? ` — ${section.hint}` : ''}`)
    .join('\n');

  return [
    `Artifact: ${context.artifactName} for governance model ${context.approach}`,
    `Structure guidance for this artifact under this model: ${context.structureGuidance}`,
    `Project: ${context.projectName} · type ${context.projectType} · ${context.rigor}`,
    '',
    'Verified inputs:',
    inputs || '- none verified yet',
    '',
    'Why this governance model was chosen:',
    reasons || '- none recorded',
    '',
    'Sections to write (the generation contract):',
    sections,
    '',
    'Write 2–5 sentences per section in professional PM English.',
  ].join('\n');
}

function mockGenerateGovernanceArtifact(context: GovernanceArtifactContext): GovernanceArtifactOutput {
  const base = mockGenerate(context);
  const lookup = new Map(context.verifiedInputs.map((input) => [input.label.toLowerCase(), input.value]));

  if (context.artifactName === 'RACI Matrix') {
    const raciTable: RaciRow[] = [
      { activity: 'Confirm governance model & baseline', responsible: 'PM', accountable: 'Sponsor', consulted: 'Delivery lead', informed: 'Stakeholders' },
      { activity: 'Requirements / backlog management', responsible: 'PM confirmation required', accountable: 'PM', consulted: 'Delivery team', informed: 'Sponsor' },
      { activity: `${context.approach} cadence & reporting`, responsible: 'Delivery lead', accountable: 'PM', consulted: 'Team', informed: 'Sponsor' },
      { activity: 'Risk & escalation handling', responsible: 'PM', accountable: 'Sponsor', consulted: 'Risk owner', informed: 'Stakeholders' },
    ];
    return { ...base, raciTable };
  }

  if (context.artifactName === 'Risk Plan') {
    const complexity = lookup.get('integration complexity') ?? lookup.get('technical uncertainty');
    const riskRegister: RiskRow[] = [
      {
        risk: complexity ? `Delivery risk from: ${complexity}` : 'Delivery risk — PM confirmation required',
        severity: 'Medium',
        owner: 'PM confirmation required',
        mitigation: `Weekly review under the ${context.approach} risk cadence.`,
      },
      {
        risk: 'Scope/requirement change beyond agreed control',
        severity: 'Medium',
        owner: 'PM',
        mitigation: `Handled via this model's change control path (see Change / Escalation Flow).`,
      },
    ];
    return { ...base, riskRegister };
  }

  return base;
}

export async function generateGovernanceArtifact(context: GovernanceArtifactContext): Promise<GovernanceArtifactOutput> {
  if (env.ai.provider === 'anthropic' && env.ai.anthropicKey) {
    try {
      return await callAnthropicJson<GovernanceArtifactOutput>({
        system: GOVERNANCE_ARTIFACT_SYSTEM_PROMPT,
        prompt: buildGovernanceArtifactPrompt(context),
        maxTokens: 2500,
      });
    } catch (error) {
      console.error('[ai] falling back to mock governance artifact generator:', error);
    }
  }
  return mockGenerateGovernanceArtifact(context);
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
  };
}

export async function recommendGovernanceModel(
  context: GovernanceRecommendationContext,
): Promise<GovernanceRecommendationOutput> {
  if (env.ai.provider === 'anthropic' && env.ai.anthropicKey) {
    try {
      return await callAnthropicJson<GovernanceRecommendationOutput>({
        system: GOVERNANCE_RECOMMENDATION_SYSTEM_PROMPT,
        prompt: buildGovernanceRecommendationPrompt(context),
        maxTokens: 2000,
      });
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
          system:
            'You are the NextPM planning agent. Explain the governance-model recommendation, verify values or offer to generate a planning page. You never apply a decision without PM confirmation. Be concise.',
          messages: [
            {
              role: 'user',
              content: `Project ${context.projectName}, governance model ${context.approach}, ${context.verifiedCount} verified inputs, ${context.missingCount} missing values. Recommendation reasons: ${context.reasons.join('; ')}. Question: ${context.question}`,
            },
          ],
        }),
      });
      if (response.ok) {
        const data = (await response.json()) as { content: { type: string; text?: string }[] };
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

  return [
    `I can verify a value, explain the governance-model recommendation or generate a selected planning page for ${context.projectName}.`,
    `Right now: ${context.verifiedCount} verified inputs, ${context.missingCount} values still waiting on you, governance model ${context.approach}.`,
    'No decision has been applied — I will ask for your confirmation first.',
  ].join(' ');
}
