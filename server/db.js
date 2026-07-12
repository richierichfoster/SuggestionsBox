import { Low } from 'lowdb';
import { JSONFile } from 'lowdb/node';
import { nanoid } from 'nanoid';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.RAILWAY_VOLUME_MOUNT_PATH || __dirname;
const file = path.join(dataDir, 'data.json');
const adapter = new JSONFile(file);

const defaultData = {
  business: {
    name: 'Fix It Right Plumbing',
    ownerPasscode: 'FixItRight-9247-Kelp', // change this before going live
  },
  notes: [], // {id, text, category, isAnonymous, authorName, votes: [deviceIds], status, statusHistory: [{status, message, at}], createdAt}

  // Separate from the single pilot business above — this is where real
  // sign-ups from the marketing site's "Get early access" flow live, each
  // with their own isolated notes list.
  businesses: [], // {id, businessName, ownerName, email, passwordHash, passwordSalt, plan, stripeCustomerId, stripeSubscriptionId, planStatus, trialEndsAt, currentPeriodEnd, cancelAtPeriodEnd, suspended, suspendedReason, suspendedAt, createdAt, notes: []}
  sessions: {}, // { [token]: businessId }

  // Cached Stripe Price IDs for the Growth plan (monthly + annual) — created
  // once via the Stripe API on first boot with a key configured, then
  // reused forever after. See stripe-billing.js.
  stripe: {},
};

export const db = new Low(adapter, defaultData);

export async function initDb() {
  await db.read();
  db.data ||= defaultData;
  await db.write();
}

export function newId() {
  return nanoid(10);
}
