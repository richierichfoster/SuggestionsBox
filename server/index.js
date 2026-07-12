import express from 'express';
import cors from 'cors';
import { db, initDb, newId } from './db.js';
import { checkTone } from './moderation.js';
import { sendDailyDigests, startDigestScheduler, getMelbourneDayBounds, sendEmail } from './digest.js';

function safetyAlertHtml(business, note) {
  return `
<!DOCTYPE html>
<html><body style="margin:0; padding:0; background:#FBF1E2; font-family:-apple-system,Segoe UI,Roboto,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#FBF1E2; padding:30px 0;">
    <tr><td align="center">
      <table width="100%" style="max-width:480px; background:#FFFCF6; border-radius:16px; overflow:hidden;" cellpadding="0" cellspacing="0">
        <tr><td style="background:#B85C4A; padding:22px 26px;">
          <div style="font-family:sans-serif; font-weight:700; font-size:16px; color:#fff;">⚠ Safety issue flagged</div>
          <div style="font-family:sans-serif; font-size:13px; color:rgba(255,255,255,.85); margin-top:2px;">${escapeHtmlForEmail(business.businessName)} · Team notes</div>
        </td></tr>
        <tr><td style="padding:24px 26px;">
          <div style="font-family:sans-serif; font-size:14px; color:#2E2B28; line-height:1.6; background:#FBEDE9; border-left:3px solid #B85C4A; border-radius:8px; padding:14px 16px; margin-bottom:20px;">
            "${escapeHtmlForEmail(note.text)}"
          </div>
          <a href="https://app.suggestionsbox.com.au/dashboard.html" style="display:inline-block; background:#B85C4A; color:#fff; font-family:sans-serif; font-weight:600; font-size:14px; text-decoration:none; padding:12px 22px; border-radius:10px;">View in dashboard →</a>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}

function escapeHtmlForEmail(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

async function sendSafetyIssueAlert(business, note) {
  if (!business.email) return;
  await sendEmail(
    business.email,
    `⚠ Safety issue flagged — ${business.businessName}`,
    safetyAlertHtml(business, note)
  );
}
import { hashPassword, verifyPassword, createToken } from './auth.js';
import { stripe, ensureGrowthPrices, growthPriceId, applyStripeEvent } from './stripe-billing.js';

const app = express();

const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || null;

// Registered before app.use(express.json()) below on purpose — Stripe's
// signature verification needs the exact raw request body, and once the
// global JSON parser has consumed/parsed it that's no longer available.
app.post('/api/billing/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  if (!stripe) return res.status(503).json({ error: 'Stripe is not configured on this server.' });

  let event;
  try {
    if (STRIPE_WEBHOOK_SECRET) {
      const signature = req.headers['stripe-signature'];
      event = stripe.webhooks.constructEvent(req.body, signature, STRIPE_WEBHOOK_SECRET);
    } else {
      // No webhook signing secret configured yet — this accepts events
      // unverified, which is only safe while you're still setting things
      // up. Create the webhook endpoint in the Stripe Dashboard and put
      // its signing secret in STRIPE_WEBHOOK_SECRET before going live, or
      // anyone could POST a fake "payment succeeded" event here.
      event = JSON.parse(req.body.toString('utf8'));
    }
  } catch (err) {
    console.error('[stripe] Webhook signature check failed:', err.message);
    return res.status(400).json({ error: `Webhook Error: ${err.message}` });
  }

  try {
    await applyStripeEvent(event);
    res.json({ received: true });
  } catch (err) {
    console.error('[stripe] Failed to process webhook event:', err.message);
    res.status(500).json({ error: 'Failed to process event' });
  }
});

app.use(cors());
app.use(express.json({ limit: '3mb' }));

// Simple fixed-code promo system for testing/pilot businesses — set as a
// comma-separated PROMO_CODES env var, e.g. "TESTFRIEND2026,PILOTFREE".
// Not a managed/tracked marketing system — just a lightweight bypass for
// the plan-change payment gate, ahead of real Stripe billing being wired
// in. A business that redeems a valid code stays free indefinitely until
// a platform admin manually revokes it.
function isValidPromoCode(code) {
  if (!code) return false;
  const validCodes = (process.env.PROMO_CODES || '').split(',').map((c) => c.trim().toUpperCase()).filter(Boolean);
  return validCodes.includes(code.trim().toUpperCase());
}

const STATUS_ORDER = ['sent', 'seen', 'acknowledged', 'in_progress', 'actioned', 'not_planned'];

await initDb();
await ensureGrowthPrices();

// Turns a free-text address into coordinates using OpenStreetMap's free
// Nominatim service — no API key needed. Returns null on any failure
// (bad address, service down, etc.) rather than throwing, since a
// business should still be able to save its profile even if geocoding
// doesn't resolve — it just won't show up in "near me" search until it does.
async function geocodeAddress(address) {
  if (!address || !address.trim()) return null;

  async function query(q) {
    const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=au&q=${encodeURIComponent(q)}`;
    const res = await fetch(url, { headers: { 'User-Agent': 'SuggestionsBox/1.0 (suggestionsbox.com.au)' } });
    if (!res.ok) {
      console.error(`[geocode] Nominatim returned ${res.status} ${res.statusText} for "${q}"`);
      return null;
    }
    const results = await res.json();
    if (!results.length) return null;
    return { lat: parseFloat(results[0].lat), lng: parseFloat(results[0].lon) };
  }

  try {
    const exact = await query(address);
    if (exact) {
      console.log(`[geocode] Resolved "${address}" -> ${exact.lat}, ${exact.lng}`);
      return exact;
    }

    // The exact street sometimes isn't in OpenStreetMap's data (especially
    // newer subdivisions). Falling back to just the last couple of words —
    // usually the suburb — still gets a usable pin for "near me" search,
    // which only needs rough accuracy, not the exact building.
    const words = address.trim().split(/\s+/);
    if (words.length > 2) {
      const suburbGuess = words.slice(-2).join(' ');
      const approx = await query(suburbGuess);
      if (approx) {
        console.log(`[geocode] "${address}" had no exact match; used suburb fallback "${suburbGuess}" -> ${approx.lat}, ${approx.lng}`);
        return approx;
      }
    }

    console.error(`[geocode] Nominatim returned zero results for "${address}" (including suburb fallback)`);
    return null;
  } catch (err) {
    console.error(`[geocode] Request failed for "${address}":`, err.message);
    return null;
  }
}

