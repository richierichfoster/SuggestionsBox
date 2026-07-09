import { useEffect, useState } from 'react';
import { api } from '../api';

const STATUS_LABELS = {
  sent: 'Sent',
  seen: 'Seen',
  acknowledged: 'Acknowledged',
  in_progress: 'In progress',
  actioned: 'Actioned',
  not_planned: 'Not planned',
};

export default function Home({ businessName, onCompose, onOpenNote, onOwner }) {
  const [notes, setNotes] = useState(null);
  const [error, setError] = useState(null);

  const load = () => {
    api.getNotes().then(setNotes).catch((e) => setError(e.message));
  };

  useEffect(load, []);

  const handleVote = async (e, note) => {
    e.stopPropagation();
    // optimistic update
    setNotes((prev) =>
      prev.map((n) =>
        n.id === note.id
          ? { ...n, hasVoted: !n.hasVoted, voteCount: n.hasVoted ? n.voteCount - 1 : n.voteCount + 1 }
          : n
      )
    );
    try {
      await api.vote(note.id);
    } catch {
      load(); // revert by reloading real state if the request failed
    }
  };

  return (
    <>
      <div className="topbar">
        <h1>{businessName || 'Loading…'}</h1>
        <div className="icon-btn" onClick={onOwner} title="Business login">
          <svg viewBox="0 0 24 24" fill="none">
            <path d="M4 20l2-6 10-10 4 4-10 10-6 2z" stroke="#2E2B28" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </div>
      </div>

      <div className="page">
        {error && <div className="empty">Couldn't load notes ({error}). Is the API running?</div>}

        {!error && notes === null && <div className="empty">Loading notes…</div>}

        {!error && notes && notes.length === 0 && (
          <div className="empty">
            No notes yet.<br />Be the first to say something — tap the + button below.
          </div>
        )}

        {!error &&
          notes &&
          notes.map((note) => (
            <div className="note-card" key={note.id} onClick={() => onOpenNote(note.id)}>
              <button
                className={`vote-btn ${note.hasVoted ? 'voted' : ''}`}
                onClick={(e) => handleVote(e, note)}
                title={note.hasVoted ? 'Remove your vote' : 'Back this note'}
              >
                <span>{note.voteCount}</span>
                <span className="vlabel">votes</span>
              </button>
              <div className="note-body">
                <div className="ntext">{note.text}</div>
                <div className="note-meta">
                  <span className={`status-pill ${note.status}`}>{STATUS_LABELS[note.status]}</span>
                  <span>·</span>
                  <span>{note.category}</span>
                  <span>·</span>
                  <span>{note.displayName}</span>
                </div>
              </div>
            </div>
          ))}
      </div>

      <button className="fab" onClick={onCompose} title="Write a note">
        +
      </button>
    </>
  );
}
