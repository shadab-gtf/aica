import type { Confidence, TaskKind } from '@aica/shared';

/**
 * The natural-language task router (specification section 61).
 *
 * Deterministic classification runs first and the model is consulted only for
 * genuinely ambiguous input. That order matters for three reasons: an explicit
 * command must never be reinterpreted, the common phrasings are unambiguous
 * enough to match reliably, and a round trip to a model to classify "review
 * this component" is latency and cost spent on nothing.
 *
 * The classification then selects which tools and skills are loaded, so getting
 * it right narrows the prompt rather than widening it.
 */

export interface Classification {
  readonly kind: TaskKind;
  readonly confidence: Confidence;
  readonly decidedBy: 'explicit' | 'deterministic' | 'model';
  readonly rationale: string;
  /** Runners-up, so the UI can offer them when confidence is low. */
  readonly alternatives: readonly TaskKind[];
}

interface Rule {
  readonly kind: TaskKind;
  /** Phrases that are strong evidence on their own. */
  readonly strong: readonly RegExp[];
  /** Phrases that contribute but are not decisive alone. */
  readonly weak?: readonly RegExp[];
}

const RULES: readonly Rule[] = [
  {
    kind: 'API_INTEGRATION',
    strong: [
      /\b(?:integrate|wire\s*up|hook\s*up|connect)\b[^.]{0,60}\b(?:api|endpoint|service)\b/i,
      /\b(?:api|endpoint)\b[^.]{0,40}\b(?:into|to|with)\b[^.]{0,40}\b(?:page|component|form|screen|flow|checkout|module)\b/i,
      /\badd\b[^.]{0,40}\b(?:api\s*call|endpoint\s*call|request)\b/i,
      /\bcall\b[^.]{0,30}\b(?:from|in)\b[^.]{0,30}\b(?:component|page|hook|service)\b/i,
    ],
    weak: [/\bintegration\b/i, /\bpayment\b/i],
  },
  {
    kind: 'API_CHANGE_IMPACT',
    strong: [
      /\bapi\b[^.]{0,30}\bchanged\b/i,
      /\bwhat\b[^.]{0,20}\bbroke\b/i,
      /\bbreaking\s+change/i,
      /\b(?:impact|blast\s*radius)\b[^.]{0,30}\b(?:of|for)\b[^.]{0,30}\b(?:api|endpoint|schema)\b/i,
      /\bwho\s+(?:uses|calls)\b[^.]{0,30}\b(?:endpoint|api)\b/i,
      // "Find every place this endpoint is used" is an API-usage question, not
      // a generic code search, so mentioning an endpoint tips it here.
      /\b(?:find|show|list)\b[^.]{0,40}\b(?:endpoint|api)\b[^.]{0,30}\b(?:used|usage|called|callers?)\b/i,
    ],
    weak: [/\bendpoint\b/i, /\bapi\b/i],
  },
  {
    kind: 'API_ANALYSIS',
    strong: [
      /\b(?:which|what)\s+endpoint\b/i,
      /\banalyz|analys/i,
      /\bwhat\b[^.]{0,30}\b(?:parameters|body|schema|auth)\b[^.]{0,20}\b(?:required|need)/i,
      /\b(?:list|show|describe)\b[^.]{0,30}\bendpoints?\b/i,
    ],
    weak: [/\bspec(?:ification)?\b/i, /\bopenapi|swagger|postman\b/i],
  },
  {
    kind: 'BUG_FIX',
    strong: [
      /\b(?:fix|repair|debug)\b/i,
      /\bwhy\b[^.]{0,40}\b(?:failing|broken|not\s+work|error|crash)/i,
      /\b(?:is|are)\s+(?:failing|broken)\b/i,
      /\bthrow(?:s|ing)?\s+an?\s+error\b/i,
    ],
    weak: [/\bbug\b/i, /\bexception\b/i, /\bstack\s*trace\b/i],
  },
  {
    kind: 'FRONTEND_REVIEW',
    strong: [
      /\breview\b[^.]{0,40}\b(?:component|page|ui|frontend|form|screen)\b/i,
      /\b(?:find|check)\b[^.]{0,30}\bfrontend\b[^.]{0,20}\b(?:issues?|problems?|errors?)\b/i,
      /\b(?:loading|error|empty)\s+state\b/i,
      /\bhydration\b/i,
      /\brerender/i,
    ],
  },
  {
    kind: 'SECURITY_REVIEW',
    strong: [
      /\bsecurity\s+(?:review|audit|check)\b/i,
      /\b(?:find|check)\b[^.]{0,30}\b(?:vulnerabilit|secrets?\s+in|xss|csrf|ssrf|sql\s*injection)\b/i,
      /\bhardcoded\s+(?:secret|key|credential|password)\b/i,
    ],
  },
  {
    kind: 'PERFORMANCE_REVIEW',
    strong: [
      /\bperformance\s+(?:review|audit|issue|problem)\b/i,
      /\b(?:slow|too\s+slow|laggy)\b/i,
      /\bn\s*\+\s*1\b/i,
      /\b(?:duplicate|redundant|unnecessary)\s+(?:requests?|api\s+calls?|fetch)/i,
      /\bbundle\s+size\b/i,
    ],
  },
  {
    kind: 'TEST_GENERATION',
    strong: [
      /\b(?:write|add|generate|create)\b[^.]{0,30}\btests?\b/i,
      /\btest\s+coverage\b/i,
      /\bunit\s+tests?\b/i,
    ],
  },
  {
    kind: 'REFACTOR',
    strong: [
      /\brefactor\b/i,
      /\b(?:extract|rename|move|deduplicate|clean\s*up)\b[^.]{0,40}\b(?:into|to|from)\b/i,
      /\bsimplify\b/i,
    ],
  },
  {
    kind: 'CODE_ANALYSIS',
    strong: [
      /\b(?:where|find)\b[^.]{0,30}\b(?:is|are)\b[^.]{0,20}\b(?:used|called|defined|imported)\b/i,
      /\b(?:explain|walk\s+me\s+through|how\s+does)\b[^.]{0,40}\b(?:work|flow|code)\b/i,
      /\bfind\s+(?:every|all)\s+(?:place|usage|reference)/i,
      /\bdependency\s+graph\b/i,
    ],
  },
  {
    kind: 'DOCUMENTATION',
    strong: [
      /\b(?:write|add|update|generate)\b[^.]{0,30}\b(?:docs?|documentation|readme|jsdoc|comments?)\b/i,
      /\bdocument\b[^.]{0,30}\b(?:this|the|api|function|module)\b/i,
    ],
  },
  {
    kind: 'MCP_TASK',
    strong: [
      /\bmcp\b/i,
      /\b(?:connect|install|configure|add)\b[^.]{0,30}\b(?:mcp\s+server|tool\s+server)\b/i,
    ],
  },
];

