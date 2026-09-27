import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { useLocation } from 'react-router-dom';
import { useAuth } from '../store/auth';

/**
 * The first-run tutorial — a guided tour of the planning flow, in the order of the UX flow it was
 * designed from: Program Overview → Create Project → Project Input → AI analysis → Planning
 * Assessment → Planning Artifacts → Update plan → AI change analysis, with the two things that are
 * there throughout (the chatbot agent and the project dashboard).
 *
 * It opens by itself once per account — `User.tutorialSeenAt` is null until the account finishes
 * or skips it — and the Tutorial button in the top bar replays it for anyone.
 *
 * A step points at the real control when the current screen has it (`data-tour` attributes on the
 * target elements), because "this button" is clearer than a description of it. A new account is on
 * Program Overview, where most of the flow's screens do not exist yet, so a step whose target is
 * not on screen shows a small drawing of it instead, beside the whole flow. The tour never
 * navigates by itself: moving the PM between screens mid-tour, into a project they may not have,
 * would be doing things on their behalf.
 */

type Actor = 'PM' | 'AI' | 'BOTH';

interface TutorialStep {
  key: string;
  /** Position in the eight-step planning flow; steps outside it (welcome, support, finish) have none. */
  flow?: number;
  label: string;
  actor: Actor;
  title: string;
  body: ReactNode;
  note?: { tone: 'loop' | 'ai' | 'branch'; title: string; text: string };
  /** `data-tour` keys to point at, most specific first; the first one on screen wins. */
  targets?: string[];
  art: ReactNode;
}

// ---------------------------------------------------------------------------
// Icons — the two actors of the flow drawing
// ---------------------------------------------------------------------------

function PersonIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="tour-icon">
      <circle cx="12" cy="6.5" r="3.2" fill="none" stroke="currentColor" strokeWidth="1.6" />
      <path d="M5 20.5v-3.2a4.5 4.5 0 0 1 4.5-4.5h5a4.5 4.5 0 0 1 4.5 4.5v3.2" fill="none" stroke="currentColor" strokeWidth="1.6" />
      <rect x="7.5" y="15.2" width="9" height="5.3" rx="1.2" fill="none" stroke="currentColor" strokeWidth="1.6" />
    </svg>
  );
}

function BotIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="tour-icon">
      <path d="M12 3.2v3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      <rect x="4" y="6.2" width="16" height="13" rx="3" fill="none" stroke="currentColor" strokeWidth="1.6" />
      <circle cx="9" cy="12" r="1.2" fill="currentColor" />
      <circle cx="15" cy="12" r="1.2" fill="currentColor" />
      <path d="M9.5 15.6h5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

function ActorChip({ actor }: { actor: Actor }) {
  if (actor === 'BOTH') {
    return (
      <span className="tour-actors">
        <span className="tour-actor pm">
          <PersonIcon /> PM
        </span>
        <span className="tour-actor ai">
          <BotIcon /> AI
        </span>
      </span>
    );
  }
  return (
    <span className={`tour-actor ${actor === 'PM' ? 'pm' : 'ai'}`}>
      {actor === 'PM' ? <PersonIcon /> : <BotIcon />}
      {actor === 'PM' ? 'PM acts / decides' : 'AI processes'}
    </span>
  );
}

// ---------------------------------------------------------------------------
// The steps
// ---------------------------------------------------------------------------

