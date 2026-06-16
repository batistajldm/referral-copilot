-- Distinct states/regions with facility counts, for the location filter dropdown.
-- The raw column has dirty values (some rows contain geo-JSON or list blobs);
-- keep only clean, human-readable state names.
SELECT
  address_stateOrRegion AS state,
  COUNT(*)              AS facility_count
FROM databricks_virtue_foundation_dataset_dais_2026.virtue_foundation_dataset.facilities
WHERE address_stateOrRegion IS NOT NULL
  AND address_stateOrRegion <> ''
  AND LOWER(address_stateOrRegion) <> 'null'
  AND address_stateOrRegion NOT LIKE '{%'   -- exclude JSON objects (e.g. {"coordinates":...})
  AND address_stateOrRegion NOT LIKE '[%'   -- exclude JSON arrays
  AND address_stateOrRegion NOT LIKE '%:%'  -- exclude key:value blobs
  AND LENGTH(address_stateOrRegion) <= 40
GROUP BY address_stateOrRegion
ORDER BY facility_count DESC, state ASC
