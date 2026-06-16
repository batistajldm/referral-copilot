-- Distinct specialty terms across all facilities, for the "care need" autocomplete.
-- The `specialties` column is dirty: most rows are JSON arrays (e.g.
-- ["oncology","cardiology"]), some are plain strings, some are null/blobs.
-- Explode the arrays into individual terms and keep clean, human-typeable ones.
WITH exploded AS (
  SELECT trim(term) AS specialty
  FROM databricks_virtue_foundation_dataset_dais_2026.virtue_foundation_dataset.facilities
  LATERAL VIEW explode(
    CASE
      WHEN specialties LIKE '[%' THEN from_json(specialties, 'array<string>')
      WHEN specialties IS NOT NULL AND specialties <> '' THEN array(specialties)
      ELSE array()
    END
  ) t AS term
)
SELECT
  specialty,
  COUNT(*) AS facility_count
FROM exploded
WHERE specialty IS NOT NULL
  AND specialty <> ''
  AND LOWER(specialty) <> 'null'
  AND specialty NOT LIKE '{%'   -- exclude JSON objects
  AND specialty NOT LIKE '[%'   -- exclude nested arrays
  AND specialty NOT LIKE '%:%'  -- exclude key:value blobs
  AND LENGTH(specialty) <= 50
GROUP BY specialty
ORDER BY facility_count DESC, specialty ASC
LIMIT 300
