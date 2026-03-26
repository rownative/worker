/**
 * Blocklist check for challenge names and crew/display names.
 * Add terms via PR. Use word-boundary matching to reduce false positives.
 */

const BLOCKED_TERMS: string[] = [
  // Profanity - extend as needed via PR
  'fuck',
  'shit',
  'cunt',
  'nigger',
  'nigga',
  'faggot',
  'retard',
  'whore',
  'slut',
  'bitch',
  'asshole',
  'dick',
  'pussy',
  'cock',
  'bastard',
];

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function isNameAllowed(text: string): { allowed: boolean; reason?: string } {
  if (!text || !text.trim()) return { allowed: true };
  const trimmed = text.trim();
  const lower = trimmed.toLowerCase();
  for (const term of BLOCKED_TERMS) {
    const regex = new RegExp(`\\b${escapeRegex(term)}\\b`, 'i');
    if (regex.test(lower)) {
      return { allowed: false, reason: "That name contains language we don't allow. Please choose a different name." };
    }
  }
  return { allowed: true };
}
