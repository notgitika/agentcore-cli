# Design — Harness PrivateLink Inbound

**Date:** 2026-06-12 **Owner:** Aidan Daly **Branches:** CLI `feat/harness-privatelink-inbound` (off `feat/harness-cdk`)
· L3 `feat/harness-privatelink-inbound-construct` (off `feat/harness-cdk-construct-evo`) **Status:** approved —
implementing

## 1. What this is

**Feature identity (confirmed).** This is the `PrivateEndpoint` + `PrivateEndpointOverrides` fields added to
`CustomJWTAuthorizerConfiguration` in the harness GA-parity CFN work — the owner's own commit `bf141a13` labels it
verbatim _"PrivateEndpoint + PrivateEndpointOverrides on CustomJWTAuthorizer (PrivateLink inbound)"_. It is one of the
three GA-parity CFN slices (LiteLLM → Tejas, S3/Git Skills → Avi, **PrivateEndpoint → Aidan**). "Inbound" refers to the
**inbound authorizer** it nests under, not traffic direction.

> Note: there is a _separate, pre-existing_ account-level AgentCore data-plane PrivateLink (an out-of-band
> `com.amazonaws.<region>.bedrock-agentcore` interface VPC endpoint, auth-independent) that the harness inherits. That
> is NOT this task — it has no field on the Harness resource and is created out of band. This task is strictly the CFN
> `PrivateEndpoint` field above.

PrivateLink Inbound lets a harness reach its **OIDC discovery endpoint (and optionally other domains) over a private
network** when using CUSTOM_JWT inbound authorization. It is a new `PrivateEndpoint` configuration nested inside
`AuthorizerConfiguration.CustomJWTAuthorizer` — it rides entirely on the existing CUSTOM_JWT path and is independent of
the harness's own runtime network mode. CUSTOM_JWT-only by the service model: the `AuthorizerConfiguration` union has a
single member (`customJWTAuthorizer`); AWS_IAM/SigV4 is the implicit default-on-absence with no private-network config
of its own.

Source of truth: the `AWS::BedrockAgentCore::Harness` CFN spec on the `harness-ga-parity-features` branch
(`.../aws/bedrockagentcore/harness/aws-bedrockagentcore-harness.json`, definitions `PrivateEndpoint` /
`SelfManagedLatticeResource` / `ManagedVpcResource` / `PrivateEndpointOverride`, nested in
`CustomJWTAuthorizerConfiguration`).

## 2. The CFN shape (PascalCase, authoritative)

`CustomJWTAuthorizerConfiguration` gains two optional fields:

- **`PrivateEndpoint`** — exactly one of:
  - `SelfManagedLatticeResource`: `{ ResourceConfigurationIdentifier }` (string, 20–2048, pattern
    `^((rcfg-[0-9a-z]{17})|(arn:[a-z0-9\-]+:vpc-lattice:[a-zA-Z0-9\-]+:\d{12}:resourceconfiguration/rcfg-[0-9a-z]{17}))$`)
  - `ManagedVpcResource`: `{ VpcIdentifier, SubnetIds, EndpointIpAddressType }` required
    - `{ SecurityGroupIds (≤5), Tags (≤50), RoutingDomain (3–255) }` optional.
    * `VpcIdentifier` pattern `^vpc-(([0-9a-z]{8})|([0-9a-z]{17}))$`
    * `SubnetIds` items `^subnet-[0-9a-zA-Z]{8,17}$`
    * `EndpointIpAddressType` enum `IPV4` | `IPV6`
    * `SecurityGroupIds` items `^sg-(([0-9a-z]{8})|([0-9a-z]{17}))$`
- **`PrivateEndpointOverrides`** — array (≤5) of `{ Domain (1–253), PrivateEndpoint }` (maps a specific domain to its
  own private endpoint; `PrivateEndpoint` is the same union, recursive).

### Verified facts that shape the design

- **Union is NOT `oneOf`.** Commit `a0772021` (this author) removed `oneOf` from `PrivateEndpoint` to fix a CFN
  contract-test "extraneous key" antipattern. Exactly-one-of is therefore enforced **structurally** (object shape), so
  the CLI Zod union uses a **`superRefine` "exactly one arm"** check, NOT `z.discriminatedUnion` / a fake discriminator.
