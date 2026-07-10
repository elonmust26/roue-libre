/**
 * v0.2 — unités pures : mapping effort → env de la CLI (budget de thinking)
 * et comparaison de version CLI (avertissement sans blocage).
 */

import { describe, expect, it } from 'vitest';

import { envForEffort } from '../src/core/engine.js';
import { compareCliVersion, TESTED_CLI_VERSION } from '../src/core/cliversion.js';

describe('effort par rôle → environnement CLI (v0.2)', () => {
  it('low → réflexion étendue désactivée (MAX_THINKING_TOKENS=0)', () => {
    expect(envForEffort('low')).toEqual({ MAX_THINKING_TOKENS: '0' });
  });

  it('medium → défaut de la CLI (aucune variable posée)', () => {
    expect(envForEffort('medium')).toEqual({});
  });

  it('high → budget de réflexion maximal', () => {
    expect(envForEffort('high')).toEqual({ MAX_THINKING_TOKENS: '31999' });
  });
});

describe('vérification de version CLI (v0.2)', () => {
  it('version identique à celle testée → aucun avertissement', () => {
    expect(compareCliVersion(TESTED_CLI_VERSION)).toBeNull();
  });

  it('écart de patch ou de mineure faible → aucun avertissement', () => {
    expect(compareCliVersion('2.1.999', '2.1.206')).toBeNull();
    expect(compareCliVersion('2.4.0', '2.1.206')).toBeNull();
  });

  it('majeure différente → avertissement explicite (sans blocage)', () => {
    const warning = compareCliVersion('3.0.1', '2.1.206');
    expect(warning).not.toBeNull();
    expect(warning).toContain('3.0.1');
    expect(warning).toContain('2.1.206');
    expect(warning?.toLowerCase()).toContain('majeure');
  });

  it('écart de mineure ≥ 5 → avertissement de dérive', () => {
    expect(compareCliVersion('2.7.0', '2.1.206')).not.toBeNull();
  });

  it('version illisible → avertissement de non-vérifiabilité', () => {
    const warning = compareCliVersion('inconnu', '2.1.206');
    expect(warning).toContain('illisible');
  });
});
