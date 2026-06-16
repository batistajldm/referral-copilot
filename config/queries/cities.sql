-- Distinct cities for the city autocomplete, optionally scoped to a state.
-- Parameters:
--   :state   optional exact state/region match ('' = any)
-- @param state STRING
-- The raw column has dirty values (geo-JSON / blobs); keep only clean names.
SELECT
  address_city AS city,
  COUNT(*)     AS facility_count
FROM databricks_virtue_foundation_dataset_dais_2026.virtue_foundation_dataset.facilities
WHERE address_city IS NOT NULL
  AND address_city <> ''
  AND LOWER(address_city) <> 'null'
  AND address_city NOT LIKE '{%'   -- exclude JSON objects
  AND address_city NOT LIKE '[%'   -- exclude JSON arrays
  AND LENGTH(address_city) <= 40
  AND (:state = '' OR LOWER(address_stateOrRegion) = LOWER(:state))
GROUP BY address_city
ORDER BY facility_count DESC, city ASC
LIMIT 300