// Distance between two lat/lng points in kilometers (haversine formula).
function distanceKm(lat1, lng1, lat2, lng2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// --- Public: business info ---
app.get('/api/business', async (req, res) => {
  await db.read();
  res.json({ name: db.data.business.name });
});

// --- Public: check tone before submitting (used live as the person types) ---
app.post('/api/moderate', async (req, res) => {
  const { text } = req.body;
  if (typeof text !== 'string' || !text.trim()) {
    return res.status(400).json({ error: 'text is required' });
  }
  res.json(await checkTone(text));
});

// --- Public: list notes, sorted by vote count (most-backed first) ---
app.get('/api/notes', async (req, res) => {
  await db.read();
  const deviceId = req.query.deviceId || null;

  const notes = db.data.notes
    .map((n) => ({
      id: n.id,
      text: n.text,
      category: n.category,
      displayName: n.isAnonymous ? 'Anonymous customer' : n.authorName || 'Customer',
      voteCount: n.votes.length,
      hasVoted: deviceId ? n.votes.includes(deviceId) : false,
      status: n.status,
      createdAt: n.createdAt,
    }))
    .sort((a, b) => b.voteCount - a.voteCount);

  res.json(notes);
});

// --- Public: get one note with full status history ---
app.get('/api/notes/:id', async (req, res) => {
  await db.read();
  const deviceId = req.query.deviceId || null;
  const note = db.data.notes.find((n) => n.id === req.params.id);
  if (!note) return res.status(404).json({ error: 'not found' });

  res.json({
    id: note.id,
    text: note.text,
    category: note.category,
    displayName: note.isAnonymous ? 'Anonymous customer' : note.authorName || 'Customer',
    voteCount: note.votes.length,
    hasVoted: deviceId ? note.votes.includes(deviceId) : false,
    status: note.status,
    statusHistory: note.statusHistory,
    createdAt: note.createdAt,
  });
});

// --- Public: submit a new note ---
app.post('/api/notes', async (req, res) => {
  const { text, category, isAnonymous, authorName, deviceId, skipModerationCheck } = req.body;

  if (typeof text !== 'string' || !text.trim()) {
    return res.status(400).json({ error: 'text is required' });
  }
  if (!deviceId) {
    return res.status(400).json({ error: 'deviceId is required (used only for vote de-duplication)' });
  }

  // Re-check tone server-side even if the client already checked, unless
  // the person explicitly chose to send their own edited version through.
  // "nudge" severity is advisory only — the person may have already chosen
  // to send it as-is, so only "block" (attacks/profanity) actually stops
  // the note here.
  if (!skipModerationCheck) {
    const toneResult = await checkTone(text);
    if (!toneResult.ok && toneResult.severity !== 'nudge') {
      return res.status(422).json({ moderation: toneResult });
    }
  }

  await db.read();
  const note = {
    id: newId(),
    text: text.trim(),
    category: category || 'general',
    isAnonymous: !!isAnonymous,
    authorName: isAnonymous ? null : (authorName || '').trim() || null,
    votes: [deviceId], // the author automatically backs their own note
    status: 'sent',
    statusHistory: [{ status: 'sent', message: null, at: new Date().toISOString() }],
    createdAt: new Date().toISOString(),
  };
  db.data.notes.push(note);
  await db.write();

  res.status(201).json({ id: note.id });
});

// --- Public: vote / un-vote on a note ---
app.post('/api/notes/:id/vote', async (req, res) => {
  const { deviceId } = req.body;
  if (!deviceId) return res.status(400).json({ error: 'deviceId is required' });

  await db.read();
  const note = db.data.notes.find((n) => n.id === req.params.id);
  if (!note) return res.status(404).json({ error: 'not found' });

  const idx = note.votes.indexOf(deviceId);
  if (idx === -1) {
    note.votes.push(deviceId);
  } else {
    note.votes.splice(idx, 1);
  }
  await db.write();

  res.json({ voteCount: note.votes.length, hasVoted: idx === -1 });
});

// --- Owner-only: simple passcode check middleware ---
function requireOwner(req, res, next) {
  const passcode = req.headers['x-owner-passcode'];
  if (!passcode || passcode !== db.data.business.ownerPasscode) {
    return res.status(401).json({ error: 'invalid passcode' });
  }
  next();
}

app.post('/api/owner/login', async (req, res) => {
  await db.read();
  const { passcode } = req.body;
  if (passcode === db.data.business.ownerPasscode) {
    return res.json({ ok: true });
  }
  res.status(401).json({ ok: false });
});

// --- Owner-only: update a note's status ---
app.post('/api/owner/notes/:id/status', requireOwner, async (req, res) => {
  const { status, message } = req.body;
  if (!STATUS_ORDER.includes(status)) {
    return res.status(400).json({ error: `status must be one of: ${STATUS_ORDER.join(', ')}` });
  }

  await db.read();
  const note = db.data.notes.find((n) => n.id === req.params.id);
  if (!note) return res.status(404).json({ error: 'not found' });

  note.status = status;
  note.statusHistory.push({ status, message: message || null, at: new Date().toISOString() });
  await db.write();

  res.json({ ok: true });
});

// ============================================================
// Real account flow — for businesses signing up via the
// marketing site's "Get early access" / login pages. Separate
// from the single-business pilot passcode system above.
// ============================================================

// The owner login always has req.actingUser.id === business.id (set that
// way in requireSession below); a team member — even one with the "admin"
// business role — has their own id instead. This is how platform-wide
// super-admin access stays scoped to the one true owner account, never
// extended to someone merely promoted to "admin" within a single business.
function isOriginalOwner(req) {
  return req.actingUser.id === req.business.id;
}

// A session now resolves to a business PLUS an "acting user" — either the
// business owner (full access) or one of their team members (restricted
// by role). Everywhere downstream that used to just check req.business
// can now also check req.actingUser.role to decide what's allowed.
function requireSession(req, res, next) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  const session = token && db.data.sessions[token];
  if (!session) return res.status(401).json({ error: 'not logged in' });

  const business = db.data.businesses.find((b) => b.id === session.businessId);
  if (!business) return res.status(401).json({ error: 'not logged in' });

  // A suspended business (and anyone on its team) loses API access
  // immediately, even with a valid existing token — this is checked here
  // rather than only at login so an admin's suspend action takes effect
  // right away, not just for the next login.
  if (business.suspended) {
    return res.status(403).json({ error: 'suspended', suspendedReason: business.suspendedReason || null });
  }

  if (!session.teamMemberId) {
    req.business = business;
    req.actingUser = { id: business.id, name: business.ownerName || business.businessName, role: 'admin' };
    return next();
  }

  const teamMember = (business.teamMembers || []).find((m) => m.id === session.teamMemberId);
  if (!teamMember) return res.status(401).json({ error: 'not logged in' });

  req.business = business;
  req.actingUser = { id: teamMember.id, name: teamMember.name, role: teamMember.role };
  next();
}

// Restricts an endpoint to the business owner only — team members of any
// role are blocked. Used for settings, billing, and team management itself.
// (Named distinctly from the legacy requireOwner above, which is the old
// single-pilot-business passcode check and unrelated to this.)
function requireBusinessOwner(req, res, next) {
  if (req.actingUser.role !== 'admin') {
    return res.status(403).json({ error: 'Only the business owner can do this' });
  }
  next();
}

// A note's lane decides who can touch it: team members only ever see
// customer notes, managers and the owner see everything.
function canAccessLane(role, lane) {
  if (role === 'admin' || role === 'manager') return true;
  return (lane || 'customer') === 'customer';
}

app.post('/api/auth/signup', async (req, res) => {
  const { businessName, ownerName, email, password, plan, promoCode } = req.body;

  if (!businessName?.trim() || !email?.trim() || !password) {
    return res.status(400).json({ error: 'businessName, email, and password are required' });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }

  await db.read();
  const normalizedEmail = email.trim().toLowerCase();
  const existing = findAnyAccountByEmail(normalizedEmail);
  if (existing) {
    return res.status(409).json({ error: 'An account with that email already exists' });
  }

  const { hash, salt } = hashPassword(password);
  const requestedPlan = VALID_PLANS.includes(plan) ? plan : 'starter';
  const promoUnlocked = isValidPromoCode(promoCode);
  const business = {
    id: newId(),
    businessName: businessName.trim(),
    ownerName: (ownerName || '').trim() || null,
    email: normalizedEmail,
    passwordHash: hash,
    passwordSalt: salt,
    // Growth (and Business, which is custom/contact-sales anyway) is never
    // granted for free just because it was selected on the signup form —
    // only a valid promo code skips payment. Everyone else starts on
    // Starter; the frontend sends them straight to Stripe Checkout right
    // after this if they picked Growth (see `needsCheckout` below).
    plan: promoUnlocked ? requestedPlan : 'starter',
    stripeCustomerId: null,
    stripeSubscriptionId: null,
    planStatus: 'active',
    trialEndsAt: null,
    currentPeriodEnd: null,
    cancelAtPeriodEnd: false,
    isAdmin: false,
    address: null,
    lat: null,
    lng: null,
    logoDataUrl: null,
    promoUnlocked,
    suspended: false,
    suspendedReason: null,
    suspendedAt: null,
    digestEnabled: true,
    digestEmail: null, // null = falls back to the account's own email
    digestSkipEmpty: false, // false = still send a "quiet day" email when there's nothing new
    onboarding: { qrViewed: false, teamBoardViewed: false, wallViewed: false },
    teamMembers: [], // {id, name, email, passwordHash, passwordSalt, role: 'manager'|'team_member', createdAt}
    createdAt: new Date().toISOString(),
    notes: [],
  };
  db.data.businesses.push(business);

  const token = createToken();
  db.data.sessions[token] = { businessId: business.id, teamMemberId: null };
  await db.write();

  res.status(201).json({
    token,
    business: { id: business.id, businessName: business.businessName, plan: business.plan },
    needsCheckout: !promoUnlocked && requestedPlan === 'growth',
  });
});

