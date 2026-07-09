import { useEffect, useState } from 'react';
import { api } from '../api';

const STATUSES = ['sent', 'seen', 'acknowledged', 'in_progress', 'actioned', 'not_planned'];

export default function Owner({ onBack }) {
  const [passcode, setPasscode] = useState('');
  const [authed, setAuthed] = useState(false);
  const [loginError, setLoginError] = useState(null);
  const [notes, setNotes] = useState(null);
  const [drafts, setDrafts] = useState({}); // {noteId: {status, message}}
  const [savingId, setSavingId] = useState(null);

  const load = () => api.getNotes().then(setNotes);

  useEffect(() => {
    if (authed) load();
  }, [authed]);

  const login = async () => {
    setLoginError(null);
    try {
      const res = await api.ownerLogin(passcode);
      if (res.ok) setAuthed(true);
    } catch {
      setLoginError('Wrong passcode');
    }
  };

  const setDraft = (noteId, patch) => {
    setDrafts((prev) => ({ ...prev, [noteId]: { ...prev[noteId], ...patch } }));
  };

  const save = async (noteId) => {
    const draft = drafts[noteId];
    if (!draft?.status) return;
    setSavingId(noteId);
    try {
      await api.ownerUpdateStatus(noteId, draft.status, draft.message, passcode);
      await load();
      setDrafts((prev) => ({ ...prev, [noteId]: {} }));
    } finally {
      setSavingId(null);
    }
  };

  if (!authed) {
    return (
      <>
        <div className="topbar">
          <div className="icon-btn" onClick={onBack}>
            <svg viewBox="0 0 24 24" fill="none">
              <path d="M15 18l-6-6 6-6" stroke="#2E2B28" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </div>
          <h1>Business login</h1>
          <div style={{ width: 34 }} />
        </div>
        <div className="page">
          <div className="field">
            <label>Passcode</label>
            <input
              type="password"
              value={passcode}
              onChange={(e) => setPasscode(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && login()}
            />
          </div>
          {loginError && <div style={{ color: 'var(--alert)', fontSize: 12, marginBottom: 12 }}>{loginError}</div>}
          <button className="btn-primary" onClick={login}>
            Log in
          </button>
        </div>
      </>
    );
  }

  return (
    <>
      <div className="topbar">
        <div className="icon-btn" onClick={onBack}>
          <svg viewBox="0 0 24 24" fill="none">
            <path d="M15 18l-6-6 6-6" stroke="#2E2B28" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </div>
        <h1>Notes ({notes?.length ?? 0})</h1>
        <div style={{ width: 34 }} />
      </div>

      <div className="page">
        {notes === null && <div className="empty">Loading…</div>}
        {notes && notes.length === 0 && <div className="empty">No notes yet.</div>}

        {notes &&
          notes.map((note) => {
            const draft = drafts[note.id] || {};
            const currentSelection = draft.status ?? note.status;
            return (
              <div className="owner-note-row" key={note.id}>
                <div className="ntext">{note.text}</div>
                <div className="note-meta" style={{ marginBottom: 10 }}>
                  <span>{note.voteCount} votes</span>
                  <span>·</span>
                  <span>{note.category}</span>
                  <span>·</span>
                  <span>{note.displayName}</span>
                </div>

                <div className="status-select">
                  {STATUSES.map((s) => (
                    <div
                      key={s}
                      className={`status-opt ${currentSelection === s ? 'selected' : ''}`}
                      onClick={() => setDraft(note.id, { status: s })}
                    >
                      {s.replace('_', ' ')}
                    </div>
                  ))}
                </div>

                <input
                  placeholder="Optional message to include with this update"
                  value={draft.message ?? ''}
                  onChange={(e) => setDraft(note.id, { message: e.target.value })}
                  style={{
                    width: '100%', marginBottom: 10, padding: 10, borderRadius: 8,
                    border: '1px solid var(--line)', fontSize: 12.5, background: 'var(--cream)',
                  }}
                />

                <button
                  className="btn-secondary"
                  onClick={() => save(note.id)}
                  disabled={!draft.status}
                >
                  {savingId === note.id ? 'Saving…' : 'Update status'}
                </button>
              </div>
            );
          })}
      </div>
    </>
  );
}
