# Challenge Results Category Key Fix

## Problem

When submitting challenge results, the system was incorrectly replacing results across different boat types and crew names.

**Root cause**: The `category_key` used to determine uniqueness was set to `'raw'` for all non-handicap challenges, regardless of boat type or crew name. This meant:

```typescript
// OLD (buggy) behavior:
let categoryKey = hasHandicap
  ? (boatType || '') + '|' + (sex || '') + '|' + (weightClass || '')
  : 'raw';  // ❌ Always 'raw' for non-handicap challenges!
```

**Result**: When an athlete submitted:
1. First result: boat=2x, crew="Familiedubbel" → `categoryKey = 'raw'`
2. Second result: boat=1x, own name → `categoryKey = 'raw'`

The second submission would trigger `ON CONFLICT(challenge_id, athlete_id, category_key)` and **replace** the first result, even though they were different boats and crews.

## Solution

### Code Changes ([`src/index.ts`](../src/index.ts))

Updated `category_key` to **always** include boat type and display name (normalized):

```typescript
// NEW (fixed) behavior:
const normalizedDisplayName = (displayName || '').trim().toLowerCase();
let categoryKey = (boatType || '') + '|' + normalizedDisplayName + '|' + (sex || '') + '|' + (weightClass || '');

// For age-banded results:
if (handicap.ageBand) {
  categoryKey = (boatType || '') + '|' + normalizedDisplayName + '|' + (sex || '') + '|' + (weightClass || '') + '|' + handicap.ageBand;
}
```

**Format**: `boat|displayName|sex|weight[|ageBand]`

### Database Migration ([`migrations/0014_challenge_results_category_key_with_crew.sql`](../migrations/0014_challenge_results_category_key_with_crew.sql))

Recomputes `category_key` for all existing results:
- Extracts age band from old keys if present
- Inserts normalized `display_name` into the key
- Deduplicates if multiple results now map to same key (keeps best/fastest time)

## New Behavior

### Same athlete, same challenge:

| Submission | Boat | Crew Name | Result |
|------------|------|-----------|--------|
| #1 | 2x | "Familiedubbel" | Creates result A with key `2x\|familiedubbel\|M\|HWT` |
| #2 | 1x | "John Doe" | Creates result B with key `1x\|john doe\|M\|HWT` (both exist!) |
| #3 | 2x | "Familiedubbel" | **Replaces** result A (same key) |
| #4 | 2x | "Different Crew" | Creates result C with key `2x\|different crew\|M\|HWT` |

### Key insight:
- **Different boat type OR different crew name** → new result
- **Same boat type AND same crew name** → replaces existing result

## Deployment

1. **Local/development**: Already applied via `npx wrangler d1 migrations apply rowing-courses-db --local`
2. **Production**:
   ```bash
   npx wrangler d1 migrations apply rowing-courses-db --remote
   npx wrangler deploy
   ```

## Testing

All existing tests pass (87 tests). The migration:
- ✅ Applied successfully to local D1
- ✅ Handles raw challenges (old key = `'raw'`)
- ✅ Handles handicap challenges (old key = `'boat|sex|weight'`)
- ✅ Handles age-banded challenges (old key = `'boat|sex|weight|ageBand'`)
- ✅ Deduplicates conflicts by keeping best time

## Files Changed

- [`src/index.ts`](../src/index.ts) - Lines 2342-2377 (category_key computation)
- [`migrations/0014_challenge_results_category_key_with_crew.sql`](../migrations/0014_challenge_results_category_key_with_crew.sql) - New migration
- [`migrations/0014_test_category_key.md`](../migrations/0014_test_category_key.md) - Test documentation
