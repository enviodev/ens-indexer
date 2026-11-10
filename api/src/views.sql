-- Read-side views over the indexer's tables. Applied by the API at startup.
-- v1 and v2 meet on node: v2_domain.node = subgraph_domain.id.

CREATE OR REPLACE VIEW ens_v2_active AS
SELECT d.*, r.node AS parent_node
FROM v2_domain d
JOIN v2_registry r ON r.id = d.registry_id AND r."chainId" = d."chainId"
WHERE r.proven AND d.node IS NOT NULL AND d.status = 'REGISTERED';

-- One row per name. A registered v2 name replaces its v1 row: after migration
-- the v1 row is owned by the graveyard. A reservation does not replace anything,
-- since until a name migrates v1 is still the authority.
CREATE OR REPLACE VIEW ens_unified_domain AS
SELECT
  a.node AS id, a."chainId", a.name, a.label AS "labelName", a.labelhash,
  a.parent_node AS parent_id,
  (SELECT count(*)::int FROM v2_domain c
     JOIN v2_registry cr ON cr.id = c.registry_id AND cr."chainId" = c."chainId"
    WHERE cr.node = a.node AND cr."chainId" = a."chainId" AND c.status <> 'UNREGISTERED') AS "subdomainCount",
  NULL::text AS "resolvedAddress_id",
  CASE WHEN a.resolver IS NULL THEN NULL
       ELSE a."chainId" || '-' || a.resolver || '-' || a.node END AS resolver_id,
  NULL::numeric AS ttl,
  true AS "isMigrated",
  a."createdTimestamp" AS "createdAt",
  COALESCE(a.owner, '0x0000000000000000000000000000000000000000') AS owner_id,
  a.owner AS registrant_id,
  NULL::text AS "wrappedOwner_id",
  a.expiry AS "expiryDate",
  'v2'::text AS protocol
FROM ens_v2_active a
UNION ALL
SELECT
  s.id, s."chainId", s.name, s."labelName", s.labelhash, s.parent_id, s."subdomainCount",
  s."resolvedAddress_id", s.resolver_id, s.ttl, s."isMigrated", s."createdAt", s.owner_id,
  s.registrant_id, s."wrappedOwner_id", s."expiryDate", 'v1'::text AS protocol
FROM subgraph_domain s
WHERE NOT EXISTS (SELECT 1 FROM ens_v2_active a WHERE a.node = s.id AND a."chainId" = s."chainId");

-- The subgraph keys Registration by labelhash. Stored rows are keyed by node.
CREATE OR REPLACE VIEW ens_unified_registration AS
SELECT d.labelhash AS id, r."chainId", r."registrationDate", r."expiryDate", r.cost, r."labelName", r.domain_id, r.registrant_id
FROM subgraph_registration r
JOIN subgraph_domain d ON d.id = r.domain_id AND d."chainId" = r."chainId";