const STEPS: TutorialStep[] = [
  {
    key: 'welcome',
    label: 'Welcome',
    actor: 'BOTH',
    title: 'Welcome to NEXTPLAN AI',
    body: (
      <>
        Project Planning Studio takes a project from its first documents to an approved planning pack. This tour walks
        through the flow in eight steps — about a minute.
      </>
    ),
    art: (
      <div className="tour-art tour-art-legend">
        <p>
          <span className="tour-actor pm">
            <PersonIcon /> PM
          </span>
          decides and adds information
        </p>
        <p>
          <span className="tour-actor ai">
            <BotIcon /> AI
          </span>
          analyses and helps create the documents
        </p>
        <small>The AI verifies, recommends and drafts. You confirm every decision and approve every baseline.</small>
      </div>
    ),
  },
  {
    key: 'overview',
    flow: 1,
    label: 'Program Overview',
    actor: 'PM',
    title: 'Program Overview',
    body: (
      <>
        The screen you land on after signing in: every program and project you can open, with its planning readiness
        and open gaps.
      </>
    ),
    targets: ['nav-overview', 'back-projects'],
    art: (
      <div className="tour-art tour-art-board">
        {[
          ['Swing Order', 72],
          ['GDC Logistics', 45],
          ['Care Portal', 28],
        ].map(([name, value]) => (
          <div key={name as string} className="tour-board-row">
            <span>{name}</span>
            <i>
              <b style={{ width: `${value}%` }} className={Number(value) < 40 ? 'low' : Number(value) < 60 ? 'mid' : ''} />
            </i>
            <em>{value}%</em>
          </div>
        ))}
      </div>
    ),
  },
  {
    key: 'create',
    flow: 2,
    label: 'Create Project',
    actor: 'PM',
    title: 'Create Project',
    body: (
      <>
        Press <b>+ Add project</b>. In the dialog, name the project, pick its type — SI, SM or Product — and name the
        customer (SK AX, LGCNS, …).
      </>
    ),
    note: {
      tone: 'ai',
      title: 'Why the customer matters',
      text: 'It decides which account library the project follows — the customer’s checklist and document templates.',
    },
    targets: ['add-project'],
    art: (
      <div className="tour-art tour-art-form">
        <label>
          Project name<span>GDC Logistics Platform</span>
        </label>
        <div className="tour-form-pair">
          <label>
            Project type<span>SI ▾</span>
          </label>
          <label>
            Customer<span>SK AX</span>
          </label>
        </div>
        <button type="button" tabIndex={-1} className="tour-fake primary">
          Create project
        </button>
      </div>
    ),
  },
  {
    key: 'input',
    flow: 3,
    label: 'Project Input',
    actor: 'PM',
    title: 'Project Input',
    body: (
      <>
        Upload <b>at least one document</b> describing the project — a proposal, SOW or RFP — then press{' '}
        <b>✦ Analyze planning needs</b>.
      </>
    ),
    targets: ['analyze', 'nav-input'],
    art: (
      <div className="tour-art tour-art-upload">
        <div className="tour-drop">
          <strong>Project description document</strong>
          <span>SOW_GDC_2026.docx · readable</span>
        </div>
        <button type="button" tabIndex={-1} className="tour-fake pm-fill">
          ✦ Analyze planning needs
        </button>
      </div>
    ),
  },
  {
    key: 'analysis',
    flow: 4,
    label: 'AI analysis',
    actor: 'AI',
    title: 'AI analyses the planning needs',
    body: (
      <>
        The AI reads every uploaded document, then assesses the project against the FPT standard and the customer’s
        checklist. Wait for it to finish — it usually takes more than a minute.
      </>
    ),
    art: (
      <div className="tour-art tour-art-progress">
        <p className="done">Reading the uploaded documents</p>
        <p className="done">Assessing against the FPT standard</p>
        <p className="running">
          <i className="tour-spin" /> Assessing the customer checklist
        </p>
      </div>
    ),
  },
  {
    key: 'assessment',
    flow: 5,
    label: 'Planning Assessment',
    actor: 'PM',
    title: 'Planning Assessment',
    body: (
      <>
        Review what the AI found — missing information, missing documents, risks, conflicts and the management approach
        — and decide whether to go on. If you agree, press <b>Confirm and Open Planning Artifacts</b>.
      </>
    ),
    note: {
      tone: 'loop',
      title: 'Not agreeing with the result?',
      text: 'Go back to Project Input, add documents, and analyse again.',
    },
    targets: ['confirm-plan', 'nav-approach'],
    art: (
      <div className="tour-art tour-art-assess">
        <div className="tour-tabs">
          {['Overview', 'Missing Information', 'Missing Documents', 'Risks', 'Conflicts', 'Management Approach'].map(
            (tab, index) => (
              <span key={tab} className={index === 0 ? 'on' : ''}>
                {tab}
              </span>
            ),
          )}
        </div>
        <div className="tour-assess-actions">
          <button type="button" tabIndex={-1} className="tour-fake secondary">
            ← Back to inputs
          </button>
          <button type="button" tabIndex={-1} className="tour-fake amber-fill">
            Confirm and Open Planning Artifacts
          </button>
        </div>
      </div>
    ),
  },
  {
    key: 'artifacts',
    flow: 6,
    label: 'Planning Artifacts',
    actor: 'BOTH',
    title: 'Planning Artifacts',
    body: (
      <>
        Generate the documents the AI proposes. The AI drafts each one from the project’s input; you fill in what is
        missing, then review, approve and download.
      </>
    ),
    note: {
      tone: 'ai',
      title: 'The AI asks, you answer',
      text:
        'When a document needs a fact the input does not have, the AI asks you under “PM confirmation needed” instead of guessing. Answer it and the AI carries on with the document.',
    },
    targets: ['nav-studio'],
    art: (
      <div className="tour-art tour-art-doc">
        <div className="tour-doc">
          <strong>Risk Management Plan</strong>
          <p>
            Risks are reviewed weekly by <mark>[ answer needed ]</mark> with the customer’s PMO.
          </p>
        </div>
        <div className="tour-bubble ai">
          <BotIcon /> Who reviews the risk register each week?
        </div>
        <div className="tour-bubble pm">
          <PersonIcon /> The delivery PM, with SK AX’s PMO lead
        </div>
      </div>
    ),
  },
  {
    key: 'update',
    flow: 7,
    label: 'Update plan',
    actor: 'PM',
    title: 'Update plan',
    body: (
      <>
        Once the plan is confirmed, record what changed when the customer sends new information — and upload the new
        documents — then press <b>✦ Analyze the change</b>.
      </>
    ),
    note: {
      tone: 'branch',
      title: 'The update branch',
      text: 'Only after the plan has been confirmed and new information arrives from the customer. The step appears in the sidebar then.',
    },
    targets: ['analyze-change', 'nav-update'],
    art: (
      <div className="tour-art tour-art-change">
        <div className="tour-drop">
          <strong>What changed</strong>
          <span>Team size increases from 5 to 10 · SOW_v2.docx</span>
        </div>
        <button type="button" tabIndex={-1} className="tour-fake amber-fill">
          ✦ Analyze the change
        </button>
      </div>
    ),
  },
  {
    key: 'change-analysis',
    flow: 8,
    label: 'AI change analysis',
    actor: 'AI',
    title: 'AI analyses the change',
    body: (
      <>
        See its impact on the plan — which gaps close, which documents are now out of date, what the assessment moves —
        and decide whether to apply it or dismiss it.
      </>
    ),
    art: (
      <div className="tour-art tour-art-impact">
        <p className="good">2 missing items settled</p>
        <p className="warn">Resource Plan · out of date after this change</p>
        <p className="warn">1 new conflict between SOW v2 and the schedule</p>
      </div>
    ),
  },
  {
    key: 'agent',
    label: 'Always there',
    actor: 'AI',
    title: 'Chatbot Agent',
    body: <>Ask the planning agent anything, at any step. It reads the whole project to answer.</>,
    targets: ['agent', 'agent-card'],
    art: (
      <div className="tour-art tour-art-doc">
        <div className="tour-bubble pm">
          <PersonIcon /> Which documents still block the plan?
        </div>
        <div className="tour-bubble ai">
          <BotIcon /> Two: the Communication Plan and the Resource Plan — both are waiting for the steering members.
        </div>
      </div>
    ),
  },
  {
    key: 'dashboard',
    label: 'Always there',
    actor: 'PM',
    title: 'Project Dashboard',
    body: <>Follow planning progress and the project’s readiness from start to finish — each project opens on it.</>,
    targets: ['nav-dashboard'],
    art: (
      <div className="tour-art tour-art-dash">
        <div className="tour-ring" style={{ '--p': 64 } as CSSProperties}>
          <span>64%</span>
        </div>
        <div>
          <p>
            <b>Planning readiness</b>
          </p>
          <p>PM Actions · 3 open</p>
          <p>Planning documents · 9 / 14</p>
        </div>
      </div>
    ),
  },
  {
    key: 'finish',
    label: 'All set',
    actor: 'BOTH',
    title: 'You are ready to plan',
    body: <>You can replay this tour any time from the Tutorial button at the top of the screen.</>,
    targets: ['tutorial'],
    art: (
      <div className="tour-art tour-art-legend">
        <button type="button" tabIndex={-1} className="tour-fake secondary">
          ? Tutorial
        </button>
        <small>PM decides and adds information · AI analyses and helps create documents.</small>
      </div>
    ),
  },
];