// Google Sign-In. The frontend sends the ID token it gets from Google's
// Identity Services library; we verify it directly against Google's own
// tokeninfo endpoint (no extra dependency needed for this). If an account
// with that email already exists, log into it — reusing the same
// findAnyAccountByEmail lookup used everywhere else, so this correctly
// finds an owner OR an already-invited team member, not just owners.
// Otherwise create a new business — Google doesn't give us a business
// name, so we use a sensible default the person can rename later. New
// accounts get the exact same shape as a normal signup (team members,
// onboarding checklist, promo flag, etc.) so nothing downstream breaks
// from a missing field.
const GOOGLE_CLIENT_ID = '84971942559-b3287j5jg35h6h3sveccle2n6d28admc.apps.googleusercontent.com';

app.post('/api/auth/google', async (req, res) => {
  const { credential, plan, promoCode } = req.body;
  if (!credential) {
    return res.status(400).json({ error: 'credential is required' });
  }

  let payload;
  try {
    const verifyRes = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${credential}`);
    if (!verifyRes.ok) throw new Error('bad token');
    payload = await verifyRes.json();
  } catch (err) {
    return res.status(401).json({ error: 'Could not verify Google sign-in' });
  }

  if (payload.aud !== GOOGLE_CLIENT_ID) {
    return res.status(401).json({ error: 'Token was not issued for this app' });
  }
  if (payload.email_verified !== 'true' || !payload.email) {
    return res.status(401).json({ error: 'Google account email is not verified' });
  }

  await db.read();
  const normalizedEmail = payload.email.trim().toLowerCase();
  const existing = findAnyAccountByEmail(normalizedEmail);

  let business;
  let teamMemberId = null;
  let needsCheckout = false;

  if (existing) {
    business = existing.business;
    if (business.suspended) {
      return res.status(403).json({ error: business.suspendedReason ? `Account suspended: ${business.suspendedReason}` : 'This account has been suspended.' });
    }
    if (existing.kind === 'member') {
      teamMemberId = existing.member.id;
      // Google sign-in only applies to owner accounts here — an invited
      // team member still needs to accept their invite and set a
      // password first, same as the regular login flow requires.
      if (!existing.member.passwordHash) {
        return res.status(401).json({ error: 'Please check your email and accept your invite first.' });
      }
    }
  } else {
    // plan/promoCode only ever apply to a brand-new account — an
    // existing account's plan is never changed just because someone
    // happened to have a plan chip selected when they clicked the
    // Google button on the signup page.
    const requestedPlan = VALID_PLANS.includes(plan) ? plan : 'starter';
    const promoUnlocked = isValidPromoCode(promoCode);
    business = {
      id: newId(),
      businessName: payload.name ? `${payload.name}'s Business` : 'My Business',
      ownerName: payload.name || null,
      email: normalizedEmail,
      passwordHash: null,
      passwordSalt: null,
      isGoogleAccount: true, // Google accounts don't use a password
      // Same rule as the regular signup form: Growth is never free just
      // because it was selected, only a valid promo code skips payment.
      plan: promoUnlocked ? requestedPlan : 'starter',
      stripeCustomerId: null,
      stripeSubscriptionId: null,
      planStatus: 'active',
      trialEndsAt: null,
      currentPeriodEnd: null,
      cancelAtPeriodEnd: false,
      isAdmin: false,
      address: null,
      lat: null,
      lng: null,
      logoDataUrl: null,
      promoUnlocked,
      suspended: false,
      suspendedReason: null,
      suspendedAt: null,
      digestEnabled: true,
      digestEmail: null,
      digestSkipEmpty: false,
      onboarding: { qrViewed: false, teamBoardViewed: false, wallViewed: false },
      teamMembers: [],
      createdAt: new Date().toISOString(),
      notes: [],
    };
    db.data.businesses.push(business);
    needsCheckout = !promoUnlocked && requestedPlan === 'growth';
  }

  const token = createToken();
  db.data.sessions[token] = { businessId: business.id, teamMemberId };
  await db.write();

  res.json({
    token,
    business: { id: business.id, businessName: business.businessName, plan: business.plan },
    needsCheckout,
  });
});

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email?.trim() || !password) {
    return res.status(400).json({ error: 'email and password are required' });
  }

  await db.read();
  const normalizedEmail = email.trim().toLowerCase();

  // Try the business owner first...
  const business = db.data.businesses.find((b) => b.email === normalizedEmail);
  if (business && verifyPassword(password, business.passwordHash, business.passwordSalt)) {
    if (business.suspended) {
      return res.status(403).json({ error: business.suspendedReason ? `Account suspended: ${business.suspendedReason}` : 'This account has been suspended.' });
    }
    const token = createToken();
    db.data.sessions[token] = { businessId: business.id, teamMemberId: null };
    await db.write();
    return res.json({
      token,
      business: { id: business.id, businessName: business.businessName, plan: business.plan },
    });
  }

  // ...then check every business's team members for a matching email.
  // Team member emails are enforced unique across the whole platform when
  // they're created, same as owner emails, so this is a safe linear scan.
  // Members who haven't accepted their invite yet have no passwordHash at
  // all — skip straight to the generic error for them rather than calling
  // verifyPassword, which would throw on a null hash.
  for (const biz of db.data.businesses) {
    const teamMember = (biz.teamMembers || []).find((m) => m.email === normalizedEmail);
    if (teamMember && teamMember.passwordHash && verifyPassword(password, teamMember.passwordHash, teamMember.passwordSalt)) {
      if (biz.suspended) {
        return res.status(403).json({ error: biz.suspendedReason ? `Account suspended: ${biz.suspendedReason}` : 'This account has been suspended.' });
      }
      const token = createToken();
      db.data.sessions[token] = { businessId: biz.id, teamMemberId: teamMember.id };
      await db.write();
      return res.json({
        token,
        business: { id: biz.id, businessName: biz.businessName, plan: biz.plan },
      });
    }
  }

  return res.status(401).json({ error: 'Incorrect email or password' });
});

app.post('/api/auth/logout', requireSession, async (req, res) => {
  const auth = req.headers.authorization || '';
  const token = auth.slice(7);
  await db.read();
  delete db.data.sessions[token];
  await db.write();
  res.json({ ok: true });
});

// Computes the getting-started checklist for a business, mixing derived
// signals (things we can tell from their real data) with a few explicit
// flags for actions we can't detect any other way (e.g. whether they've
// actually looked at their QR code — there's no server-side signal for
// that beyond "did they open the panel that shows it").
function computeOnboardingChecklist(business) {
  const notes = business.notes || [];
  const onboarding = business.onboarding || {};
  const teamEnabled = planIncludesEmployeeNotes(business.plan);

  const steps = [
    {
      id: 'address',
      title: 'Add your business address',
      desc: 'Lets customers find you in "search near me."',
      optional: false,
      done: !!business.address,
    },
    {
      id: 'logo',
      title: 'Upload your logo',
      desc: 'Shows on your board, your QR card, and your emails.',
      optional: false,
      done: !!business.logoDataUrl,
    },
    {
      id: 'qr',
      title: 'Get your QR code',
      desc: 'Print it on a table, till, or wall — this is how most notes come in.',
      optional: false,
      done: !!onboarding.qrViewed,
    },
    {
      id: 'firstResponse',
      title: 'Respond to your first note',
      desc: 'Even a quick "thanks, looking into it" moves a note forward.',
      optional: false,
      done: notes.some((n) => (n.statusHistory || []).length > 1),
    },
  ];

  if (teamEnabled) {
    steps.splice(3, 0, {
      id: 'teamBoard',
      title: 'Share your team board',
      desc: 'Gives staff a private, anonymous way to flag things too.',
      optional: true,
      done: !!onboarding.teamBoardViewed,
    });
  }

  steps.push({
    id: 'wall',
    title: 'Share your response wall',
    desc: 'Shows what you\'ve changed because of customer notes — good for trust.',
    optional: true,
    done: !!onboarding.wallViewed,
  });

  return steps;
}

app.get('/api/me', requireSession, (req, res) => {
  res.json({
    id: req.business.id,
    businessName: req.business.businessName,
    ownerName: req.business.ownerName,
    email: req.business.email,
    plan: req.business.plan,
    planStatus: req.business.planStatus || 'active',
    trialEndsAt: req.business.trialEndsAt || null,
    currentPeriodEnd: req.business.currentPeriodEnd || null,
    cancelAtPeriodEnd: !!req.business.cancelAtPeriodEnd,
    hasStripeCustomer: !!req.business.stripeCustomerId,
    stripeConfigured: !!stripe,
    isAdmin: isOriginalOwner(req) && !!req.business.isAdmin,
    role: req.actingUser.role, // 'admin' | 'manager' | 'team_member'
    userName: req.actingUser.name,
    employeeNotesEnabled: planIncludesEmployeeNotes(req.business.plan),
    address: req.business.address || null,
    lat: req.business.lat ?? null,
    lng: req.business.lng ?? null,
    logoDataUrl: req.business.logoDataUrl || null,
    digestEnabled: req.business.digestEnabled !== false, // undefined (older accounts) defaults to true
    digestEmail: req.business.digestEmail || null,
    digestSkipEmpty: !!req.business.digestSkipEmpty,
    promoUnlocked: !!req.business.promoUnlocked,
    onboardingChecklist: req.actingUser.role === 'admin' ? computeOnboardingChecklist(req.business) : [],
    createdAt: req.business.createdAt,
  });
});

