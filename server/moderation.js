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

const MODERATION_SYSTEM_PROMPT = `You moderate short feedback notes on a customer/staff feedback platform for small local businesses.

There are two kinds of issues, and they get different treatment:

BLOCK (severity: "block") — the note cannot be posted until fixed:
1. A genuine personal attack, insult, hate speech, threat, or harassment directed at a specific person (an employee, the owner, another customer, etc).
2. Profanity, swearing, or crude/vulgar language — even mild, even if aimed at the business rather than a person.

NUDGE (severity: "nudge") — gently encourage improvement, but the person can still choose to send it as-is:
3. Negative or critical feedback that names NO specific aspect, topic, or detail at all — pure unattached sentiment that the owner truly can't do anything with. Err heavily on the side of NOT nudging: if the note mentions any specific thing at all (a subject like "the menu," "the wait," "the staff," "parking," "prices," "not enough X," "too slow," "cold food," etc.) — even briefly, even without a full explanation — that counts as specific enough and should NOT be nudged. Only nudge notes that are pure sentiment with zero subject: "this business is not that good," "wasn't great," "meh," "bad experience," "not impressed." The moment a note names what the sentiment is even loosely about, let it through.

When genuinely unsure whether something is specific enough, do NOT nudge — false positives here are worse than false negatives, since the goal is to avoid friction for people who did give real feedback.

Do NOT flag feedback (of either kind) just for being negative, blunt, harsh, or critical, AS LONG AS it's specific enough to act on and doesn't use profanity or attack a person. "The wait was way too long and the food was cold" is fine — specific and actionable. "This business is terrible, the staff ignored me for 20 minutes" is fine. "The menu needs to be better" is fine — it names the menu as the subject. "There is not enough on it" (referring to the menu) is fine — it names the specific gripe (quantity/variety). Brief POSITIVE feedback like "Great service, thanks!" is always fine even without detail — there's nothing to fix from praise, so no nudge is needed there. Only nudge vague feedback when it's negative/critical and gives the owner nothing to work with.

Respond with ONLY raw JSON, no markdown formatting, no code fences, no explanation outside the JSON. Use exactly one of these two shapes:

If the note is fine: {"ok": true}

If the note should be blocked or nudged: {"ok": false, "severity": "block" | "nudge", "message": "<one short sentence, spoken directly to the person writing the note, explaining why>", "suggestion": "<a rewritten version — for BLOCK, keep their underlying feedback but remove the profanity/attack; for NUDGE, keep their sentiment but add a plausible specific detail they could confirm or edit>"}`;

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