const FLOW = STEPS.filter((step) => step.flow);

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

interface TutorialState {
  /** True while the tour is open — or about to open by itself — so a screen can hold its own popups. */
  active: boolean;
  start: () => void;
}

const TutorialContext = createContext<TutorialState>({ active: false, start: () => undefined });

export const useTutorial = () => useContext(TutorialContext);

/** Mounted once inside the router, around every route. */
export function TutorialProvider({ children }: { children: ReactNode }) {
  const { user, markTutorialSeen } = useAuth();
  const location = useLocation();
  const [open, setOpen] = useState(false);
  const [index, setIndex] = useState(0);

  // Administrators never plan a project, and a signed-out screen has nobody to greet.
  const eligible = Boolean(user && user.role !== 'ADMIN');
  const onAuthScreen = location.pathname === '/login' || location.pathname === '/register';
  const firstRun = eligible && !onAuthScreen && !user?.tutorialSeenAt;

  // Only a first run opens it by itself; closing is what records it as seen, so it cannot reopen.
  useEffect(() => {
    if (firstRun && !open) {
      setIndex(0);
      setOpen(true);
    }
  }, [firstRun, open]);

  // A signed-out session must not leave the tour on the sign-in screen.
  useEffect(() => {
    if (!user) setOpen(false);
  }, [user]);

  const start = useCallback(() => {
    setIndex(0);
    setOpen(true);
  }, []);

  const close = useCallback(() => {
    setOpen(false);
    markTutorialSeen();
  }, [markTutorialSeen]);

  const value = useMemo(() => ({ active: open || firstRun, start }), [open, firstRun, start]);

  return (
    <TutorialContext.Provider value={value}>
      {children}
      {open && user && <TutorialOverlay index={index} onIndex={setIndex} onClose={close} />}
    </TutorialContext.Provider>
  );
}

