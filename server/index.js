import express from 'express';
import cors from 'cors';
import { db, initDb, newId } from './db.js';
import { checkTone } from './moderation.js';
import { sendDailyDigests, startDigestScheduler, getMelbourneDayBounds } from './digest.js';
import { hashPassword, verifyPassword, createToken } from './auth.js';

const app = express();
app.use(cors());
app.use(express.json({ limit: '3mb' }));

const STATUS_ORDER = ['sent', 'seen', 'acknowledged', 'in_progress', 'actioned', 'not_planned'];

await initDb();

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

function requireSession(req, res, next) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  const businessId = token && db.data.sessions[token];
  if (!businessId) return res.status(401).json({ error: 'not logged in' });

  const business = db.data.businesses.find((b) => b.id === businessId);
  if (!business) return res.status(401).json({ error: 'not logged in' });

  req.business = business;
  next();
}

app.post('/api/auth/signup', async (req, res) => {
  const { businessName, ownerName, email, password, plan } = req.body;

  if (!businessName?.trim() || !email?.trim() || !password) {
    return res.status(400).json({ error: 'businessName, email, and password are required' });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }

  await db.read();
  const normalizedEmail = email.trim().toLowerCase();
  const existing = db.data.businesses.find((b) => b.email === normalizedEmail);
  if (existing) {
    return res.status(409).json({ error: 'An account with that email already exists' });
  }

  const { hash, salt } = hashPassword(password);
  const business = {
    id: newId(),
    businessName: businessName.trim(),
    ownerName: (ownerName || '').trim() || null,
    email: normalizedEmail,
    passwordHash: hash,
    passwordSalt: salt,
    plan: plan || 'starter',
    isAdmin: false,
    address: null,
    lat: null,
    lng: null,
    logoDataUrl: null,
    digestEnabled: true,
    digestEmail: null, // null = falls back to the account's own email
    digestSkipEmpty: false, // false = still send a "quiet day" email when there's nothing new
    createdAt: new Date().toISOString(),
    notes: [],
  };
  db.data.businesses.push(business);

  const token = createToken();
  db.data.sessions[token] = business.id;
  await db.write();

  res.status(201).json({
    token,
    business: { id: business.id, businessName: business.businessName, plan: business.plan },
  });
});

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email?.trim() || !password) {
    return res.status(400).json({ error: 'email and password are required' });
  }

  await db.read();
  const normalizedEmail = email.trim().toLowerCase();
  const business = db.data.businesses.find((b) => b.email === normalizedEmail);
  if (!business || !verifyPassword(password, business.passwordHash, business.passwordSalt)) {
    return res.status(401).json({ error: 'Incorrect email or password' });
  }

  const token = createToken();
  db.data.sessions[token] = business.id;
  await db.write();

  res.json({
    token,
    business: { id: business.id, businessName: business.businessName, plan: business.plan },
  });
});

app.post('/api/auth/logout', requireSession, async (req, res) => {
  const auth = req.headers.authorization || '';
  const token = auth.slice(7);
  await db.read();
  delete db.data.sessions[token];
  await db.write();
  res.json({ ok: true });
});

app.get('/api/me', requireSession, (req, res) => {
  res.json({
    id: req.business.id,
    businessName: req.business.businessName,
    ownerName: req.business.ownerName,
    email: req.business.email,
    plan: req.business.plan,
    isAdmin: !!req.business.isAdmin,
    employeeNotesEnabled: planIncludesEmployeeNotes(req.business.plan),
    address: req.business.address || null,
    lat: req.business.lat ?? null,
    lng: req.business.lng ?? null,
    logoDataUrl: req.business.logoDataUrl || null,
    digestEnabled: req.business.digestEnabled !== false, // undefined (older accounts) defaults to true
    digestEmail: req.business.digestEmail || null,
    digestSkipEmpty: !!req.business.digestSkipEmpty,
    createdAt: req.business.createdAt,
  });
});

const MAX_LOGO_DATA_URL_LENGTH = 1_500_000; // ~1.1MB image, base64-inflated

