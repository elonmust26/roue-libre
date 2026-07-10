/**
 * v0.2 — vérification de la version de la CLI claude au démarrage.
 * Avertit (SANS bloquer) si la version installée diffère significativement de
 * celle testée en dev, pour anticiper un changement de format stream-json.
 */
import { execFileSync } from 'node:child_process';

/** Version de la CLI claude avec laquelle roue-libre a été testé en dev. */
export const TESTED_CLI_VERSION = '2.1.206';

export interface CliVersionCheck {
  /** Version détectée (« major.minor.patch » ou chaîne brute), null si CLI introuvable. */
  detected: string | null;
  /** Avertissement à afficher, null si tout va bien. */
  warning: string | null;
}

/** Extrait « major.minor » d'une chaîne de version. */
function majorMinor(version: string): { major: number; minor: number } | null {
  const m = version.match(/(\d+)\.(\d+)/);
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]) };
}

/**
 * Compare une version détectée à la version testée. Pure et testable.
 * « Significativement différent » : majeure différente, ou écart de version
 * mineure ≥ 5 (les patchs sont ignorés).
 */
export function compareCliVersion(detected: string, tested: string = TESTED_CLI_VERSION): string | null {
  const d = majorMinor(detected);
  const t = majorMinor(tested);
  if (!d) {
    return `version CLI illisible (« ${detected} ») — impossible de vérifier la compatibilité (testée en dev : ${tested}).`;
  }
  if (!t) return null;
  if (d.major !== t.major) {
    return (
      `la CLI claude installée (${detected}) a une version MAJEURE différente de celle testée en dev (${tested}) — ` +
      `le format de sortie stream-json peut avoir changé ; le cumul de coûts et le suivi de session sont à surveiller.`
    );
  }
  if (Math.abs(d.minor - t.minor) >= 5) {
    return (
      `la CLI claude installée (${detected}) s'éloigne de la version testée en dev (${tested}) — ` +
      `à surveiller si le suivi de coûts ou les sessions se comportent bizarrement.`
    );
  }
  return null;
}

/** Exécute `claude --version` et rend le diagnostic. N'échoue jamais. */
export function checkCliVersion(claudeBin = 'claude'): CliVersionCheck {
  let raw: string;
  try {
    raw = execFileSync(claudeBin, ['--version'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 10_000,
    }).trim();
  } catch {
    return {
      detected: null,
      warning:
        `CLI « ${claudeBin} » introuvable ou muette (claude --version a échoué) — ` +
        `le mode réel ne pourra pas lancer les rôles. Installe Claude Code ou vérifie le PATH.`,
    };
  }
  return { detected: raw, warning: compareCliVersion(raw) };
}