const MAX_LOGO_DATA_URL_LENGTH = 1_500_000; // ~1.1MB image, base64-inflated

// Updates the caller's own business profile — name, owner name, email,
// address (re-geocoded if it changed), and logo. Password is handled
// by a separate endpoint below since it needs current-password verification.
app.post('/api/business/profile', requireSession, requireBusinessOwner, async (req, res) => {
  const { businessName, ownerName, email, address, logoDataUrl, removeLogo } = req.body;

  if (businessName !== undefined && !businessName.trim()) {
    return res.status(400).json({ error: 'businessName cannot be empty' });
  }
  if (logoDataUrl && logoDataUrl.length > MAX_LOGO_DATA_URL_LENGTH) {
    return res.status(413).json({ error: 'Logo image is too large — please use a smaller image' });
  }
  if (logoDataUrl && !/^data:image\/(png|jpe?g|webp|gif);base64,/.test(logoDataUrl)) {
    return res.status(400).json({ error: 'Logo must be a PNG, JPEG, WEBP, or GIF image' });
  }

  await db.read();
  const business = db.data.businesses.find((b) => b.id === req.business.id);

  if (email !== undefined && email.trim()) {
    const normalizedEmail = email.trim().toLowerCase();
    const existing = findAnyAccountByEmail(normalizedEmail);
    if (existing && !(existing.kind === 'owner' && existing.business.id === business.id)) {
      return res.status(409).json({ error: 'Another account already uses that email' });
    }
    business.email = normalizedEmail;
  }

  if (businessName !== undefined && businessName.trim()) business.businessName = businessName.trim();
  if (ownerName !== undefined) business.ownerName = ownerName.trim() || null;

  if (address !== undefined) {
    const trimmedAddress = address.trim() || null;
    const addressChanged = trimmedAddress !== business.address;
    const needsRetry = trimmedAddress && business.lat == null;
    if (addressChanged || needsRetry) {
      business.address = trimmedAddress;
      if (trimmedAddress) {
        const coords = await geocodeAddress(trimmedAddress);
        business.lat = coords?.lat ?? null;
        business.lng = coords?.lng ?? null;
      } else {
        business.lat = null;
        business.lng = null;
      }
    }
  }

  if (removeLogo) {
    business.logoDataUrl = null;
  } else if (logoDataUrl) {
    business.logoDataUrl = logoDataUrl;
  }

  await db.write();

  res.json({
    ok: true,
    businessName: business.businessName,
    ownerName: business.ownerName,
    email: business.email,
    address: business.address,
    lat: business.lat,
    lng: business.lng,
    logoDataUrl: business.logoDataUrl,
  });
});

// Email notification preferences — separate from the main profile endpoint
// since these are a distinct concern (digest sending), not business details.
app.post('/api/business/email-preferences', requireSession, requireBusinessOwner, async (req, res) => {
  const { digestEnabled, digestEmail, digestSkipEmpty } = req.body;

  if (digestEmail) {
    const trimmed = digestEmail.trim();
    const validEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed);
    if (!validEmail) {
      return res.status(400).json({ error: 'That doesn\'t look like a valid email address' });
    }
  }

  await db.read();
  const business = db.data.businesses.find((b) => b.id === req.business.id);

  if (digestEnabled !== undefined) business.digestEnabled = !!digestEnabled;
  if (digestEmail !== undefined) business.digestEmail = digestEmail.trim() || null;
  if (digestSkipEmpty !== undefined) business.digestSkipEmpty = !!digestSkipEmpty;

  await db.write();

  res.json({
    ok: true,
    digestEnabled: business.digestEnabled,
    digestEmail: business.digestEmail,
    digestSkipEmpty: business.digestSkipEmpty,
  });
});

app.post('/api/business/redeem-promo', requireSession, requireBusinessOwner, async (req, res) => {
  const { code } = req.body;
  if (!isValidPromoCode(code)) {
    return res.status(400).json({ error: "That code isn't valid." });
  }

  await db.read();
  const business = db.data.businesses.find((b) => b.id === req.business.id);
  business.promoUnlocked = true;
  await db.write();

  res.json({ ok: true, promoUnlocked: true });
});

const ONBOARDING_FLAGS = ['qrViewed', 'teamBoardViewed', 'wallViewed'];

// Marks one of the "did they actually look at this" onboarding steps as
// done — there's no data-driven way to detect these, so the frontend
// calls this at the moment the relevant thing is shown (e.g. opening the
// QR code panel, opening the team board section).
app.post('/api/business/onboarding', requireSession, requireBusinessOwner, async (req, res) => {
  const { step } = req.body;
  if (!ONBOARDING_FLAGS.includes(step)) {
    return res.status(400).json({ error: `step must be one of: ${ONBOARDING_FLAGS.join(', ')}` });
  }

  await db.read();
  const business = db.data.businesses.find((b) => b.id === req.business.id);
  business.onboarding = business.onboarding || {};
  business.onboarding[step] = true;
  await db.write();

  res.json({ ok: true, onboardingChecklist: computeOnboardingChecklist(business) });
});

const TEAM_ROLES = ['admin', 'manager', 'team_member'];
const INVITE_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const APP_BASE_URL = 'https://app.suggestionsbox.com.au';

function findAnyAccountByEmail(email) {
  for (const biz of db.data.businesses) {
    if (biz.email === email) return { kind: 'owner', business: biz };
    const member = (biz.teamMembers || []).find((m) => m.email === email);
    if (member) return { kind: 'member', business: biz, member };
  }
  return null;
}

function inviteEmailHtml(businessName, role, inviteUrl) {
  const roleLabel = { admin: 'an admin', manager: 'a manager', team_member: 'a team member' }[role] || 'a team member';
  return `
<!DOCTYPE html>
<html><body style="margin:0; padding:0; background:#FBF1E2; font-family:-apple-system,Segoe UI,Roboto,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#FBF1E2; padding:30px 0;">
    <tr><td align="center">
      <table width="100%" style="max-width:480px; background:#FFFCF6; border-radius:16px; overflow:hidden;" cellpadding="0" cellspacing="0">
        <tr><td style="background:#E2653A; padding:24px 28px;">
          <div style="font-family:sans-serif; font-weight:700; font-size:18px; color:#FBF1E2;">SuggestionsBox</div>
        </td></tr>
        <tr><td style="padding:28px;">
          <div style="font-family:sans-serif; font-size:15px; color:#2E2B28; line-height:1.6; margin-bottom:20px;">
            You've been invited to join <b>${businessName}</b> on Suggestions Box as ${roleLabel}.
          </div>
          <a href="${inviteUrl}" style="display:inline-block; background:#E2653A; color:#FFFCF6; font-family:sans-serif; font-weight:600; font-size:14px; text-decoration:none; padding:12px 22px; border-radius:10px;">Set your password →</a>
          <div style="font-family:monospace; font-size:11px; color:#6E6A63; margin-top:20px;">This link expires in 7 days.</div>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}

// Adds a team member — owner-only. Rather than the owner setting a
// password directly, this sends an email invite with a link to set their
// own password (POST /api/team-invites/:token/accept below). Email
// uniqueness is checked across the WHOLE platform, not just this
// business, since login has to resolve an email to exactly one account.
app.post('/api/team-members', requireSession, requireBusinessOwner, async (req, res) => {
  const { name, email, role } = req.body;

  if (!email?.trim()) {
    return res.status(400).json({ error: 'email is required' });
  }
  if (!TEAM_ROLES.includes(role)) {
    return res.status(400).json({ error: `role must be one of: ${TEAM_ROLES.join(', ')}` });
  }

  await db.read();
  const normalizedEmail = email.trim().toLowerCase();
  if (findAnyAccountByEmail(normalizedEmail)) {
    return res.status(409).json({ error: 'An account with that email already exists' });
  }

  const business = db.data.businesses.find((b) => b.id === req.business.id);
  const inviteToken = createToken();
  const member = {
    id: newId(),
    name: (name || '').trim() || null,
    email: normalizedEmail,
    passwordHash: null,
    passwordSalt: null,
    role,
    inviteToken,
    inviteTokenExpiresAt: new Date(Date.now() + INVITE_EXPIRY_MS).toISOString(),
    createdAt: new Date().toISOString(),
  };
  business.teamMembers = business.teamMembers || [];
  business.teamMembers.push(member);
  await db.write();

  const inviteUrl = `${APP_BASE_URL}/accept-invite.html?token=${inviteToken}`;
  const emailResult = await sendEmail(normalizedEmail, `You're invited to join ${business.businessName} on Suggestions Box`, inviteEmailHtml(business.businessName, role, inviteUrl));

  res.status(201).json({
    id: member.id, name: member.name, email: member.email, role: member.role, status: 'pending', createdAt: member.createdAt,
    emailSent: emailResult.ok,
  });
});

