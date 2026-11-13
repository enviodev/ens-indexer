-- Read-side views over the indexer's tables. Applied by the API at startup.
-- v1 and v2 meet on node: v2_domain.node = subgraph_domain.id.

CREATE OR REPLACE VIEW ens_v2_active AS
SELECT d.*, r.node AS parent_node
FROM v2_domain d
JOIN v2_registry r ON r.id = d.registry_id AND r."chainId" = d."chainId"
WHERE r.proven AND d.node IS NOT NULL AND d.status = 'REGISTERED';

-- One row per name. Since the indexer projects every live ENSv2 name into
-- subgraph_domain (src/lib/legacy-projection.ts, as the ENS subgraph does), the v1
-- table already holds the v2 holder, expiry and resolver for those names; protocol
-- says which side owns the row. Reading one table keeps the planner's estimates
-- small: a UNION with a correlated v2 subdomain count was estimated above
-- jit_above_cost, and JIT then compiled every query for about 1 s.
CREATE OR REPLACE VIEW ens_unified_domain AS
SELECT
  s.id, s."chainId", s.name, s."labelName", s.labelhash, s.parent_id, s."subdomainCount",
  s."resolvedAddress_id", s.resolver_id, s.ttl, s."isMigrated", s."createdAt", s.owner_id,
  s.registrant_id, s."wrappedOwner_id", s."expiryDate",
  CASE WHEN EXISTS (
    SELECT 1 FROM legacy_projection p
    WHERE p.id = s."chainId" || '-' || s.id AND p."chainId" = s."chainId" AND p.active
  ) THEN 'v2' ELSE 'v1' END AS protocol
FROM subgraph_domain s;

-- The subgraph keys Registration by labelhash. Stored rows are keyed by node.
CREATE OR REPLACE VIEW ens_unified_registration AS
SELECT d.labelhash AS id, r."chainId", r."registrationDate", r."expiryDate", r.cost, r."labelName", r.domain_id, r.registrant_id
FROM subgraph_registration r
JOIN subgraph_domain d ON d.id = r.domain_id AND d."chainId" = r."chainId";