// Updates the caller's own business profile — name, owner name, email,
// address (re-geocoded if it changed), and logo. Password is handled
// by a separate endpoint below since it needs current-password verification.
app.post('/api/business/profile', requireSession, async (req, res) => {
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
    const existing = db.data.businesses.find((b) => b.email === normalizedEmail && b.id !== business.id);
    if (existing) {
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
app.post('/api/business/email-preferences', requireSession, async (req, res) => {
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

app.post('/api/business/password', requireSession, async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword) {
    return res.status(400).json({ error: 'currentPassword and newPassword are required' });
  }
  if (newPassword.length < 8) {
    return res.status(400).json({ error: 'New password must be at least 8 characters' });
  }

  await db.read();
  const business = db.data.businesses.find((b) => b.id === req.business.id);
  if (!verifyPassword(currentPassword, business.passwordHash, business.passwordSalt)) {
    return res.status(401).json({ error: 'Current password is incorrect' });
  }

  const { hash, salt } = hashPassword(newPassword);
  business.passwordHash = hash;
  business.passwordSalt = salt;
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

// TEMPORARY DEV BYPASS — no real Stripe integration exists yet, so this
// lets a business change its own plan with no payment collected, purely
// for testing plan-gated features (e.g. team notes). It only ever
// touches the caller's own account, never another business's.
//
// Before any real users could hit this: either remove it, or gate it
// behind a real Stripe webhook confirming payment succeeded first.
app.post('/api/billing/change-plan', requireSession, async (req, res) => {
  const { plan } = req.body;
  if (!VALID_PLANS.includes(plan)) {
    return res.status(400).json({ error: `plan must be one of: ${VALID_PLANS.join(', ')}` });
  }

  await db.read();
  const business = db.data.businesses.find((b) => b.id === req.business.id);
  business.plan = plan;
  await db.write();

  res.json({ ok: true, plan: business.plan });
});

// Notes for a freshly signed-up business (starts empty — this is a brand
// new account, not the Fix It Right Plumbing pilot data above).
app.get('/api/my-notes', requireSession, (req, res) => {
  const notes = req.business.notes
    .map((n) => ({ ...n, voteCount: n.votes.length }))
    .sort((a, b) => b.voteCount - a.voteCount);
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
  const noteIndex = business.notes.findIndex((n) => n.id === req.params.id);
  if (noteIndex === -1) return res.status(404).json({ error: 'not found' });

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
        displayName: n.isAnonymous ? 'Anonymous customer' : n.authorName || 'Customer',
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
        voteCount: n.votes.length,
        status: n.status,
        response: latestEntry?.message || null,
        respondedAt: latestEntry?.at || null,
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

  res.json({
    id: note.id,
    text: note.text,
    category: note.category,
    lane: note.lane || 'customer',
    displayName: note.isAnonymous ? 'Anonymous customer' : note.authorName || 'Customer',
    voteCount: note.votes.length,
    hasVoted: deviceId ? note.votes.includes(deviceId) : false,
    status: note.status,
    statusHistory: note.statusHistory,
    createdAt: note.createdAt,
  });
});

app.post('/api/board/:businessId/notes', async (req, res) => {
  const { text, category, isAnonymous, authorName, deviceId, skipModerationCheck, isEmployee } = req.body;

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

  const note = {
    id: newId(),
    text: text.trim(),
    category: category || 'general',
    lane: isEmployee ? 'employee' : 'customer',
    isAnonymous: !!isAnonymous,
    authorName: isAnonymous ? null : (authorName || '').trim() || null,
    votes: [deviceId],
    status: 'sent',
    statusHistory: [{ status: 'sent', message: null, at: new Date().toISOString() }],
    showOnWall: false, // owner opts a note in to the public response wall explicitly
    createdAt: new Date().toISOString(),
  };
  business.notes.push(note);
  await db.write();

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
  if (!req.business.isAdmin) {
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
    createdAt: b.createdAt,
    notesReceived: notes.length,
    customerNotes: notes.length - employeeNotes,
    employeeNotes,
    employeeNotesEnabled: planIncludesEmployeeNotes(b.plan),
    actionedRate: notes.length ? Math.round((actionedCount / notes.length) * 100) : 0,
    lastActivity: lastNoteAt || b.createdAt,
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