app.get('/api/team-members', requireSession, requireBusinessOwner, (req, res) => {
  const members = (req.business.teamMembers || []).map((m) => ({
    id: m.id, name: m.name, email: m.email, role: m.role, createdAt: m.createdAt,
    status: m.passwordHash ? 'active' : 'pending',
  }));
  res.json(members);
});

app.delete('/api/team-members/:id', requireSession, requireBusinessOwner, async (req, res) => {
  await db.read();
  const business = db.data.businesses.find((b) => b.id === req.business.id);
  const index = (business.teamMembers || []).findIndex((m) => m.id === req.params.id);
  if (index === -1) return res.status(404).json({ error: 'not found' });

  business.teamMembers.splice(index, 1);

  // Log out any active session for the member being removed, so access
  // ends immediately rather than whenever their token would've expired.
  for (const [token, session] of Object.entries(db.data.sessions)) {
    if (session.teamMemberId === req.params.id) delete db.data.sessions[token];
  }

  await db.write();
  res.json({ ok: true });
});

// Re-sends the invite email with a fresh token — only makes sense for a
// member who hasn't accepted yet (no password set).
app.post('/api/team-members/:id/resend-invite', requireSession, requireBusinessOwner, async (req, res) => {
  await db.read();
  const business = db.data.businesses.find((b) => b.id === req.business.id);
  const member = (business.teamMembers || []).find((m) => m.id === req.params.id);
  if (!member) return res.status(404).json({ error: 'not found' });
  if (member.passwordHash) return res.status(400).json({ error: 'This person has already accepted their invite.' });

  member.inviteToken = createToken();
  member.inviteTokenExpiresAt = new Date(Date.now() + INVITE_EXPIRY_MS).toISOString();
  await db.write();

  const inviteUrl = `${APP_BASE_URL}/accept-invite.html?token=${member.inviteToken}`;
  const emailResult = await sendEmail(member.email, `You're invited to join ${business.businessName} on Suggestions Box`, inviteEmailHtml(business.businessName, member.role, inviteUrl));

  res.json({ ok: true, emailSent: emailResult.ok });
});

// Public — looks up an invite by token so accept-invite.html can show
// who invited them and to what role before asking for a password.
app.get('/api/team-invites/:token', async (req, res) => {
  await db.read();
  for (const biz of db.data.businesses) {
    const member = (biz.teamMembers || []).find((m) => m.inviteToken === req.params.token);
    if (!member) continue;
    if (member.passwordHash) return res.status(410).json({ error: 'This invite has already been used.' });
    if (new Date(member.inviteTokenExpiresAt) < new Date()) return res.status(410).json({ error: 'This invite link has expired — ask them to resend it.' });
    return res.json({ businessName: biz.businessName, email: member.email, role: member.role });
  }
  return res.status(404).json({ error: 'Invite not found.' });
});

// Public — sets the invited person's password and logs them straight in,
// same response shape as a normal login so the frontend can reuse it.
app.post('/api/team-invites/:token/accept', async (req, res) => {
  const { password } = req.body;
  if (!password || password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }

  await db.read();
  for (const biz of db.data.businesses) {
    const member = (biz.teamMembers || []).find((m) => m.inviteToken === req.params.token);
    if (!member) continue;
    if (member.passwordHash) return res.status(410).json({ error: 'This invite has already been used.' });
    if (new Date(member.inviteTokenExpiresAt) < new Date()) return res.status(410).json({ error: 'This invite link has expired — ask them to resend it.' });

    const { hash, salt } = hashPassword(password);
    member.passwordHash = hash;
    member.passwordSalt = salt;
    member.inviteToken = null;
    member.inviteTokenExpiresAt = null;

    const token = createToken();
    db.data.sessions[token] = { businessId: biz.id, teamMemberId: member.id };
    await db.write();

    return res.json({ token, business: { id: biz.id, businessName: biz.businessName, plan: biz.plan } });
  }
  return res.status(404).json({ error: 'Invite not found.' });
});

// Owner resets a team member's password directly — no current-password
// check needed since this is the owner acting on someone else's account,
// not the member changing their own.
app.post('/api/team-members/:id/password', requireSession, requireBusinessOwner, async (req, res) => {
  const { newPassword } = req.body;
  if (!newPassword || newPassword.length < 8) {
    return res.status(400).json({ error: 'newPassword must be at least 8 characters' });
  }

  await db.read();
  const business = db.data.businesses.find((b) => b.id === req.business.id);
  const member = (business.teamMembers || []).find((m) => m.id === req.params.id);
  if (!member) return res.status(404).json({ error: 'not found' });

  const { hash, salt } = hashPassword(newPassword);
  member.passwordHash = hash;
  member.passwordSalt = salt;
  await db.write();

  res.json({ ok: true });
});

// "Admin" business role now includes both the original owner login and
// any team member promoted to admin — so this has to change the RIGHT
// account's password: the owner's own record for the owner, or that
// specific team member's record for a promoted admin. Using the same
// endpoint for both rather than "always touch business.passwordHash"
// avoids the bug where a promoted admin changing "their own" password
// would silently change the actual owner's login instead.
app.post('/api/business/password', requireSession, requireBusinessOwner, async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword) {
    return res.status(400).json({ error: 'currentPassword and newPassword are required' });
  }
  if (newPassword.length < 8) {
    return res.status(400).json({ error: 'New password must be at least 8 characters' });
  }

  await db.read();
  const business = db.data.businesses.find((b) => b.id === req.business.id);
  const { hash, salt } = hashPassword(newPassword);

  if (isOriginalOwner(req)) {
    if (!verifyPassword(currentPassword, business.passwordHash, business.passwordSalt)) {
      return res.status(401).json({ error: 'Current password is incorrect' });
    }
    business.passwordHash = hash;
    business.passwordSalt = salt;
  } else {
    const member = (business.teamMembers || []).find((m) => m.id === req.actingUser.id);
    if (!member) return res.status(404).json({ error: 'not found' });
    if (!verifyPassword(currentPassword, member.passwordHash, member.passwordSalt)) {
      return res.status(401).json({ error: 'Current password is incorrect' });
    }
    member.passwordHash = hash;
    member.passwordSalt = salt;
  }

  await db.write();
  res.json({ ok: true });
});

// Public — lets customers find a business by name/suburb text match,
// and/or by proximity if they share their location. No auth: this is
// meant to be browsed by anyone looking for a local business's board.
app.get('/api/businesses/search', async (req, res) => {
  await db.read();
  const q = (req.query.q || '').trim().toLowerCase();
  const near = req.query.near; // "lat,lng"

  let results = db.data.businesses;

  if (q) {
    results = results.filter((b) =>
      b.businessName.toLowerCase().includes(q) || (b.address || '').toLowerCase().includes(q)
    );
  }

  let userLat, userLng;
  if (near) {
    const parts = near.split(',').map(Number);
    if (parts.length === 2 && parts.every((n) => !Number.isNaN(n))) {
      [userLat, userLng] = parts;
    }
  }

  let mapped = results.map((b) => {
    const hasCoords = b.lat != null && b.lng != null;
    const distance = userLat != null && hasCoords ? distanceKm(userLat, userLng, b.lat, b.lng) : null;
    return {
      id: b.id,
      businessName: b.businessName,
      address: b.address,
      logoDataUrl: b.logoDataUrl,
      distanceKm: distance,
    };
  });

  if (userLat != null) {
    // Near-me search: only businesses with known coordinates, closest first,
    // capped to a reasonable radius so it doesn't return the whole country.
    mapped = mapped.filter((b) => b.distanceKm != null && b.distanceKm <= 100);
    mapped.sort((a, b) => a.distanceKm - b.distanceKm);
  } else {
    mapped.sort((a, b) => a.businessName.localeCompare(b.businessName));
  }

  res.json(mapped.slice(0, 30));
});

