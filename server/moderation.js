// Lightweight tone moderation. This is intentionally simple for the pilot —
// flags common insult patterns and suggests removing them, rather than
// silently blocking. A production version could swap this for an AI-based
// check (e.g. calling the Anthropic API) without changing the calling code.

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
];

export function checkTone(text) {
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
