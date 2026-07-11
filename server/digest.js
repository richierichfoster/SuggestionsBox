import { db } from './db.js';

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const FROM_EMAIL = process.env.DIGEST_FROM_EMAIL || 'Suggestions Box <notifications@suggestionsbox.com.au>';
const APP_BASE_URL = 'https://app.suggestionsbox.com.au';

const STATUS_LABELS = {
  sent: 'Sent', seen: 'Seen', acknowledged: 'Acknowledged',
  in_progress: 'In progress', actioned: 'Actioned', not_planned: 'Not planned',
};

// Returns the UTC start/end instants that correspond to a full calendar day
// in Melbourne local time, plus a human-readable date label. Uses the
// Intl API to read Melbourne's actual current offset (+10 or +11 depending
// on daylight saving) rather than hardcoding it, so this stays correct
// across DST transitions without needing any manual adjustment.
export function getMelbourneDayBounds(referenceDate = new Date()) {
  const dateParts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Australia/Melbourne', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(referenceDate);
  const y = dateParts.find((p) => p.type === 'year').value;
  const m = dateParts.find((p) => p.type === 'month').value;
  const d = dateParts.find((p) => p.type === 'day').value;

  function melbourneOffsetMinutesAt(utcDate) {
    const tzPart = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Australia/Melbourne', timeZoneName: 'shortOffset',
    }).formatToParts(utcDate).find((p) => p.type === 'timeZoneName').value; // e.g. "GMT+11"
    const match = tzPart.match(/GMT([+-]\d+)/);
    return match ? parseInt(match[1], 10) * 60 : 660;
  }

  // Rough guess treating Y-M-D as UTC midnight, then correct using the real
  // Melbourne offset at that instant — accurate for this purpose even on
  // the couple of DST-transition days per year.
  const guessUtc = new Date(`${y}-${m}-${d}T00:00:00Z`);
  const offsetMin = melbourneOffsetMinutesAt(guessUtc);
  const startUtc = new Date(guessUtc.getTime() - offsetMin * 60000);
  const endUtc = new Date(startUtc.getTime() + 24 * 60 * 60 * 1000);

  return { startUtc, endUtc, dateLabel: `${d}/${m}/${y}` };
}

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function noteRowHtml(n) {
  const statusColor = n.status === 'actioned' ? '#5E7A1F' : '#6E6A63';
  return `
    <tr>
      <td style="padding:12px 0; border-bottom:1px solid #EDE0CC;">
        <div style="font-size:14px; color:#2E2B28; line-height:1.5; margin-bottom:4px;">"${escapeHtml(n.text)}"</div>
        <div style="font-family:monospace; font-size:11px; color:#6E6A63;">
          ${n.votes.length} vote${n.votes.length === 1 ? '' : 's'} ·
          <span style="color:${statusColor};">${STATUS_LABELS[n.status] || n.status}</span>
        </div>
      </td>
    </tr>`;
}

function buildDigestHtml(business, customerNotes, teamNotes) {
  const dashboardUrl = `${APP_BASE_URL}/dashboard.html`;
  const totalCount = customerNotes.length + teamNotes.length;

  const sectionHtml = (title, notes) => {
    if (notes.length === 0) return '';
    return `
      <tr><td style="padding:20px 0 4px;"><div style="font-family:sans-serif; font-weight:700; font-size:13px; color:#B84B29; text-transform:uppercase; letter-spacing:.04em;">${title}</div></td></tr>
      <tr><td><table width="100%" cellpadding="0" cellspacing="0">${notes.map(noteRowHtml).join('')}</table></td></tr>`;
  };

  const bodyHtml = totalCount === 0
    ? `<tr><td style="padding:30px 0; text-align:center; color:#6E6A63; font-size:14px;">No new notes today — nice and quiet.</td></tr>`
    : sectionHtml('From customers', customerNotes) + sectionHtml('From your team', teamNotes);

  return `
<!DOCTYPE html>
<html>
<body style="margin:0; padding:0; background:#FBF1E2; font-family:-apple-system,Segoe UI,Roboto,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#FBF1E2; padding:30px 0;">
    <tr><td align="center">
      <table width="100%" style="max-width:520px; background:#FFFCF6; border-radius:16px; overflow:hidden;" cellpadding="0" cellspacing="0">
        <tr><td style="background:#E2653A; padding:24px 28px;">
          <div style="font-family:sans-serif; font-weight:700; font-size:18px; color:#FBF1E2;">SuggestionsBox</div>
          <div style="font-family:sans-serif; font-size:13px; color:rgba(251,241,226,.85); margin-top:2px;">Your notes for ${escapeHtml(business.businessName)}</div>
        </td></tr>
        <tr><td style="padding:24px 28px 8px;">
          <table width="100%" cellpadding="0" cellspacing="0">${bodyHtml}</table>
        </td></tr>
        <tr><td style="padding:8px 28px 28px;">
          <a href="${dashboardUrl}" style="display:inline-block; background:#E2653A; color:#FFFCF6; font-family:sans-serif; font-weight:600; font-size:14px; text-decoration:none; padding:12px 22px; border-radius:10px; margin-top:12px;">Log in to reply</a>
        </td></tr>
      </table>
      <div style="font-family:monospace; font-size:10.5px; color:#6E6A63; margin-top:16px;">Suggestions Box · Daily digest</div>
    </td></tr>
  </table>
</body>
</html>`;
}

