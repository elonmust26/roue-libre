/**
 * v0.2 — notifications de fin d'étape, 100 % locales (aucun service tiers) :
 * notification desktop si la permission est accordée, sinon signal sonore
 * (WebAudio). Déclenchées quand une tâche atteint review (prête à valider)
 * ou blocked (intervention requise). Préférence stockée en localStorage.
 */

const STORAGE_KEY = 'roue-libre.notifications';

export function notificationsEnabled(): boolean {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

export function setNotificationsEnabled(enabled: boolean): void {
  try {
    if (enabled) window.localStorage.setItem(STORAGE_KEY, '1');
    else window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* stockage indisponible — la préférence ne survivra pas au rechargement */
  }
}

/** Demande la permission desktop. Rend true si accordée. */
export async function requestNotificationPermission(): Promise<boolean> {
  if (typeof Notification === 'undefined') return false;
  if (Notification.permission === 'granted') return true;
  if (Notification.permission === 'denied') return false;
  try {
    return (await Notification.requestPermission()) === 'granted';
  } catch {
    return false;
  }
}

/** Bip court (double note) via WebAudio — repli quand pas de permission desktop. */
function beep(): void {
  try {
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const play = (freq: number, at: number) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, ctx.currentTime + at);
      gain.gain.exponentialRampToValueAtTime(0.12, ctx.currentTime + at + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + at + 0.25);
      osc.connect(gain).connect(ctx.destination);
      osc.start(ctx.currentTime + at);
      osc.stop(ctx.currentTime + at + 0.3);
    };
    play(880, 0);
    play(1174, 0.18);
    window.setTimeout(() => void ctx.close(), 800);
  } catch {
    /* audio indisponible — tant pis, la notification reste visuelle dans l'UI */
  }
}

/** Émet la notification (desktop si possible, sinon son). */
export function notifyStageChange(kind: 'review' | 'blocked', project: string): void {
  if (!notificationsEnabled()) return;
  const title = kind === 'review' ? 'roue libre — prête à valider' : 'roue libre — intervention requise';
  const body =
    kind === 'review'
      ? `${project} : la tâche est en Revue. Approuve, renvoie ou annule depuis le dashboard.`
      : `${project} : le pipeline est bloqué. Ouvre l'écran Alerte pour relancer.`;
  if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
    try {
      new Notification(title, { body, tag: `roue-${kind}` });
      return;
    } catch {
      /* Notification a échoué — repli sonore ci-dessous */
    }
  }
  beep();
}
