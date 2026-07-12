import { db } from './db.js';

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const FROM_EMAIL = process.env.DIGEST_FROM_EMAIL || 'Suggestions Box <notifications@suggestionsbox.com.au>';
const APP_BASE_URL = 'https://app.suggestionsbox.com.au';

const STATUS_LABELS = {

  sent: 'Sent', seen: 'Seen', acknowledged: 'Acknowledged',
  in_progress: 'In progress', actioned: 'Actioned', not_planned: 'Not planned',
};

const DOT_STRIP_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAA6AAAAAUCAYAAACTdlBPAAAACXBIWXMAAAsTAAALEwEAmpwYAAACqElEQVR4nO3dwWrCQBSF4bz/Y2rbXYVqHReJ3DIjXRSaNImNJM63GBDUYbj+99xzSNQmuhSWGmAAAxjAAAYwgAEMYAADGMBALFyDBmQgwwAGMIABDGAAAxjAAAYwgIF4QA0EUKARGwxgAAMYwAAGMIABDGAAAyGAgoAQYAADGMAABjCAAQxgAAMYiGepgSugK/gQLDXAAAYwgAEMYAADGMAABqKCGgigK/gQLDXAAAYwgAEMYAADGMAABqKCGowIoOe4Xt6jO71Fe9yXlR9fL4fy3P2HsL/64Ed/0Qf6ab6Yj/wDf8Uf8s/yRVSQj4YDaPsZ3ek12o/drys/l18z+3D2Vx/86C/6QD/NF/ORf+Cv+EP+Wb6IWvLRQAA9D775xyFnJWX7qw9+9Bd9oJ/mi/nIP/BX/CH/LF9ERfmoN4Dmy6Z/vfl73S6nTjug/dUHP/qLPtBP88V85B/4K/6Qf5YvUlX5qDeAlnt2Rx4wv3bqAe2vPvjRX/SBfpov5iP/wF/xh/yzfJGqyke9AbR8YXTkAfNrpx7Q/uqDH/1FH+in+WI+8g/8FX/IP8sXqap89E8B9GXhAthfffCjv+gD/TRfzEf+gb/iD/ln+aLdeD5yC+7GL2HbX33wo7/oA/00X8xH/oG/4g/559hIvhj4EaLDwl9Stb/64Ed/0Qf6ab6Yj/wDf8Uf8s/yRVSUj/wNy8Z/xtj+6oMf/UUf6Kf5Yj7yD/wVf8g/x0byRbP2Pyq1v/rgR3/RB/ppvpiP/AN/xR/yz/LF7inyUTMmyebLqeWe3vzF0uO+PL5dlp2TjO2vPvjRX/SBfpov5iP/wF/xh/yzfBEV5qMRAdRSAwxgAAMYwAAGMIABDGAAAxhId9dAANVIGgkDGMAABjCAAQxgAAMYwEA8ogZfyfgx3lWXHiMAAAAASUVORK5CYII=';
const LOGO_PNG_BASE64 = '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';

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
    <tr><td style="padding-bottom:12px;">
      <table width="100%" cellpadding="0" cellspacing="0" style="background:#FFFFFF; border:1px solid #EDE0CC; border-radius:10px; overflow:hidden;">
        <tr><td style="line-height:0; font-size:0;">
          <img src="data:image/png;base64,${DOT_STRIP_BASE64}" width="100%" height="5" alt="" style="display:block; width:100%; height:5px; border:0;">
        </td></tr>
        <tr><td style="padding:14px 16px 14px;">
          <div style="font-size:14px; color:#2E2B28; line-height:1.5; margin-bottom:8px;">"${escapeHtml(n.text)}"</div>
          <table cellpadding="0" cellspacing="0"><tr>
            <td style="font-family:monospace; font-size:11px; color:#6E6A63; padding-right:8px;">${n.votes.length} vote${n.votes.length === 1 ? '' : 's'}</td>
            <td style="font-family:monospace; font-size:11px; color:${statusColor};">· ${STATUS_LABELS[n.status] || n.status}</td>
          </tr></table>
        </td></tr>
      </table>
    </td></tr>`;
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
<body style="margin:0; padding:0; background:#FCF6EC; font-family:-apple-system,Segoe UI,Roboto,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#FCF6EC; padding:30px 0;">
    <tr><td align="center">
      <table width="100%" style="max-width:520px; background:#FFFFFF; border-radius:16px; overflow:hidden; border:1px solid #EDE0CC;" cellpadding="0" cellspacing="0">
        <tr><td style="background:#FCF6EC; padding:22px 28px; border-bottom:1px solid #EDE0CC;">
          <img src="data:image/png;base64,${LOGO_PNG_BASE64}" alt="Suggestions Box" style="height:37px; display:block; border:0;">
          <div style="font-family:sans-serif; font-size:13px; color:#6E6A63; margin-top:8px;">Your notes for ${escapeHtml(business.businessName)}</div>
        </td></tr>
        <tr><td style="padding:24px 28px 8px;">
          <table width="100%" cellpadding="0" cellspacing="0">${bodyHtml}</table>
        </td></tr>
        <tr><td style="padding:8px 28px 28px;">
          <a href="${dashboardUrl}" style="display:inline-block; background:#E2653A; color:#FFFFFF; font-family:sans-serif; font-weight:600; font-size:14px; text-decoration:none; padding:12px 22px; border-radius:10px; margin-top:12px;">Log in to reply</a>
        </td></tr>
      </table>
      <div style="font-family:monospace; font-size:10.5px; color:#6E6A63; margin-top:16px;">Suggestions Box · Daily digest</div>
    </td></tr>
  </table>
</body>
</html>`;
}

export async function sendEmail(to, subject, html) {
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
