import { parseArgs } from 'node:util';
import type { RunMode } from './config.js';

export function parseCli(args: string[]) {
  const parsed = parseArgs({ args, allowPositionals: true, strict: true, options: {
    config: { type: 'string', default: 'config/config.local.json' },
    slot: { type: 'string' }, date: { type: 'string' }, attempts: { type: 'string' },
    headless: { type: 'boolean', default: false }, close: { type: 'boolean', default: false },
    help: { type: 'boolean', default: false },
    'confirm-reservation-side-effects': { type: 'boolean', default: false },
  } });
  const mode = parsed.positionals[0] ?? 'inspect';
  if (parsed.positionals.length > 1 || !['inspect', 'rehearsal', 'full-rehearsal', 'live', 'doctor'].includes(mode)) throw new Error('Use inspect, rehearsal, full-rehearsal, live, or doctor.');
  const sideEffects = mode === 'live' || mode === 'full-rehearsal';
  if (sideEffects && !parsed.values['confirm-reservation-side-effects'] && !parsed.values.help) throw new Error(`${mode} requires --confirm-reservation-side-effects.`);
  if (sideEffects && (parsed.values.headless || parsed.values.close)) throw new Error('Reservation modes require a visible browser and manual closing.');
  if (mode === 'live' && (parsed.values.date || parsed.values.slot || parsed.values.attempts)) throw new Error('Live target date, both slots and polling budget come from the validated local config.');
  if (mode === 'full-rehearsal' && !parsed.values.slot && !parsed.values.help) throw new Error('full-rehearsal requires --slot 10:00 or --slot 10:30.');
  if (parsed.values.slot && !['10:00', '10:30'].includes(parsed.values.slot)) throw new Error('Slot must be 10:00 or 10:30.');
  const attempts = parsed.values.attempts ? Number(parsed.values.attempts) : undefined;
  if (attempts !== undefined && (!Number.isInteger(attempts) || attempts < 1 || attempts > 20)) throw new Error('--attempts must be an integer from 1 to 20 for a short rehearsal.');
  return { mode: mode as RunMode | 'doctor', ...parsed.values, attempts, confirmed: parsed.values['confirm-reservation-side-effects'] };
}