/** The top-bar button that replays the tour. Delivery accounts only, like the tour itself. */
export function TutorialButton() {
  const { user } = useAuth();
  const { start } = useTutorial();
  if (!user || user.role === 'ADMIN') return null;
  return (
    <button type="button" className="secondary small tutorial-button" data-tour="tutorial" onClick={start} title="Replay the guided tour">
      <span aria-hidden="true">?</span> Tutorial
    </button>
  );
}

// ---------------------------------------------------------------------------
// The overlay
// ---------------------------------------------------------------------------

/** Below this width the spotlight has no room beside its target, so every step is centred. */
const SPOTLIGHT_MIN_WIDTH = 760;
const CARD_WIDTH = 360;
const GAP = 14;
const SPOT_PADDING = 6;

interface Box {
  top: number;
  left: number;
  width: number;
  height: number;
}

function findTarget(keys: string[] | undefined): HTMLElement | null {
  if (!keys || window.innerWidth < SPOTLIGHT_MIN_WIDTH) return null;
  for (const key of keys) {
    for (const element of document.querySelectorAll<HTMLElement>(`[data-tour="${key}"]`)) {
      const rect = element.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0 && getComputedStyle(element).visibility !== 'hidden') return element;
    }
  }
  return null;
}

const sameBox = (a: Box | null, b: Box | null) =>
  a === b || Boolean(a && b && a.top === b.top && a.left === b.left && a.width === b.width && a.height === b.height);