- **No cross-field VPC dependency.** The spec has no root `dependencies`/`allOf`/`oneOf` and the Smithy model has no
  trait tying `PrivateEndpoint` to `Environment.NetworkConfiguration`. → **PrivateLink does NOT require the harness to
  be `networkMode: VPC`.** The `ManagedVpcResource` arm carries its own VPC fields; the `SelfManagedLatticeResource` arm
  needs no VPC at all.
- **`PrivateEndpoint` is updatable** — only `HarnessName` is createOnly. A redeploy can add/change it.
- **No IAM anywhere.** CFN `handlers.{create,read,update,delete,list}.permissions` contain **zero**
  `ec2`/`vpc`/`vpc-lattice` perms, and the harness execution role grants no network IAM (same as today's
  `networkMode:VPC` path). The service provisions the managed endpoint server-side.

## 3. Layered change set

The harness migration keeps **separate schema copies** in the CLI and the L3 repos (verified: both have their own
`schema/schemas/auth.ts` + `primitives/harness.ts`, near-identical). PrivateLink schema changes are made **in lockstep
in both repos.**

| Layer                | Repo(s)        | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| -------------------- | -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Zod schema**       | CLI **and** L3 | In `schema/schemas/auth.ts`: add `SelfManagedLatticeResourceSchema`, `ManagedVpcResourceSchema`, `PrivateEndpointSchema` (union via `superRefine` exactly-one-of), `PrivateEndpointOverrideSchema`; add `privateEndpoint?` + `privateEndpointOverrides?` (`.max(5)`) to `CustomJwtAuthorizerConfigSchema`. Reuse subnet/SG regexes from `agent-env.ts`. `primitives/harness.ts` needs **no change** (fields nest inside the already-optional `authorizerConfiguration`).                                                                                                                                                                                                                            |
| **CFN mapping**      | L3             | `harness-cfn-mapping.ts`: extend `mapAuthorizer()` to emit `PrivateEndpoint` + `PrivateEndpointOverrides`; add `mapPrivateEndpoint()` (union branch → `SelfManagedLatticeResource` \| `ManagedVpcResource`, PascalCase, conditional optionals) + `mapPrivateEndpointOverrides()` (reuses `mapPrivateEndpoint`). Update the file-header comment that lists PrivateLink as not-yet-emitted.                                                                                                                                                                                                                                                                                                           |
| **Construct + role** | —              | **No change.** `AgentCoreHarness` is a raw `CfnResource` passthrough; `AgentCoreHarnessRole` adds no network IAM. `PrivateEndpoint` flows through once the mapping emits it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| **CLI surface**      | CLI            | `auth-utils.ts`: extend `JwtConfigOptions` + `buildAuthorizerConfigFromJwtConfig()` to assemble `privateEndpoint` (union) + `privateEndpointOverrides`. `HarnessPrimitive.ts`: add flags (below). `commands/add/auth-options.ts`: extend `validateJwtAuthorizerOptions()` (id patterns, IPV4/IPV6, ≤5 SGs, ≤5 overrides, exactly-one-arm).                                                                                                                                                                                                                                                                                                                                                          |
| **CLI TUI**          | CLI            | Under the existing **`auth` advanced setting** (`ADVANCED_SETTING_OPTIONS`), extend the JWT sub-flow (`jwt-config/useJwtConfigFlow.ts`) with PrivateLink sub-steps gated by an **"Enable private endpoint" toggle** in the JWT constraint-picker (consistent with the Gateway/Payment `advanced-config` single-toggle-pane idiom — verified: they use one `useMultiSelectNavigation` pane whose `onConfirm` sets a config object). When enabled: endpoint-type picker → `SelfManagedLattice` (resource id) **or** `ManagedVpc` (vpc → subnets → ip-type → optional SGs/routing-domain/tags) → optional domain-overrides. No new top-level advanced option (PrivateLink is intrinsic to CUSTOM_JWT). |
| **Tests**            | CLI **and** L3 | Schema union accept/reject (exactly-one-of, managed-vpc required fields, ≤5 overrides, ≤5 SGs, IPV4/IPV6 enum); CLI flag/validation parsing; L3 synth assertions that `AuthorizerConfiguration.CustomJWTAuthorizer.PrivateEndpoint`/`PrivateEndpointOverrides` emit correctly (both arms + overrides + order preserved).                                                                                                                                                                                                                                                                                                                                                                            |