const VALID_PLANS = ['starter', 'growth', 'business'];

// Starts a real Stripe subscription checkout for the Growth plan, with a
// 14-day trial (matches what's advertised on the pricing page). Reuses an
// existing Stripe customer if this business already has one (e.g. they
// cancelled before and are upgrading again).
app.post('/api/billing/create-checkout-session', requireSession, requireBusinessOwner, async (req, res) => {
  if (!stripe) return res.status(503).json({ error: 'Payments are not configured on this server yet.' });

  await db.read();
  const business = db.data.businesses.find((b) => b.id === req.business.id);
  const billingPeriod = req.body?.billingPeriod === 'annual' ? 'annual' : 'monthly';
  const priceId = growthPriceId(billingPeriod);
  if (!priceId) return res.status(503).json({ error: 'Growth plan pricing is not set up yet.' });

  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: business.stripeCustomerId || undefined,
      customer_email: business.stripeCustomerId ? undefined : business.email,
      line_items: [{ price: priceId, quantity: 1 }],
      subscription_data: {
        trial_period_days: 14,
        metadata: { businessId: business.id },
      },
      metadata: { businessId: business.id },
      success_url: `${APP_BASE_URL}/dashboard.html?billing=success`,
      cancel_url: `${APP_BASE_URL}/dashboard.html?billing=cancelled`,
    });
    res.json({ url: session.url });
  } catch (err) {
    console.error('[stripe] Failed to create checkout session:', err.message);
    res.status(500).json({ error: "Couldn't start checkout. Please try again." });
  }
});

// Opens Stripe's hosted Billing Portal — lets the business update their
// card, view invoices, or cancel, without us building any of that
// ourselves. Only available once they actually have a Stripe customer
// (i.e. they've been through checkout at least once).
app.post('/api/billing/create-portal-session', requireSession, requireBusinessOwner, async (req, res) => {
  if (!stripe) return res.status(503).json({ error: 'Payments are not configured on this server yet.' });

  await db.read();
  const business = db.data.businesses.find((b) => b.id === req.business.id);
  if (!business.stripeCustomerId) {
    return res.status(400).json({ error: "You don't have a billing account yet — upgrade to Growth first." });
  }

  try {
    const session = await stripe.billingPortal.sessions.create({
      customer: business.stripeCustomerId,
      return_url: `${APP_BASE_URL}/dashboard.html`,
    });
    res.json({ url: session.url });
  } catch (err) {
    console.error('[stripe] Failed to create billing portal session:', err.message);
    res.status(500).json({ error: "Couldn't open the billing portal. Please try again." });
  }
});

// Free, no-payment plan switch — kept ONLY for promo-unlocked test/pilot
// accounts (what the promo code has always been for) or when Stripe isn't
// configured at all (local dev without keys). Everyone else must go
// through the real Checkout/Billing Portal flow above, so the plan
// recorded here can never drift from what Stripe is actually billing.
app.post('/api/billing/change-plan', requireSession, requireBusinessOwner, async (req, res) => {
  const { plan } = req.body;
  if (!VALID_PLANS.includes(plan)) {
    return res.status(400).json({ error: `plan must be one of: ${VALID_PLANS.join(', ')}` });
  }

  await db.read();
  const business = db.data.businesses.find((b) => b.id === req.business.id);

  if (stripe && !business.promoUnlocked) {
    return res.status(403).json({
      error: plan === 'starter'
        ? 'To move to Starter, cancel your subscription from the billing portal instead.'
        : 'Upgrading requires payment — use the Upgrade button to check out with Stripe.',
    });
  }

  business.plan = plan;
  await db.write();

  res.json({ ok: true, plan: business.plan });
});

// Notes for a freshly signed-up business (starts empty — this is a brand
// new account, not the Fix It Right Plumbing pilot data above).
app.get('/api/my-notes', requireSession, (req, res) => {
  const notes = req.business.notes
    .filter((n) => canAccessLane(req.actingUser.role, n.lane))
    .map((n) => ({ ...n, voteCount: n.votes.length }))
    .sort((a, b) => {
      if (!!b.isSafetyIssue !== !!a.isSafetyIssue) return b.isSafetyIssue ? 1 : -1;
      return new Date(b.createdAt) - new Date(a.createdAt);
    });
  res.json(notes);
});

// Owner updates a status on their own business's note — real-auth version
// of the passcode-based /api/owner/notes/:id/status above.
app.post('/api/my-notes/:id/status', requireSession, async (req, res) => {
  const { status, message } = req.body;
  if (!STATUS_ORDER.includes(status)) {
    return res.status(400).json({ error: `status must be one of: ${STATUS_ORDER.join(', ')}` });
  }

  await db.read();
  const business = db.data.businesses.find((b) => b.id === req.business.id);
  const note = business.notes.find((n) => n.id === req.params.id);
  if (!note) return res.status(404).json({ error: 'not found' });
  if (!canAccessLane(req.actingUser.role, note.lane)) {
    return res.status(403).json({ error: "You don't have access to this note" });
  }

  note.status = status;
  note.statusHistory.push({ status, message: message || null, at: new Date().toISOString() });
  await db.write();

  res.json({ ok: true });
});

// Lets the business explicitly opt a note in or out of the public response
// wall — independent of status or whether it has a written response, so an
// owner can action something without necessarily publicizing it.
app.post('/api/my-notes/:id/wall-visibility', requireSession, async (req, res) => {
  const { showOnWall } = req.body;
  if (typeof showOnWall !== 'boolean') {
    return res.status(400).json({ error: 'showOnWall must be true or false' });
  }

  await db.read();
  const business = db.data.businesses.find((b) => b.id === req.business.id);
  const note = business.notes.find((n) => n.id === req.params.id);
  if (!note) return res.status(404).json({ error: 'not found' });
  if (!canAccessLane(req.actingUser.role, note.lane)) {
    return res.status(403).json({ error: "You don't have access to this note" });
  }

  note.showOnWall = showOnWall;
  await db.write();

  res.json({ ok: true, showOnWall: note.showOnWall });
});

// Deletes a note — the business can only ever delete its own notes,
// enforced by scoping the lookup to req.business.id, same as every
// other /api/my-notes endpoint.
app.delete('/api/my-notes/:id', requireSession, async (req, res) => {
  await db.read();
  const business = db.data.businesses.find((b) => b.id === req.business.id);
  const note = business.notes.find((n) => n.id === req.params.id);
  if (!note) return res.status(404).json({ error: 'not found' });
  if (!canAccessLane(req.actingUser.role, note.lane)) {
    return res.status(403).json({ error: "You don't have access to this note" });
  }

  const noteIndex = business.notes.findIndex((n) => n.id === req.params.id);
  business.notes.splice(noteIndex, 1);
  await db.write();

  res.json({ ok: true });
});

// ============================================================
// Public board — this is what links the two systems together.
// Anyone with a business's ID (from their signup) can browse,
// vote, and write notes here, no account required — same as the
// Fix It Right Plumbing pilot, just scoped per signed-up business.
// ============================================================

// Employee (staff) notes are a Growth/Business plan feature, not
// available on Starter. This is the single source of truth for
// that check — used both when accepting a note and when telling
// board.html whether to honor a ?staff=1 link at all.
function planIncludesEmployeeNotes(plan) {
  return plan === 'growth' || plan === 'business';
}

app.get('/api/board/:businessId', async (req, res) => {
  await db.read();
  const business = db.data.businesses.find((b) => b.id === req.params.businessId);
  if (!business) return res.status(404).json({ error: 'business not found' });
  res.json({
    id: business.id,
    name: business.businessName,
    logoDataUrl: business.logoDataUrl || null,
    employeeNotesEnabled: planIncludesEmployeeNotes(business.plan),
  });
});