/** Right of the target, else left, else below, else above — then pulled back inside the viewport. */
function placeCard(target: Box, card: { width: number; height: number }) {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const clampTop = (top: number) => Math.max(GAP, Math.min(top, vh - card.height - GAP));
  const clampLeft = (left: number) => Math.max(GAP, Math.min(left, vw - card.width - GAP));
  const middle = target.top + target.height / 2 - card.height / 2;

  if (target.left + target.width + GAP + card.width + GAP <= vw) {
    return { top: clampTop(middle), left: target.left + target.width + GAP };
  }
  if (target.left - GAP - card.width >= GAP) {
    return { top: clampTop(middle), left: target.left - GAP - card.width };
  }
  const centre = clampLeft(target.left + target.width / 2 - card.width / 2);
  if (target.top + target.height + GAP + card.height + GAP <= vh) {
    return { top: target.top + target.height + GAP, left: centre };
  }
  return { top: clampTop(target.top - GAP - card.height), left: centre };
}

function TutorialOverlay({
  index,
  onIndex,
  onClose,
}: {
  index: number;
  onIndex: (index: number) => void;
  onClose: () => void;
}) {
  const step = STEPS[index];
  const last = index === STEPS.length - 1;
  const [spot, setSpot] = useState<Box | null>(null);
  const [cardSize, setCardSize] = useState({ width: CARD_WIDTH, height: 280 });
  const cardRef = useRef<HTMLDivElement>(null);
  const scrolledFor = useRef<string | null>(null);

  // The target can arrive after the step does (a screen still loading its data) and move while it
  // is shown (a sidebar scrolled, a window resized), so it is re-measured on a short interval rather
  // than once. It is a handful of selector lookups — nothing a PM would notice.
  useEffect(() => {
    const measure = () => {
      const element = findTarget(step.targets);
      if (element && scrolledFor.current !== step.key) {
        scrolledFor.current = step.key;
        element.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      }
      const rect = element?.getBoundingClientRect();
      const next = rect
        ? {
            top: Math.round(rect.top - SPOT_PADDING),
            left: Math.round(rect.left - SPOT_PADDING),
            width: Math.round(rect.width + SPOT_PADDING * 2),
            height: Math.round(rect.height + SPOT_PADDING * 2),
          }
        : null;
      setSpot((previous) => (sameBox(previous, next) ? previous : next));
    };
    measure();
    const timer = window.setInterval(measure, 300);
    window.addEventListener('resize', measure);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('resize', measure);
    };
  }, [step]);

  useLayoutEffect(() => {
    const card = cardRef.current;
    if (!card) return;
    const next = { width: card.offsetWidth, height: card.offsetHeight };
    setCardSize((previous) => (previous.width === next.width && previous.height === next.height ? previous : next));
  });

  const back = () => index > 0 && onIndex(index - 1);
  const next = () => (last ? onClose() : onIndex(index + 1));

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
      else if (event.key === 'ArrowRight') next();
      else if (event.key === 'ArrowLeft') back();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // Keyboard focus goes to the card, so Enter/Space act on the tour rather than on the page behind.
  useEffect(() => {
    cardRef.current?.querySelector<HTMLButtonElement>('.tour-next')?.focus({ preventScroll: true });
  }, [index]);

  const counter = step.flow ? `Step ${step.flow} of ${FLOW.length}` : step.label;
  const position = spot ? placeCard(spot, cardSize) : null;

  // The drawing of the screen is shown only when the real one is not on screen to point at.
  const content = (withArt: boolean) => (
    <>
      <div className="tour-head">
        <span className="tour-counter">{counter}</span>
        <button type="button" className="tour-skip" onClick={onClose}>
          {last ? 'Close' : 'Skip tutorial'}
        </button>
      </div>
      <ActorChip actor={step.actor} />
      <h2 id="tour-title">
        {step.flow && <span className="tour-num">{String(step.flow).padStart(2, '0')}</span>}
        {step.title}
      </h2>
      <p className="tour-body">{step.body}</p>
      {step.note && (
        <div className={`tour-note ${step.note.tone}`}>
          <strong>{step.note.title}</strong>
          <span>{step.note.text}</span>
        </div>
      )}
      {spot && <p className="tour-pointer">Highlighted on this screen</p>}
      {withArt && <div className="tour-art-frame">{step.art}</div>}
      <div className="tour-foot">
        <div className="tour-dots" aria-hidden="true">
          {STEPS.map((entry, dot) => (
            <i key={entry.key} className={dot === index ? 'on' : dot < index ? 'past' : ''} />
          ))}
        </div>
        <div className="tour-buttons">
          {index > 0 && (
            <button type="button" className="secondary" onClick={back}>
              Back
            </button>
          )}
          <button type="button" className="primary tour-next" onClick={next}>
            {index === 0 ? 'Start the tour' : last ? 'Finish' : 'Next'}
          </button>
        </div>
      </div>
    </>
  );

  return (
    <div className="tour-root" role="dialog" aria-modal="true" aria-labelledby="tour-title">
      {/* Catches clicks on the page behind: the tour explains the screen, it does not operate it. */}
      <div className={`tour-layer${spot ? '' : ' dim'}`} />
      {spot && <div className="tour-spot" style={spot} />}

      {position ? (
        <div ref={cardRef} className="tour-card tour-card-anchored" style={{ top: position.top, left: position.left, width: CARD_WIDTH }}>
          {content(false)}
        </div>
      ) : (
        <div ref={cardRef} className="tour-card tour-card-centred">
          <aside className="tour-flow" aria-label="Planning flow">
            <small>PLANNING FLOW</small>
            {FLOW.map((entry) => {
              const at = STEPS.indexOf(entry);
              return (
                <button
                  key={entry.key}
                  type="button"
                  className={`tour-flow-item ${entry.actor === 'AI' ? 'ai' : 'pm'}${at === index ? ' on' : at < index ? ' past' : ''}`}
                  onClick={() => onIndex(at)}
                >
                  <span className="tour-flow-mark">{entry.actor === 'AI' ? <BotIcon /> : <PersonIcon />}</span>
                  <span className="tour-flow-num">{String(entry.flow).padStart(2, '0')}</span>
                  <span>{entry.label}</span>
                </button>
              );
            })}
            <small className="tour-flow-support">THROUGHOUT</small>
            {STEPS.filter((entry) => entry.key === 'agent' || entry.key === 'dashboard').map((entry) => {
              const at = STEPS.indexOf(entry);
              return (
                <button
                  key={entry.key}
                  type="button"
                  className={`tour-flow-item support${at === index ? ' on' : ''}`}
                  onClick={() => onIndex(at)}
                >
                  <span className="tour-flow-mark">{entry.actor === 'AI' ? <BotIcon /> : <PersonIcon />}</span>
                  <span>{entry.title}</span>
                </button>
              );
            })}
          </aside>
          <section className="tour-main">{content(true)}</section>
        </div>
      )}
    </div>
  );
}
