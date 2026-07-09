import { Low } from 'lowdb';
import { JSONFile } from 'lowdb/node';
import { nanoid } from 'nanoid';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const file = path.join(__dirname, 'data.json');
const adapter = new JSONFile(file);

const defaultData = {
  business: {
    name: 'Fix It Right Plumbing',
    ownerPasscode: 'fixitright2026', // change this before going live
  },
  notes: [], // {id, text, category, isAnonymous, authorName, votes: [deviceIds], status, statusHistory: [{status, message, at}], createdAt}

  // Separate from the single pilot business above — this is where real
  // sign-ups from the marketing site's "Get early access" flow live, each
  // with their own isolated notes list.
  businesses: [], // {id, businessName, ownerName, email, passwordHash, passwordSalt, plan, createdAt, notes: []}
  sessions: {}, // { [token]: businessId }
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
