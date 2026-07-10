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
    flaggedWords: flagged,
    suggestion: rewrite,
    message: "That reads as an attack rather than feedback about the issue. Here's a version without it — or you can edit it yourself.",
  };
}

const MODERATION_SYSTEM_PROMPT = `You moderate short feedback notes on a customer/staff feedback platform for small local businesses.

Flag a note if it contains either of these:
1. A genuine personal attack, insult, hate speech, threat, or harassment directed at a specific person (an employee, the owner, another customer, etc).
2. Profanity, swearing, or crude/vulgar language — even if it's aimed at the business rather than a person, and even if it's mild.

Do NOT flag feedback just for being negative, blunt, harsh, or critical — that is exactly the kind of feedback this platform exists to collect, and should always be allowed through, however strongly or bluntly worded, AS LONG AS it doesn't use profanity and doesn't attack a specific person. "The wait was way too long and the food was cold" is allowed. "This place is terrible and I won't be back" is allowed. "This business is s***" or any note using a swear word is not allowed, regardless of who or what it's aimed at. "The chef is a lazy idiot who should be fired" is not allowed, because it attacks a person.

Respond with ONLY raw JSON, no markdown formatting, no code fences, no explanation outside the JSON. Use exactly one of these two shapes:

If the note is fine: {"ok": true}

If the note should be flagged: {"ok": false, "message": "<one short sentence, spoken directly to the person writing the note, explaining why>", "suggestion": "<a rewritten version that keeps their underlying feedback but removes the profanity or personal attack>"}`;

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