async function sendEmail(to, subject, html) {
  if (!RESEND_API_KEY) {
    console.error('[digest] RESEND_API_KEY is not configured — skipping send.');
    return { ok: false, reason: 'not_configured' };
  }
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${RESEND_API_KEY}` },
      body: JSON.stringify({ from: FROM_EMAIL, to: [to], subject, html }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.error(`[digest] Resend returned ${res.status}: ${body}`);
      return { ok: false, reason: `http_${res.status}` };
    }
    return { ok: true };
  } catch (err) {
    console.error('[digest] Send failed:', err.message);
    return { ok: false, reason: err.message };
  }
}

// Builds and sends one business's digest for the given day window. Exported
// separately from the scheduler so it can be triggered manually (for
// testing, or a "send now" admin action) without waiting for the clock.
export async function sendDigestForBusiness(business, { startUtc, endUtc, dateLabel }) {
  if (business.digestEnabled === false) {
    return { businessId: business.id, businessName: business.businessName, ok: false, reason: 'disabled_by_business' };
  }

  const notesToday = (business.notes || []).filter((n) => {
    const createdAt = new Date(n.createdAt);
    return createdAt >= startUtc && createdAt < endUtc;
  });
  const customerNotes = notesToday.filter((n) => (n.lane || 'customer') === 'customer');
  const teamNotes = notesToday.filter((n) => n.lane === 'employee');
  const totalCount = customerNotes.length + teamNotes.length;

  if (totalCount === 0 && business.digestSkipEmpty) {
    return { businessId: business.id, businessName: business.businessName, notesCount: 0, ok: false, reason: 'skipped_empty_day' };
  }

  const html = buildDigestHtml(business, customerNotes, teamNotes);
  const subject = totalCount === 0
    ? `Your notes for ${dateLabel} — all quiet today`
    : `Your notes for ${dateLabel} — ${totalCount} new`;

  const recipient = business.digestEmail || business.email;
  const result = await sendEmail(recipient, subject, html);
  return { businessId: business.id, businessName: business.businessName, notesCount: totalCount, ...result };
}

export async function sendDailyDigests(referenceDate = new Date()) {
  await db.read();
  const bounds = getMelbourneDayBounds(referenceDate);
  const results = [];
  for (const business of db.data.businesses) {
    if (!business.email) continue;
    try {
      results.push(await sendDigestForBusiness(business, bounds));
    } catch (err) {
      console.error(`[digest] Failed for business ${business.id}:`, err.message);
      results.push({ businessId: business.id, ok: false, reason: err.message });
    }
  }
  return results;
}

// Checks once a minute whether it's 23:59 in Melbourne and today's digest
// hasn't already gone out yet. Tracks the last-sent date in the database
// itself (not just in memory) so a server restart around midnight can't
// cause a duplicate or a missed send.
export function startDigestScheduler() {
  setInterval(async () => {
    try {
      const now = new Date();
      const melbourneTime = new Intl.DateTimeFormat('en-US', {
        timeZone: 'Australia/Melbourne', hour: '2-digit', minute: '2-digit', hour12: false,
      }).format(now);
      if (melbourneTime !== '23:59') return;

      await db.read();
      const { dateLabel } = getMelbourneDayBounds(now);
      if (db.data.lastDigestSentDate === dateLabel) return;

      console.log(`[digest] Sending daily digests for ${dateLabel}...`);
      const results = await sendDailyDigests(now);
      console.log(`[digest] Sent ${results.filter((r) => r.ok).length}/${results.length} successfully.`);

      db.data.lastDigestSentDate = dateLabel;
      await db.write();
    } catch (err) {
      console.error('[digest] Scheduler tick failed:', err.message);
    }
  }, 60 * 1000);
  console.log('[digest] Daily digest scheduler started (checks every minute, sends at 23:59 Melbourne time).');
}
