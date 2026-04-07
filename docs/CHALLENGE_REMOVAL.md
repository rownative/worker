# Challenge Removal Feature

## Overview

This feature allows challenge organizers to remove duplicate or incorrectly created challenges through a self-service UI. Organizers can optionally merge results from the duplicate challenge into another challenge before removal.

## Use Case

When a challenge organizer accidentally creates duplicate challenges, they can:

1. **Soft delete**: Hide the duplicate challenge from public view while preserving the data
2. **Merge and delete**: Migrate all results to another challenge before hiding the duplicate

## Implementation

### API Endpoint

**DELETE /api/organiser/challenges/:id**

Query parameters:
- `mergeInto` (optional): Challenge ID to merge results into before removal

The endpoint:
1. Verifies the requesting user owns the challenge
2. If `mergeInto` is provided:
   - Verifies the target challenge exists and is owned by the same user
   - Migrates all results using `INSERT ... ON CONFLICT` to keep the fastest time per category
3. Adds the challenge ID to `removed-challenges.json` via GitHub API
4. Creates a GitHub Issue documenting the removal
5. Returns success status and issue URL

### UI Components

**organiser.html / organiser.js**

- Added "Delete" button to each row in "My challenges" table
- Delete flow:
  1. If challenge has results and user has other challenges:
     - Prompts user to optionally select a challenge to merge results into
  2. Confirms deletion
  3. Calls DELETE endpoint
  4. Refreshes challenge list on success

### GitHub Integration

On deletion:
1. Updates `removed-challenges.json` with entry:
   ```json
   {
     "id": "challenge-id",
     "removedBy": "organizer-athlete-id",
     "removedAt": "2026-03-27T10:00:00.000Z",
     "reason": "Merged into challenge-xyz" // or "Removed by organizer"
   }
   ```
2. Creates GitHub Issue with:
   - Title: "Challenge removed: {challenge name}"
   - Label: `challenge-removal`
   - Body: Challenge ID, organizer ID, and reason

### Result Merging Logic

When merging results:

```sql
INSERT INTO challenge_results (...)
SELECT id, {target_challenge_id}, athlete_id, ...
FROM challenge_results
WHERE challenge_id = {source_challenge_id}
ON CONFLICT(challenge_id, athlete_id, category_key) DO UPDATE SET
  raw_time_s = CASE WHEN excluded.raw_time_s < challenge_results.raw_time_s 
    THEN excluded.raw_time_s ELSE challenge_results.raw_time_s END,
  -- (updates other fields to match the fastest submission)
```

This ensures:
- Each athlete keeps only their best time per category in the target challenge
- All metadata (boat type, display name, etc.) is preserved
- The `category_key` is updated to reference the new challenge ID

## Testing

- Added integration test: `DELETE /api/organiser/challenges/:id returns 401 when not authenticated`
- Manual testing via UI confirms:
  - Soft delete works for challenges without results
  - Merge flow prompts correctly for challenges with results
  - Results migrate correctly, keeping fastest times

## Deployment

1. Deploy worker: `npx wrangler deploy` (in `worker/` directory)
2. Regenerate and commit `index.json` if needed
3. Deploy frontend: GitHub Pages auto-deploys on push to `main`

## Future Enhancements

- Add admin UI to review removal requests
- Send email notifications to course owners when their challenges are removed
- Allow bulk deletion/merging for multiple duplicates