/**
 * Overlap resolution.
 *
 * Some phrasings match two kinds by construction rather than by accident.
 * "Find every place X is used" is a code search when X is a symbol and an API
 * impact question when X is an endpoint. Naming the overlap and resolving it
 * explicitly is more honest, and far easier to reason about later, than tuning
 * pattern scores until one happens to win.
 *
 * The preferred kind is placed one point ahead, not far ahead, so the resulting
 * confidence stays MEDIUM and the alternative is still offered.
 */
interface Disambiguation {
  readonly when: readonly RegExp[];
  readonly prefer: TaskKind;
  readonly over: readonly TaskKind[];
  readonly because: string;
}

const DISAMBIGUATIONS: readonly Disambiguation[] = [
  {
    when: [/\bendpoints?\b/i, /\bapi\s+route\b/i, /\b(?:GET|POST|PUT|PATCH|DELETE)\s+\//],
    prefer: 'API_CHANGE_IMPACT',
    over: ['CODE_ANALYSIS'],
    because: 'the subject is an API endpoint rather than a code symbol',
  },
];

/**
 * Commands mapped straight to a kind. A user who invoked
 * "API Agent: Find Frontend Issues" has already classified the task, and
 * second-guessing that would be a bug.
 */
const EXPLICIT_COMMANDS: Readonly<Record<string, TaskKind>> = {
  'analyze-project': 'CODE_ANALYSIS',
  'analyze-api': 'API_ANALYSIS',
  'create-integration-plan': 'API_INTEGRATION',
  implement: 'API_INTEGRATION',
  'review-changes': 'CODE_ANALYSIS',
  'run-validation': 'CODE_ANALYSIS',
  'repair-errors': 'BUG_FIX',
  'explain-error': 'BUG_FIX',
  'find-api-usage': 'API_CHANGE_IMPACT',
  'find-frontend-issues': 'FRONTEND_REVIEW',
  'security-review': 'SECURITY_REVIEW',
  'performance-review': 'PERFORMANCE_REVIEW',
  'generate-tests': 'TEST_GENERATION',
};

export interface RouteInput {
  readonly text: string;
  /** Set when the request came from a command rather than free text. */
  readonly command?: string;
  /** True when an API specification has been imported for this project. */
  readonly hasApiCatalog?: boolean;
  /** File the user had open or selected, which sharpens ambiguous phrasing. */
  readonly activeFile?: string;
}

export class TaskRouter {
  classify(input: RouteInput): Classification {
    if (input.command) {
      const kind = EXPLICIT_COMMANDS[input.command];
      if (kind) {
        return {
          kind,
          confidence: 'HIGH',
          decidedBy: 'explicit',
          rationale: `The user invoked the "${input.command}" command.`,
          alternatives: [],
        };
      }
    }

    const text = input.text.trim();
    if (text.length === 0) {
      return {
        kind: 'GENERAL_DEVELOPMENT',
        confidence: 'LOW',
        decidedBy: 'deterministic',
        rationale: 'No task text was supplied.',
        alternatives: [],
      };
    }

    const scores = new Map<TaskKind, number>();
    for (const rule of RULES) {
      let score = 0;
      for (const pattern of rule.strong) if (pattern.test(text)) score += 3;
      for (const pattern of rule.weak ?? []) if (pattern.test(text)) score += 1;
      if (score > 0) scores.set(rule.kind, score);
    }

    // A frontend file in context is weak evidence for a frontend task, but only
    // where the text has already suggested review or debugging.
    if (input.activeFile && /\.(?:tsx|jsx|vue|svelte)$/.test(input.activeFile)) {
      if (scores.has('FRONTEND_REVIEW')) {
        scores.set('FRONTEND_REVIEW', (scores.get('FRONTEND_REVIEW') ?? 0) + 1);
      }
    }
    // Integration is only plausible when there is an API catalog to integrate.
    if (input.hasApiCatalog === false && scores.has('API_INTEGRATION')) {
      scores.set('API_INTEGRATION', (scores.get('API_INTEGRATION') ?? 0) - 2);
    }

    let overlapNote = '';
    for (const rule of DISAMBIGUATIONS) {
      if (!rule.when.some((pattern) => pattern.test(text))) continue;
      const preferred = scores.get(rule.prefer);
      if (preferred === undefined) continue;
      const highestOver = Math.max(0, ...rule.over.map((kind) => scores.get(kind) ?? 0));
      if (highestOver >= preferred) {
        scores.set(rule.prefer, highestOver + 1);
        overlapNote = ` (${rule.because})`;
      }
    }

    const ranked = [...scores.entries()]
      .filter(([, score]) => score > 0)
      .sort((a, b) => b[1] - a[1]);

    if (ranked.length === 0) {
      return {
        kind: 'GENERAL_DEVELOPMENT',
        confidence: 'LOW',
        decidedBy: 'deterministic',
        rationale: 'No classification rule matched; treating this as general development work.',
        alternatives: [],
      };
    }

    const [top, second] = ranked;
    const topKind = top?.[0] as TaskKind;
    const topScore = top?.[1] ?? 0;
    const secondScore = second?.[1] ?? 0;

    // A clear winner is high confidence; a near tie is not, and the caller is
    // expected to ask rather than guess (specification section 69, scenario 10).
    const margin = topScore - secondScore;
    const confidence: Confidence =
      topScore >= 3 && margin >= 3 ? 'HIGH' : topScore >= 3 || margin >= 2 ? 'MEDIUM' : 'LOW';

    return {
      kind: topKind,
      confidence,
      decidedBy: 'deterministic',
      rationale:
        margin >= 3
          ? `The request clearly describes ${humanize(topKind)}.`
          : `The request most closely matches ${humanize(topKind)}${overlapNote}, but ${humanize(
              (second?.[0] ?? topKind) as TaskKind,
            )} is also plausible.`,
      alternatives: ranked.slice(1, 3).map(([kind]) => kind),
    };
  }

  /**
   * Whether the model should be consulted. Only for input the deterministic
   * rules could not resolve, which keeps classification cheap in the common
   * case.
   */
  needsModelClassification(classification: Classification): boolean {
    return classification.decidedBy === 'deterministic' && classification.confidence === 'LOW';
  }
}

function humanize(kind: TaskKind): string {
  return kind.toLowerCase().replaceAll('_', ' ');
}
