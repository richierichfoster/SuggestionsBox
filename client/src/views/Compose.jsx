import { useState, useRef } from 'react';
import { api } from '../api';

const CATEGORIES = ['General', 'Service', 'Pricing', 'Scheduling', 'Quality'];

export default function Compose({ onDone, onCancel }) {
  const [category, setCategory] = useState('General');
  const [text, setText] = useState('');
  const [isAnonymous, setIsAnonymous] = useState(false);
  const [authorName, setAuthorName] = useState('');
  const [moderation, setModeration] = useState(null); // {ok, flaggedWords, suggestion, message}
  const [checking, setChecking] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState(null);
  const debounceRef = useRef(null);

  const onTextChange = (val) => {
    setText(val);
    setModeration(null);
    clearTimeout(debounceRef.current);
    if (!val.trim()) return;
    debounceRef.current = setTimeout(async () => {
      setChecking(true);
      try {
        const result = await api.checkTone(val);
        setModeration(result.ok ? null : result);
      } catch {
        // fail silent — don't block writing if the moderation check itself errors
      } finally {
        setChecking(false);
      }
    }, 500);
  };

  const useSuggestion = () => {
    setText(moderation.suggestion);
    setModeration(null);
  };

  const submit = async () => {
    if (!text.trim()) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      await api.submitNote({
        text,
        category: category.toLowerCase(),
        isAnonymous,
        authorName: isAnonymous ? null : authorName,
        skipModerationCheck: false,
      });
      onDone();
    } catch (e) {
      if (e.status === 422 && e.data?.moderation) {
        setModeration(e.data.moderation);
      } else {
        setSubmitError(e.message);
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <>
      <div className="topbar">
        <div className="icon-btn" onClick={onCancel}>
          <svg viewBox="0 0 24 24" fill="none">
            <path d="M15 18l-6-6 6-6" stroke="#2E2B28" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </div>
        <h1>New note</h1>
        <div style={{ width: 34 }} />
      </div>

      <div className="page">
        <div className="field">
          <label>What's this about</label>
          <div className="chip-row">
            {CATEGORIES.map((c) => (
              <div key={c} className={`chip ${category === c ? 'active' : ''}`} onClick={() => setCategory(c)}>
                {c}
              </div>
            ))}
          </div>
        </div>

        <div className="field">
          <label>Your note</label>
          <textarea
            value={text}
            onChange={(e) => onTextChange(e.target.value)}
            placeholder="What's working, or what isn't?"
          />
        </div>

        {checking && <div style={{ fontSize: 11, color: 'var(--ink-soft)', marginBottom: 12 }}>Checking tone…</div>}

        {moderation && (
          <div className="nudge">
            <div>
              {moderation.message}
              <div style={{ marginTop: 8 }}>
                <button onClick={useSuggestion}>Use rewrite</button>
                <button onClick={() => setModeration(null)}>I'll edit it myself</button>
              </div>
            </div>
          </div>
        )}

        <div className="checkbox-row">
          <input
            type="checkbox"
            id="anon"
            checked={isAnonymous}
            onChange={(e) => setIsAnonymous(e.target.checked)}
          />
          <label htmlFor="anon" style={{ margin: 0, textTransform: 'none', fontFamily: 'Work Sans', fontSize: 13 }}>
            Post anonymously
          </label>
        </div>

        {!isAnonymous && (
          <div className="field">
            <label>Your name (optional)</label>
            <input value={authorName} onChange={(e) => setAuthorName(e.target.value)} placeholder="e.g. Priya" />
          </div>
        )}

        {submitError && <div style={{ color: 'var(--alert)', fontSize: 12, marginBottom: 10 }}>{submitError}</div>}

        <button className="btn-primary" onClick={submit} disabled={!text.trim() || submitting}>
          {submitting ? 'Sending…' : 'Tear off & send'}
        </button>
      </div>
    </>
  );
}