app.get('/api/board/:businessId/notes', async (req, res) => {
  await db.read();
  const business = db.data.businesses.find((b) => b.id === req.params.businessId);
  if (!business) return res.status(404).json({ error: 'business not found' });

  const deviceId = req.query.deviceId || null;
  // lane filter keeps the public customer board and the private staff
  // board from ever showing each other's notes on the same list.
  const laneFilter = req.query.lane === 'employee' ? 'employee' : 'customer';

  const notes = business.notes
    .filter((n) => (n.lane || 'customer') === laneFilter)
    .map((n) => {
      const latestEntry = [...n.statusHistory].reverse().find((h) => h.message);
      return {
        id: n.id,
        text: n.text,
        category: n.category,
        lane: n.lane || 'customer',
        displayName: n.isAnonymous ? (n.lane === 'employee' ? 'Anonymous' : 'Anonymous customer') : n.authorName || 'Customer',
        voteCount: n.votes.length,
        hasVoted: deviceId ? n.votes.includes(deviceId) : false,
        status: n.status,
        response: latestEntry?.message || null,
        respondedAt: latestEntry?.at || null,
        createdAt: n.createdAt,
      };
    })
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  res.json(notes);
});

// Public — the "response wall": actioned customer notes paired with the
// message the business wrote when marking them actioned, plus real
// aggregate stats. This is a trust/showcase page, separate from the
// interactive voting board — no auth, no deviceId needed.
app.get('/api/board/:businessId/wall', async (req, res) => {
  await db.read();
  const business = db.data.businesses.find((b) => b.id === req.params.businessId);
  if (!business) return res.status(404).json({ error: 'business not found' });

  const customerNotes = business.notes.filter((n) => (n.lane || 'customer') === 'customer');
  const publishedNotes = customerNotes.filter((n) => n.showOnWall === true);

  const wallItems = publishedNotes
    .map((n) => {
      const latestEntry = [...n.statusHistory].reverse().find((h) => h.message);
      return {
        id: n.id,
        text: n.text,
        category: n.category,
        displayName: n.isAnonymous ? 'Anonymous customer' : n.authorName || 'Customer',
        voteCount: n.votes.length,
        status: n.status,
        response: latestEntry?.message || null,
        respondedAt: latestEntry?.at || null,
        createdAt: n.createdAt,
      };
    })
    .sort((a, b) => b.voteCount - a.voteCount);

  // Average time from a note being sent to its first status change away
  // from "sent" — i.e. how long before the business first acknowledged it.
  const responseTimes = customerNotes
    .filter((n) => n.statusHistory.length > 1)
    .map((n) => new Date(n.statusHistory[1].at) - new Date(n.statusHistory[0].at));
  const avgResponseDays = responseTimes.length
    ? Math.round((responseTimes.reduce((a, b) => a + b, 0) / responseTimes.length / 86400000) * 10) / 10
    : null;

  res.json({
    businessName: business.businessName,
    logoDataUrl: business.logoDataUrl || null,
    totalNotes: customerNotes.length,
    actionedCount: customerNotes.filter((n) => n.status === 'actioned').length,
    avgResponseDays,
    items: wallItems,
  });
});

app.get('/api/board/:businessId/notes/:noteId', async (req, res) => {
  await db.read();
  const business = db.data.businesses.find((b) => b.id === req.params.businessId);
  if (!business) return res.status(404).json({ error: 'business not found' });

  const deviceId = req.query.deviceId || null;
  const note = business.notes.find((n) => n.id === req.params.noteId);
  if (!note) return res.status(404).json({ error: 'not found' });

  const latestEntry = [...note.statusHistory].reverse().find((h) => h.message);

  res.json({
    id: note.id,
    text: note.text,
    category: note.category,
    lane: note.lane || 'customer',
    displayName: note.isAnonymous ? (note.lane === 'employee' ? 'Anonymous' : 'Anonymous customer') : note.authorName || 'Customer',
    voteCount: note.votes.length,
    hasVoted: deviceId ? note.votes.includes(deviceId) : false,
    status: note.status,
    response: latestEntry?.message || null,
    respondedAt: latestEntry?.at || null,
    statusHistory: note.statusHistory,
    createdAt: note.createdAt,
  });
});

