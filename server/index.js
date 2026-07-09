import express from 'express';
import cors from 'cors';
import { db, initDb, newId } from './db.js';
import { checkTone } from './moderation.js';
import { hashPassword, verifyPassword, createToken } from './auth.js';

const app = express();
app.use(cors());
app.use(express.json());

const STATUS_ORDER = ['sent', 'seen', 'acknowledged', 'in_progress', 'actioned', 'not_planned'];

await initDb();

// --- Public: business info ---
app.get('/api/business', async (req, res) => {
  await db.read();
  res.json({ name: db.data.business.name });
});

// --- Public: check tone before submitting (used live as the person types) ---
app.post('/api/moderate', (req, res) => {
  const { text } = req.body;
  if (typeof text !== 'string' || !text.trim()) {
    return res.status(400).json({ error: 'text is required' });
  }
  res.json(checkTone(text));
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
  if (!skipModerationCheck) {
    const toneResult = checkTone(text);
    if (!toneResult.ok) {
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

// Google Sign-In. The frontend sends the ID token it gets from Google's
// Identity Services library; we verify it directly against Google's own
// tokeninfo endpoint (no extra dependency needed for this). If an account
// with that email already exists, log into it. Otherwise create a new one
// — Google doesn't give us a business name, so we use a sensible default
// the person can rename later.
const GOOGLE_CLIENT_ID = '84971942559-b3287j5jg35h6h3sveccle2n6d28admc.apps.googleusercontent.com';

app.post('/api/auth/google', async (req, res) => {
  const { credential } = req.body;
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
  let business = db.data.businesses.find((b) => b.email === normalizedEmail);

  if (!business) {
    business = {
      id: newId(),
      businessName: payload.name ? `${payload.name}'s Business` : 'My Business',
      ownerName: payload.name || null,
      email: normalizedEmail,
      passwordHash: null, // Google accounts don't use a password
      passwordSalt: null,
      isGoogleAccount: true,
      plan: 'starter',
      createdAt: new Date().toISOString(),
      notes: [],
    };
    db.data.businesses.push(business);
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
    createdAt: req.business.createdAt,
  });
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

// ============================================================
// Public board — this is what links the two systems together.
// Anyone with a business's ID (from their signup) can browse,
// vote, and write notes here, no account required — same as the
// Fix It Right Plumbing pilot, just scoped per signed-up business.
// ============================================================

app.get('/api/board/:businessId', async (req, res) => {
  await db.read();
  const business = db.data.businesses.find((b) => b.id === req.params.businessId);
  if (!business) return res.status(404).json({ error: 'business not found' });
  res.json({ id: business.id, name: business.businessName });
});

app.get('/api/board/:businessId/notes', async (req, res) => {
  await db.read();
  const business = db.data.businesses.find((b) => b.id === req.params.businessId);
  if (!business) return res.status(404).json({ error: 'business not found' });

  const deviceId = req.query.deviceId || null;
  const notes = business.notes
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
    displayName: note.isAnonymous ? 'Anonymous customer' : note.authorName || 'Customer',
    voteCount: note.votes.length,
    hasVoted: deviceId ? note.votes.includes(deviceId) : false,
    status: note.status,
    statusHistory: note.statusHistory,
    createdAt: note.createdAt,
  });
});

app.post('/api/board/:businessId/notes', async (req, res) => {
  const { text, category, isAnonymous, authorName, deviceId, skipModerationCheck } = req.body;

  if (typeof text !== 'string' || !text.trim()) {
    return res.status(400).json({ error: 'text is required' });
  }
  if (!deviceId) {
    return res.status(400).json({ error: 'deviceId is required (used only for vote de-duplication)' });
  }

  if (!skipModerationCheck) {
    const toneResult = checkTone(text);
    if (!toneResult.ok) {
      return res.status(422).json({ moderation: toneResult });
    }
  }

  await db.read();
  const business = db.data.businesses.find((b) => b.id === req.params.businessId);
  if (!business) return res.status(404).json({ error: 'business not found' });

  const note = {
    id: newId(),
    text: text.trim(),
    category: category || 'general',
    isAnonymous: !!isAnonymous,
    authorName: isAnonymous ? null : (authorName || '').trim() || null,
    votes: [deviceId],
    status: 'sent',
    statusHistory: [{ status: 'sent', message: null, at: new Date().toISOString() }],
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

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Suggestions Box API running on port ${PORT}`));
