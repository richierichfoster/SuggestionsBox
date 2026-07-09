import { useState, useEffect, useCallback } from 'react';
import { api } from './api';
import Home from './views/Home';
import Compose from './views/Compose';
import NoteDetail from './views/NoteDetail';
import Owner from './views/Owner';

export default function App() {
  const [view, setView] = useState({ name: 'home' });
  const [businessName, setBusinessName] = useState('');

  useEffect(() => {
    api.getBusiness().then((b) => setBusinessName(b.name)).catch(() => setBusinessName('Suggestions Box'));
  }, []);

  const goHome = useCallback(() => setView({ name: 'home' }), []);
  const goCompose = useCallback(() => setView({ name: 'compose' }), []);
  const goDetail = useCallback((id) => setView({ name: 'detail', id }), []);
  const goOwner = useCallback(() => setView({ name: 'owner' }), []);

  return (
    <>
      {view.name === 'home' && (
        <Home businessName={businessName} onCompose={goCompose} onOpenNote={goDetail} onOwner={goOwner} />
      )}
      {view.name === 'compose' && <Compose onDone={goHome} onCancel={goHome} />}
      {view.name === 'detail' && <NoteDetail id={view.id} onBack={goHome} />}
      {view.name === 'owner' && <Owner onBack={goHome} />}
    </>
  );
}