app.post('/api/board/:businessId/notes/email-instead', async (req, res) => {
  const { text, category, isEmployee, authorName } = req.body;

  if (typeof text !== 'string' || !text.trim()) {
    return res.status(400).json({ error: 'text is required' });
  }

  await db.read();
  const business = db.data.businesses.find((b) => b.id === req.params.businessId);
  if (!business) return res.status(404).json({ error: 'business not found' });

  const recipient = business.digestEmail || business.email;
  if (!recipient) return res.status(503).json({ error: "This business doesn't have an email on file yet." });

  // This feedback was flagged as personally targeting an identifiable
  // individual — not abusive enough to reject outright, but not suitable
  // to post to the public/team board either. It's relayed directly and
  // privately to the business instead, and is never stored as a Note.
  const escapeHtml = (str) => String(str ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  const html = `
    <div style="font-family:sans-serif; max-width:520px; margin:0 auto; padding:24px;">
      <p style="font-size:13px; color:#6E6A63;">
        This note named a specific person, so it wasn't posted to your ${isEmployee ? 'team' : 'customer'} board —
        it's been sent to you privately instead.
      </p>
      <div style="background:#FCF6EC; border:1px solid #EDE0CC; border-radius:10px; padding:16px; font-size:14px; color:#2E2B28; line-height:1.5;">
        "${escapeHtml(text.trim())}"
      </div>
      ${authorName ? `<p style="font-size:12.5px; color:#6E6A63; margin-top:10px;">— ${escapeHtml(authorName)}</p>` : ''}
      <p style="font-size:11.5px; color:#6E6A63; margin-top:18px;">Category: ${escapeHtml(category || 'general')}</p>
    </div>`;

  const result = await sendEmail(recipient, 'Private feedback (not posted publicly)', html);
  if (!result.ok) {
    return res.status(502).json({ error: "Couldn't send this to the business right now. Please try again." });
  }

  res.json({ ok: true });
});

app.post('/api/board/:businessId/notes', async (req, res) => {
  const { text, category, isAnonymous, authorName, deviceId, skipModerationCheck, isEmployee, isSafetyIssue } = req.body;

  if (typeof text !== 'string' || !text.trim()) {
    return res.status(400).json({ error: 'text is required' });
  }
  if (!deviceId) {
    return res.status(400).json({ error: 'deviceId is required (used only for vote de-duplication)' });
  }

  if (!skipModerationCheck) {
    const toneResult = await checkTone(text);
    if (!toneResult.ok && toneResult.severity !== 'nudge') {
      return res.status(422).json({ moderation: toneResult });
    }
  }

  await db.read();
  const business = db.data.businesses.find((b) => b.id === req.params.businessId);
  if (!business) return res.status(404).json({ error: 'business not found' });

  // Employee notes require a Growth/Business plan. This is checked
  // server-side, not just hidden in the UI, so a shared staff link
  // can't be used to bypass the plan gate.
  if (isEmployee && !planIncludesEmployeeNotes(business.plan)) {
    return res.status(403).json({ error: "Employee feedback isn't available on this business's plan" });
  }

  // Employee notes are always anonymous — enforced here regardless of what
  // the client sends, since staff need to trust this holds even if the
  // frontend has a bug or someone tampers with the request directly.
  const forcedAnonymous = isEmployee ? true : !!isAnonymous;
  const resolvedAuthorName = isEmployee || isAnonymous ? null : (authorName || '').trim() || null;

  const note = {
    id: newId(),
    text: text.trim(),
    category: category || 'general',
    lane: isEmployee ? 'employee' : 'customer',
    isAnonymous: forcedAnonymous,
    authorName: resolvedAuthorName,
    isSafetyIssue: isEmployee ? !!isSafetyIssue : false,
    votes: [deviceId],
    status: 'sent',
    statusHistory: [{ status: 'sent', message: null, at: new Date().toISOString() }],
    showOnWall: false, // owner opts a note in to the public response wall explicitly
    createdAt: new Date().toISOString(),
  };
  business.notes.push(note);
  await db.write();

  if (note.isSafetyIssue) {
    sendSafetyIssueAlert(business, note).catch((err) => {
      console.error('[safety alert] Failed to send:', err.message);
    });
  }

  res.status(201).json({ id: note.id });
});

app.post('/api/board/:businessId/notes/:noteId/vote', async (req, res) => {
  const { deviceId } = req.body;
  if (!deviceId) return res.status(400).json({ error: 'deviceId is required' });

  await db.read();
  const business = db.data.businesses.find((b) => b.id === req.params.businessId);
  if (!business) return res.status(404).json({ error: 'business not found' });

  const note = business.notes.find((n) => n.id === req.params.noteId);
  if (!note) return res.status(404).json({ error: 'not found' });

  const idx = note.votes.indexOf(deviceId);
  if (idx === -1) {
    note.votes.push(deviceId);
  } else {
    note.votes.splice(idx, 1);
  }
  await db.write();

  res.json({ voteCount: note.votes.length, hasVoted: idx === -1 });
});

// ============================================================
// Platform admin — separate from a business's own dashboard.
// Reuses the same login/session as a business account, gated by
// an isAdmin flag on that account rather than a separate login.
// ============================================================

// One-time setup: run once, logged in as the account that should
// become the platform admin, with the ADMIN_SETUP_KEY env var set
// on the server and passed in the x-admin-setup-key header. There
// is no UI for this on purpose — it's meant to be run once via
// curl/Postman, not exposed as a clickable feature.
app.post('/api/admin/claim', requireSession, async (req, res) => {
  const setupKey = process.env.ADMIN_SETUP_KEY;
  if (!setupKey) {
    return res.status(500).json({ error: 'ADMIN_SETUP_KEY is not configured on the server' });
  }
  if (req.headers['x-admin-setup-key'] !== setupKey) {
    return res.status(401).json({ error: 'invalid setup key' });
  }

  await db.read();
  const business = db.data.businesses.find((b) => b.id === req.business.id);
  business.isAdmin = true;
  await db.write();

  res.json({ ok: true, businessName: business.businessName });
});

function requireAdmin(req, res, next) {
  // Defense in depth: even on the platform-admin business account, only
  // the actual owner (never an invited team member, even one promoted to
  // the "admin" business role) can reach these platform-wide endpoints.
  if (!isOriginalOwner(req) || !req.business.isAdmin) {
    return res.status(403).json({ error: 'admin access required' });
  }
  next();
}

// Manually triggers the daily digest send — admin-only, mainly for testing
// this without waiting until 23:59. Uses the real current Melbourne day by
// default, so it'll send whatever notes have actually come in so far today.
app.post('/api/admin/send-digest-now', requireSession, requireAdmin, async (req, res) => {
  try {
    const results = await sendDailyDigests();
    res.json({ ok: true, results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PLAN_PRICES = { starter: 0, growth: 59 }; // 'business' plan is custom-priced, not included in MRR totals

function businessSummary(b) {
  const notes = b.notes || [];
  const actionedCount = notes.filter((n) => n.status === 'actioned').length;
  const employeeNotes = notes.filter((n) => n.lane === 'employee').length;
  const lastNoteAt = notes.reduce((latest, n) => {
    const at = n.statusHistory?.[n.statusHistory.length - 1]?.at || n.createdAt;
    return !latest || at > latest ? at : latest;
  }, null);

  return {
    id: b.id,
    businessName: b.businessName,
    email: b.email,
    plan: b.plan,
    planStatus: b.planStatus || 'active',
    createdAt: b.createdAt,
    notesReceived: notes.length,
    customerNotes: notes.length - employeeNotes,
    employeeNotes,
    employeeNotesEnabled: planIncludesEmployeeNotes(b.plan),
    actionedRate: notes.length ? Math.round((actionedCount / notes.length) * 100) : 0,
    lastActivity: lastNoteAt || b.createdAt,
    promoUnlocked: !!b.promoUnlocked,
    suspended: !!b.suspended,
    suspendedReason: b.suspendedReason || null,
    suspendedAt: b.suspendedAt || null,
  };
}

// List every business on the platform, with aggregate stats.
app.get('/api/admin/businesses', requireSession, requireAdmin, async (req, res) => {
  await db.read();
  const summaries = db.data.businesses.map(businessSummary).sort((a, b) =>
    (b.lastActivity || '').localeCompare(a.lastActivity || '')
  );
  res.json(summaries);
});

// One business's full detail, including its real notes.
app.get('/api/admin/businesses/:id', requireSession, requireAdmin, async (req, res) => {
  await db.read();
  const business = db.data.businesses.find((b) => b.id === req.params.id);
  if (!business) return res.status(404).json({ error: 'business not found' });

  const notes = business.notes
    .map((n) => ({ ...n, voteCount: n.votes.length }))
    .sort((a, b) => b.voteCount - a.voteCount);

  res.json({ ...businessSummary(business), notes });
});

// Platform admin suspends a business — immediately blocks all API access
// for that business and its team (see requireSession), and blocks future
// logins with a clear reason. Doesn't touch their Stripe subscription or
// data; suspension is reversible.
app.post('/api/admin/businesses/:id/suspend', requireSession, requireAdmin, async (req, res) => {
  const { reason } = req.body;
  await db.read();
  const business = db.data.businesses.find((b) => b.id === req.params.id);
  if (!business) return res.status(404).json({ error: 'business not found' });

  // Never allow suspending the platform-admin account itself, deliberately
  // or via a typo'd ID — that would lock the only super-admin out.
  if (business.isAdmin) {
    return res.status(400).json({ error: "Can't suspend the platform admin account." });
  }

  business.suspended = true;
  business.suspendedReason = (reason || '').trim() || null;
  business.suspendedAt = new Date().toISOString();
  await db.write();

  res.json({ ok: true });
});

app.post('/api/admin/businesses/:id/unsuspend', requireSession, requireAdmin, async (req, res) => {
  await db.read();
  const business = db.data.businesses.find((b) => b.id === req.params.id);
  if (!business) return res.status(404).json({ error: 'business not found' });

  business.suspended = false;
  business.suspendedReason = null;
  business.suspendedAt = null;
  await db.write();

  res.json({ ok: true });
});

// Platform admin revokes a business's promo-unlocked billing bypass.
app.post('/api/admin/businesses/:id/revoke-promo', requireSession, requireAdmin, async (req, res) => {
  await db.read();
  const business = db.data.businesses.find((b) => b.id === req.params.id);
  if (!business) return res.status(404).json({ error: 'business not found' });

  business.promoUnlocked = false;
  await db.write();

  res.json({ ok: true });
});

// Admin updates a note's status on behalf of any business.
app.post('/api/admin/businesses/:id/notes/:noteId/status', requireSession, requireAdmin, async (req, res) => {
  const { status, message } = req.body;
  if (!STATUS_ORDER.includes(status)) {
    return res.status(400).json({ error: `status must be one of: ${STATUS_ORDER.join(', ')}` });
  }

  await db.read();
  const business = db.data.businesses.find((b) => b.id === req.params.id);
  if (!business) return res.status(404).json({ error: 'business not found' });
  const note = business.notes.find((n) => n.id === req.params.noteId);
  if (!note) return res.status(404).json({ error: 'not found' });

  note.status = status;
  note.statusHistory.push({ status, message: message || null, at: new Date().toISOString() });
  await db.write();

  res.json({ ok: true });
});

// Platform-wide billing rollup, computed from real plan data.
// No live Stripe subscriptions are wired up yet, so this is a
// projection based on signed-up plans, not actual invoiced revenue.
app.get('/api/admin/billing', requireSession, requireAdmin, async (req, res) => {
  await db.read();
  const businesses = db.data.businesses;

  const byPlan = { starter: 0, growth: 0, business: 0 };
  const countByPlan = { starter: 0, growth: 0, business: 0 };
  businesses.forEach((b) => {
    countByPlan[b.plan] = (countByPlan[b.plan] || 0) + 1;
    byPlan[b.plan] = (byPlan[b.plan] || 0) + (PLAN_PRICES[b.plan] || 0);
  });

  const mrr = Object.values(byPlan).reduce((sum, v) => sum + v, 0);

  res.json({
    mrr,
    byPlan,
    countByPlan,
    totalBusinesses: businesses.length,
    activeSubscriptions: countByPlan.growth + countByPlan.business,
    onFreePlan: countByPlan.starter,
    businessPlanCount: countByPlan.business,
    note: countByPlan.business > 0
      ? `${countByPlan.business} business(es) on the custom 'Business' plan are not counted in MRR — that pricing isn't stored per-account yet.`
      : null,
  });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Suggestions Box API running on port ${PORT}`));
startDigestScheduler();
