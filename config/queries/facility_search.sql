-- Referral Copilot: evidence-ranked facility search with geographic proximity.
-- Track 3 framing is "<need> near <place>" (e.g. "dialysis near Jaipur"), so when
-- a city is given we don't filter to that city — we derive its centroid from the
-- dataset's own coordinates and rank every matching facility by haversine
-- distance to it. That surfaces nearby facilities in neighbouring towns too.
-- Parameters:
--   :state     optional exact state/region hard filter ('' = any)
--   :need      optional free-text need/specialty; matched against specialties,
--              capability claims, procedures performed, equipment, and the
--              free-text description ('' = any)
--   :city      optional place to be "near"; derives a reference point used to
--              rank by distance ('' = rank by evidence only, no proximity)
-- @param state STRING
-- @param need STRING
-- @param city STRING
WITH base AS (
  SELECT
    unique_id,
    name,
    address_city                                   AS city,
    address_stateOrRegion                          AS state,
    specialties,
    capability,
    -- structured clinical-evidence fields: procedures performed and equipment
    -- available. Same JSON-array shape as `capability`; we expose and search them
    -- so a need evidenced ONLY here (not in specialties/capability/description)
    -- is no longer missed (e.g. dialysis listed as a procedure).
    `procedure`                                    AS procedure_list,
    equipment                                      AS equipment_list,
    description,
    capacity,
    numberDoctors,
    latitude,
    longitude,
    source_urls,
    officialWebsite,
    officialPhone,
    -- number of evidence (capability) claims attached to the facility
    CASE
      WHEN capability LIKE '[%'
        THEN COALESCE(size(from_json(capability, 'array<string>')), 0)
      WHEN capability IS NOT NULL AND capability <> '' THEN 1
      ELSE 0
    END                                            AS n_capabilities
  FROM databricks_virtue_foundation_dataset_dais_2026.virtue_foundation_dataset.facilities
),
-- Reference point: robust centre of the facilities whose city matches :city.
-- We use the MEDIAN (percentile_approx 0.5) of lat/lon rather than the mean so
-- a few mis-geocoded rows — or a same-named place in a distant state — can't
-- drag the reference point off the actual city. Empty :city (or no match)
-- yields a NULL reference → distance is NULL → we fall back to evidence ranking.
ref AS (
  SELECT
    percentile_approx(latitude, 0.5)  AS ref_lat,
    percentile_approx(longitude, 0.5) AS ref_lon
  FROM base
  WHERE :city <> ''
    AND latitude IS NOT NULL AND longitude IS NOT NULL
    AND LOWER(city) LIKE LOWER(CONCAT('%', :city, '%'))
)
SELECT
  b.unique_id,
  b.name,
  b.city,
  b.state,
  b.specialties,
  b.capability,
  b.procedure_list,
  b.equipment_list,
  b.description,
  b.capacity,
  b.numberDoctors,
  b.latitude,
  b.longitude,
  b.source_urls,
  b.officialWebsite,
  b.officialPhone,
  b.n_capabilities,
  -- transparent evidence score: rewards facilities with cited, verifiable signals
  (
      CASE WHEN b.capability  IS NOT NULL AND b.capability  NOT IN ('', 'null') THEN 2 ELSE 0 END
    + CASE WHEN b.source_urls IS NOT NULL AND b.source_urls NOT IN ('', 'null') THEN 2 ELSE 0 END
    + CASE WHEN b.latitude    IS NOT NULL                        THEN 1 ELSE 0 END
    + CASE WHEN b.capacity     IS NOT NULL AND b.capacity     NOT IN ('', 'null') THEN 1 ELSE 0 END
    + CASE WHEN b.numberDoctors IS NOT NULL AND b.numberDoctors NOT IN ('', 'null') THEN 1 ELSE 0 END
    + LEAST(b.n_capabilities, 5)
  )                                                AS evidence_score,
  -- great-circle distance (km) from the :city centroid; NULL when no reference
  CASE
    WHEN r.ref_lat IS NOT NULL AND b.latitude IS NOT NULL AND b.longitude IS NOT NULL
      THEN ROUND(
        6371 * 2 * ASIN(SQRT(
            POWER(SIN(RADIANS(b.latitude - r.ref_lat) / 2), 2)
          + COS(RADIANS(r.ref_lat)) * COS(RADIANS(b.latitude))
            * POWER(SIN(RADIANS(b.longitude - r.ref_lon) / 2), 2)
        )), 1)
    ELSE NULL
  END                                              AS distance_km
FROM base b
CROSS JOIN ref r
WHERE (:state = '' OR LOWER(b.state) = LOWER(:state))
  AND (
        :need = ''
        OR LOWER(b.specialties)    LIKE LOWER(CONCAT('%', :need, '%'))
        OR LOWER(b.capability)     LIKE LOWER(CONCAT('%', :need, '%'))
        OR LOWER(b.procedure_list) LIKE LOWER(CONCAT('%', :need, '%'))
        OR LOWER(b.equipment_list) LIKE LOWER(CONCAT('%', :need, '%'))
        OR LOWER(b.description)    LIKE LOWER(CONCAT('%', :need, '%'))
      )
ORDER BY
  -- when a reference point exists, nearest first; otherwise evidence-first
  CASE WHEN distance_km IS NULL THEN 1 ELSE 0 END,
  distance_km ASC,
  evidence_score DESC,
  n_capabilities DESC,
  name ASC
LIMIT 50
