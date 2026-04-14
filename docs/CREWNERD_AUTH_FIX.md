# CrewNerd Authentication Fix

## Issue

The `/api/auth/crewnerd` endpoint was returning 401 errors for valid intervals.icu OAuth access tokens because `verifyIntervalsToken()` was trying endpoints in the wrong order and using a deprecated endpoint.

## Root Cause

The original implementation had **two critical bugs**:

### Bug 1: Missing Nested Object Handling ⚠️ **Primary Issue**

intervals.icu sometimes returns athlete data in a nested format:
```json
{
  "athlete": {
    "id": "i58453",
    "name": "John Doe"
  }
}
```

The original code checked `data.id` directly, which would be `undefined` for nested responses. Even though `/athlete/0` returned `200 OK`, the function failed to extract the athlete ID from the nested `athlete` object.

### Bug 2: Used Wrong Endpoint

The original implementation tried three intervals.icu endpoints in this order:
1. `/athlete/{jwtId}` (if token was JWT format)
2. `/athlete/0` 
3. `/athlete/self` ❌ **Wrong endpoint**

For non-JWT OAuth tokens (like `b945fdd...f3`), only endpoints 2 and 3 were tried. The `/athlete/self` endpoint is documented in the codebase as "wrong" for OAuth.

## Solution

**New endpoint order:**
1. `/athlete/0` ✅ **Most reliable** - Try first for all tokens
2. `/athlete/{jwtId}` - Fallback if JWT decodes

**Key Changes:**
- **Fixed nested object handling** ✅ Now uses `flattenAthleteJson()` and `athleteIdFromPayload()` helper functions (same as production code in `intervals-api.ts`)
- **Removed** `/athlete/self` endpoint (documented as wrong)
- **Prioritized** `/athlete/0` endpoint (reliable for all OAuth tokens)
- **Added** console error logging for debugging
- **Consistent** with production pattern in `intervals-api.ts`

## Code Changes

### Before
```typescript
async function verifyIntervalsToken(bearerToken: string): Promise<string | null> {
  const urls: string[] = [];
  const jwtId = tryIntervalsJwtAthleteId(bearerToken);
  if (jwtId) {
    urls.push(`https://intervals.icu/api/v1/athlete/${encodeURIComponent(jwtId)}`);
  }
  urls.push('https://intervals.icu/api/v1/athlete/0');
  urls.push('https://intervals.icu/api/v1/athlete/self'); // ❌ Wrong
  // ... loop through URLs
}
```

### After
```typescript
async function verifyIntervalsToken(bearerToken: string): Promise<string | null> {
  // Try /athlete/0 first (most reliable, works for all OAuth tokens)
  const res0 = await fetch('https://intervals.icu/api/v1/athlete/0', {
    headers: { 'Authorization': `Bearer ${bearerToken}` },
  });
  
  if (res0.ok) {
    const raw = await res0.json();
    const data = flattenAthleteJson(raw); // ✅ Handle nested athlete object
    if (data) {
      const athleteId = athleteIdFromPayload(data); // ✅ Robust ID extraction
      if (athleteId) {
        return athleteId;
      }
    }
  } else {
    console.error(`[verifyIntervalsToken] /athlete/0 failed: ${res0.status}`);
  }

  // Fallback: try JWT-decoded athlete ID if available
  const jwtId = tryIntervalsJwtAthleteId(bearerToken);
  if (jwtId) {
    // ... same pattern with flattenAthleteJson + athleteIdFromPayload
  }
  
  return null;
}
```

## Testing

All existing tests pass. The fix handles:
- ✅ Non-JWT OAuth tokens (like `b945fdd...f3`)
- ✅ JWT OAuth tokens
- ✅ Invalid tokens (return 401)
- ✅ Error logging for debugging

## For CrewNerd Developers

The `/api/auth/crewnerd` endpoint now works correctly with standard intervals.icu OAuth access tokens:

```bash
POST https://rownative.icu/api/auth/crewnerd
Authorization: Bearer <your-intervals.icu-access-token>

# Returns:
{
  "api_key": "<athleteId>.<mac>"
}
```

Use the returned API key for subsequent requests:
```bash
GET https://rownative.icu/api/courses/kml/liked
Authorization: ApiKey <athleteId>.<mac>
```

## References

- intervals.icu API docs note that `/athlete/0` is an alias for the authenticated user
- Our own `intervals-api.ts` documents `/athlete/self` as "wrong" for OAuth
- `fetchIntervalsAthleteProfileWithMeta` uses the same pattern (try `/athlete/0` first)
