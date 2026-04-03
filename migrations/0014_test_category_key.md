# Migration 0014 Test Cases

## Old → New category_key transformation

### Case 1: Raw challenge (old format = 'raw')
- Old: `category_key = 'raw'`
- boat_type = '1x'
- display_name = 'John Doe'
- sex = '', weight_class = ''
- **New**: `1x|john doe|||`

### Case 2: Handicap challenge (old format = 'boat|sex|weight')
- Old: `category_key = '2x|M|HWT'`
- boat_type = '2x'
- display_name = 'Familiedubbel'
- sex = 'M', weight_class = 'HWT'
- **New**: `2x|familiedubbel|M|HWT|`

### Case 3: Age-banded handicap (old format = 'boat|sex|weight|age')
- Old: `category_key = '1x|M|HWT|27-120'`
- boat_type = '1x'
- display_name = 'Veterans Crew'
- sex = 'M', weight_class = 'HWT'
- **New**: `1x|veterans crew|M|HWT|27-120`

## Expected behavior after migration

### Same athlete, same challenge:
1. Submit with boat='2x', crew='Familiedubbel' → Result A
2. Submit with boat='1x', crew='John Doe' → Result B (both exist)
3. Submit again with boat='2x', crew='Familiedubbel' → Replaces Result A
4. Submit with boat='2x', crew='Different Crew' → Result C (new entry)

### Deduplication during migration:
If multiple results exist with same (challenge_id, athlete_id, new_category_key), keep the one with lowest raw_time_s.
