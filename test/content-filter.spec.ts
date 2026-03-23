import { describe, it, expect } from 'vitest';
import { isNameAllowed } from '../src/content-filter';

describe('content-filter', () => {
  it('allows empty or whitespace-only input', () => {
    expect(isNameAllowed('')).toEqual({ allowed: true });
    expect(isNameAllowed('   ')).toEqual({ allowed: true });
  });

  it('blocks obvious profanity', () => {
    expect(isNameAllowed('shit')).toEqual({ allowed: false, reason: expect.any(String) });
    expect(isNameAllowed('fuck')).toEqual({ allowed: false, reason: expect.any(String) });
    expect(isNameAllowed('My crew is shit')).toEqual({ allowed: false, reason: expect.any(String) });
  });

  it('allows clean names', () => {
    expect(isNameAllowed('Gingerbread Girls Quad')).toEqual({ allowed: true });
    expect(isNameAllowed('Charles River Rowing Club')).toEqual({ allowed: true });
    expect(isNameAllowed('Spring 2025 Challenge')).toEqual({ allowed: true });
  });

  it('uses word boundaries to avoid false positives', () => {
    expect(isNameAllowed('Scunthorpe')).toEqual({ allowed: true });
    expect(isNameAllowed('classic')).toEqual({ allowed: true });
  });
});
