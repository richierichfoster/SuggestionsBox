// Tone moderation. Tries an AI-based check first (via the Anthropic API,
// if ANTHROPIC_API_KEY is configured) since it can tell the difference
// between a genuine personal attack and blunt-but-legitimate feedback far
// better than keyword matching. Falls back to the keyword check below if
// the API key isn't set, the call fails, or it times out — so a note is
// never blocked from being submitted just because the AI call had a bad
// moment.

const INSULT_PATTERNS = [
  /\bidiots?\b/i,
  /\bstupid\b/i,
  /\bmorons?\b/i,
  /\buseless\b/i,
  /\bincompetent\b/i,
  /\bpathetic\b/i,
  /\btrash\b/i,
  /\bgarbage\b/i,
  /\bhate\b/i,
  /\bscam(mer)?s?\b/i,
  /\bshit(ty)?\b/i,
  /\bf+u+c*k+\w*/i,
  /\ba+s+s+h+o+l+e+s?\b/i,
  /\bbitch(es|y)?\b/i,
  /\bdamn\b/i,
  /\bcrap\b/i,
];

function checkToneKeywords(text) {
  // NOTE: this fallback only catches explicit insults/profanity (BLOCK).
  // It has no way to detect the new MEDIUM case — feedback that personally
  // targets a named individual without being abusive — since that needs
  // semantic understanding of "is this about a person or the business,"
  // not just word matching. When the AI check is unavailable (no API key,
  // timeout, or error), that category of note will pass through unflagged
  // here. This is a real gap worth knowing about: MEDIUM-severity
  // protection only works while ANTHROPIC_API_KEY is configured.
  const flagged = [];
  for (const pattern of INSULT_PATTERNS) {
    const match = text.match(pattern);
    if (match) flagged.push(match[0]);
  }

  if (flagged.length === 0) {
    return { ok: true };
  }

  // Offer a simple rewrite: strip the flagged words out and clean up spacing.
  let rewrite = text;
  for (const word of flagged) {
    rewrite = rewrite.replace(new RegExp(`\\b${word}\\b`, 'gi'), '').replace(/\s{2,}/g, ' ').trim();
  }

  return {
    ok: false,
    severity: 'block',
    flaggedWords: flagged,
    suggestion: rewrite,
    message: "That reads as an attack rather than feedback about the issue. Here's a version without it — or you can edit it yourself.",
  };
}

const MODERATION_SYSTEM_PROMPT = `You moderate short feedback notes on a customer/staff feedback platform for small local businesses. This platform exists for feedback ABOUT A BUSINESS — its service, products, facilities, or processes — not for messages about specific individual people.

There are three kinds of issues, and they get different treatment:

BLOCK (severity: "block") — the note cannot be posted until fixed:
1. A genuine personal attack, insult, hate speech, threat, or harassment directed at a specific person (an employee, the owner, another customer, etc).
2. Profanity, swearing, or crude/vulgar language — even mild, even if aimed at the business rather than a person.

MEDIUM (severity: "medium") — not abusive, but still not suitable to post publicly because it's really about a specific person rather than the business:
3. Feedback that names or clearly identifies an individual (by name, or a specific enough description like "the tall guy with the beard on the counter") and makes a personal judgment about THAT PERSON — their competence, attitude, manner, appearance, etc — even when phrased politely and without any insult. Example: "Sarah at the front desk was really unhelpful and seemed uninterested" names a specific person and judges them personally — MEDIUM, even though it's calm and specific. Contrast with "The front desk staff were unhelpful" — plural, describing the service generally rather than one identifiable person — that's fine, not MEDIUM.
   The test: does removing the personal identifier still leave a complete, useful piece of feedback about the business? "The wait was too long and no one apologised" — yes, still works, about the business — fine. "Dave never smiles and made me uncomfortable" — no, the entire point is about Dave as a person — MEDIUM.
   Do NOT apply MEDIUM just because a role or department is mentioned generically (e.g. "the kitchen," "reception," "the manager on duty") — only when the note is genuinely centred on a specific identifiable individual rather than the business's service.

NUDGE (severity: "nudge") — gently encourage improvement, but the person can still choose to send it as-is:
4. Negative or critical feedback that names NO specific aspect, topic, or detail at all — pure unattached sentiment that the owner truly can't do anything with. Err heavily on the side of NOT nudging: if the note mentions any specific thing at all (a subject like "the menu," "the wait," "the staff," "parking," "prices," "not enough X," "too slow," "cold food," etc.) — even briefly, even without a full explanation — that counts as specific enough and should NOT be nudged. Only nudge notes that are pure sentiment with zero subject: "this business is not that good," "wasn't great," "meh," "bad experience," "not impressed." The moment a note names what the sentiment is even loosely about, let it through.

When genuinely unsure between MEDIUM and fine, ask whether an ordinary business owner reading this in public would recognise a specific co-worker or staff member from it. If yes, MEDIUM. When genuinely unsure whether something is specific enough for NUDGE, do NOT nudge — false positives here are worse than false negatives, since the goal is to avoid friction for people who did give real feedback.

Do NOT flag feedback (of any kind) just for being negative, blunt, harsh, or critical, AS LONG AS it's about the business generally, specific enough to act on, and doesn't use profanity, attack, or personally single out an individual. "The wait was way too long and the food was cold" is fine — specific and actionable, about the business. "This business is terrible, staff ignored me for 20 minutes" is fine — "staff" is generic, not one identifiable person. "The menu needs to be better" is fine. Brief POSITIVE feedback like "Great service, thanks!" is always fine even without detail, and even if it names someone ("Sarah was fantastic!") — positive callouts of a named individual aren't MEDIUM, since there's no risk in publicly praising someone by name. MEDIUM only applies to negative/critical personal judgments of an identifiable individual.

Respond with ONLY raw JSON, no markdown formatting, no code fences, no explanation outside the JSON. Use exactly one of these shapes:

If the note is fine: {"ok": true}

If the note should be blocked, flagged as medium, or nudged: {"ok": false, "severity": "block" | "medium" | "nudge", "message": "<one short sentence, spoken directly to the person writing the note, explaining why>", "suggestion": "<a rewritten version — for BLOCK, keep their underlying feedback but remove the profanity/attack; for MEDIUM, keep their feedback but rewritten to describe the business/service issue without singling out the individual; for NUDGE, keep their sentiment but add a plausible specific detail they could confirm or edit>"}`;

async function checkToneAI(text) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null; // not configured — caller falls back to keyword check

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 300,
        temperature: 0.2,
        system: MODERATION_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: text }],
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      console.error(`[moderation] Anthropic API returned ${res.status}`);
      return null;
    }

    const data = await res.json();
    const raw = data.content?.[0]?.text?.trim();
    if (!raw) return null;

    // Defensive parsing — strip markdown code fences if the model adds them
    // despite instructions not to, then parse.
    const cleaned = raw.replace(/^```(json)?/i, '').replace(/```$/, '').trim();
    const parsed = JSON.parse(cleaned);

    if (typeof parsed.ok !== 'boolean') return null;
    return parsed;
  } catch (err) {
    console.error('[moderation] AI tone check failed:', err.message);
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

export async function checkTone(text) {
  const aiResult = await checkToneAI(text);
  if (aiResult) return aiResult;
  return checkToneKeywords(text);
}
