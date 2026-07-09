/**
 * App — état global (WS + REST) et navigation par onglets entre les 6 écrans.
 * L'onglet Alerte n'est actif que si le pipeline est bloqué (badge rouge).
 */

import { useState } from 'react';
import { useOrchestrator } from './ws';
import { Dashboard } from './screens/Dashboard';
import { NewTask } from './screens/NewTask';
import { Timeline } from './screens/Timeline';
import { DiffReview } from './screens/DiffReview';
import { AlertDetail } from './screens/AlertDetail';
import { Settings } from './screens/Settings';

export type TabId = 'dashboard' | 'new' | 'timeline' | 'review' | 'alert' | 'settings';

const TABS: { id: TabId; label: string }[] = [
  { id: 'dashboard', label: 'Dashboard' },
  { id: 'new', label: 'Nouvelle tâche' },
  { id: 'timeline', label: 'Timeline' },
  { id: 'review', label: 'Revue' },
  { id: 'alert', label: 'Alerte' },
  { id: 'settings', label: 'Paramètres' },
];

export default function App() {
  const { status, events, connected } = useOrchestrator();
  const [tab, setTab] = useState<TabId>('dashboard');

  const blocked = status?.stage === 'blocked';

  return (
    <div className="app">
      <header className="app-header">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true" />
          roue&nbsp;libre
        </div>
        <nav className="tabs" aria-label="Écrans">
          {TABS.map((t) => {
            const isAlert = t.id === 'alert';
            const disabled = isAlert && !blocked;
            return (
              <button
                key={t.id}
                type="button"
                className={`tab${tab === t.id ? ' tab-active' : ''}${disabled ? ' tab-disabled' : ''}`}
                disabled={disabled}
                title={disabled ? 'Aucune alerte active' : undefined}
                onClick={() => setTab(t.id)}
              >
                {t.label}
                {isAlert && blocked && <span className="tab-badge" aria-label="alerte active" />}
              </button>
            );
          })}
        </nav>
        <div className={`conn-pill${connected ? ' conn-ok' : ' conn-ko'}`}>
          <span className="conn-dot" aria-hidden="true" />
          {connected ? 'connecté' : 'hors ligne'}
        </div>
      </header>

      {!connected && (
        <div className="conn-banner" role="alert">
          connexion perdue — reconnexion…
        </div>
      )}

      <main className="app-main">
        {tab === 'dashboard' && <Dashboard status={status} events={events} onNavigate={setTab} />}
        {tab === 'new' && <NewTask status={status} onNavigate={setTab} />}
        {tab === 'timeline' && <Timeline events={events} />}
        {tab === 'review' && <DiffReview status={status} onNavigate={setTab} />}
        {tab === 'alert' && <AlertDetail status={status} events={events} onNavigate={setTab} />}
        {tab === 'settings' && <Settings />}
      </main>
    </div>
  );
}
