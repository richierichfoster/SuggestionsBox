import { useEffect, useState } from 'react';
import { api } from '../api';

export default function NoteDetail({ id, onBack }) {
  const [note, setNote] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    api.getNote(id).then(setNote).catch((e) => setError(e.message));
  }, [id]);

  const handleVote = async () => {
    setNote((prev) => ({
      ...prev,
      hasVoted: !prev.hasVoted,
      voteCount: prev.hasVoted ? prev.voteCount - 1 : prev.voteCount + 1,
    }));
    try {
      await api.vote(id);
    } catch {
      api.getNote(id).then(setNote);
    }
  };

  return (
    <>
      <div className="topbar">
        <div className="icon-btn" onClick={onBack}>
          <svg viewBox="0 0 24 24" fill="none">
            <path d="M15 18l-6-6 6-6" stroke="#2E2B28" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </div>
        <h1>Note</h1>
        <div style={{ width: 34 }} />
      </div>

      <div className="page">
        {error && <div className="empty">Couldn't load this note ({error}).</div>}
        {!error && !note && <div className="empty">Loading…</div>}

        {note && (
          <>
            <div className="note-card" style={{ marginBottom: 18 }}>
              <button className={`vote-btn ${note.hasVoted ? 'voted' : ''}`} onClick={handleVote}>
                <span>{note.voteCount}</span>
                <span className="vlabel">votes</span>
              </button>
              <div className="note-body">
                <div className="ntext">{note.text}</div>
                <div className="note-meta">
                  <span>{note.category}</span>
                  <span>·</span>
                  <span>{note.displayName}</span>
                </div>
              </div>
            </div>

            <h3 style={{ fontSize: 14, marginBottom: 4 }}>Status</h3>
            <div className="timeline">
              {note.statusHistory.map((h, i) => (
                <div className="tstep done" key={i}>
                  <div className="tlabel">{h.status.replace('_', ' ')}</div>
                  <div className="ttime">{new Date(h.at).toLocaleString()}</div>
                  {h.message && <div className="tmsg">{h.message}</div>}
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </>
  );
}