## 4. CLI flags (camelCase → emitted PascalCase)

Added to `add harness` (grouped after the existing CUSTOM_JWT flags). Self-managed and managed-vpc flags are mutually
exclusive (validated as exactly-one-arm when any private-endpoint flag is set):

- `--private-endpoint-lattice-arn <rcfg-id-or-arn>` — SelfManagedLatticeResource arm.
- `--private-endpoint-vpc-id <vpc-...>` — ManagedVpcResource arm.
- `--private-endpoint-subnets <ids>` — comma-separated `subnet-...` (required with vpc-id).
- `--private-endpoint-ip-type <IPV4|IPV6>` — required with vpc-id.
- `--private-endpoint-security-groups <ids>` — comma-separated `sg-...`, ≤5 (optional).
- `--private-endpoint-routing-domain <domain>` — optional.
- `--private-endpoint-tags <json>` — optional JSON object (≤50 keys).
- `--private-endpoint-overrides <json>` — single JSON array (≤5) of `{domain, privateEndpoint}`.

**JSON-flag convention (resolved):** the CLI has **no** variadic/repeatable-flag pattern anywhere; every
complex/list-of-objects input is a single flag parsed with `JSON.parse` — `--custom-claims`, `--components`
(ConfigBundle), `--stream-delivery-resources`, `--input` (invoke). PrivateLink follows that convention: scalar fields
get individual flags; `--private-endpoint-overrides` is a single JSON array. No repeatable
`--private-endpoint-override`.

## 5. Scope (approved)

- **Full surface:** both union arms + `PrivateEndpointOverrides`.
- **Full TUI** wizard sub-steps under the `auth` advanced toggle.
- **Stays behind the existing harness `__PREVIEW__` gate** (no new gate; inherits harness gating).

## 6. Out of scope / non-goals

- Removing the `__PREVIEW__` gate (separate PR).
- Pre-deploy live AWS validation of VPC/subnet AZ or Lattice-resource existence (server-side at deploy; client validates
  only id format — mirrors the existing `networkMode:VPC` UX gap noted in round 1).
- Any change to the harness execution role or the `AgentCoreHarness`/`AgentCoreHarnessRole` classes.
- Gateway PrivateLink (the Gateway resource shares the `CustomJWTAuthorizer` shape; out of scope here unless explicitly
  added — this task is harness-only per the teammate split).

## 7. Testing plan

- **Unit (CLI + L3 schema):** exactly-one-arm accept/reject; managed-vpc missing required → reject; `SecurityGroupIds`>5
  → reject; `PrivateEndpointOverrides`>5 → reject; bad id formats → reject; IPV4/IPV6 accept, other → reject;
  backward-compat (existing harness.json without PrivateLink parses).
- **Unit (L3 mapping):** synth template asserts `PrivateEndpoint.SelfManagedLatticeResource`,
  `PrivateEndpoint.ManagedVpcResource` (required + optional fields), `PrivateEndpointOverrides[]` (order + nested
  union), all PascalCase under `CustomJWTAuthorizer`.
- **Unit (CLI flags):** `auth-options` validation matrix; `buildAuthorizerConfigFromJwtConfig` assembles the correct
  union; mutually-exclusive arm enforcement.
- **E2E / bug bash:** deploy a CUSTOM_JWT harness with a `ManagedVpcResource` PrivateEndpoint (synth + deploy to
  603141041947/us-west-2) and with a `SelfManagedLatticeResource`; assert the CFN resource reaches READY and the
  template carries the PrivateEndpoint. (Live OIDC-over-private-network invoke needs real private infra —
  synth/deploy-level if that infra isn't provisioned, same BLOCKED_INFRA classification as round 1's JWT/EFS/S3 cases.)
