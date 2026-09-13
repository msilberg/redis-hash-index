// packages/fixture — the deterministic fixture and the fake origin that serves it.
//
// `benchmark` seeds from the generator; `benchmark` and `test-api` both fill through the same
// `@Cache`-decorated `SubscriptionService` over the same mock `BillingProvider`, so a record filled by
// either service is byte-identical to the bulk fixture. See docs/ARCHITECTURE.md.

export { AVERAGE_VARIANTS, CATEGORY, PLAN_IDS, SERVICE, TENANT } from "./schema";
export { hashInt, mulberry32 } from "./prng";
export {
  expectedTotals,
  generateUsers,
  recordOrdinalFor,
  recordsFor,
  userCount,
  userIdFor,
  variantsFor,
  type ExpectedTotals,
  type UserFixture,
} from "./fixture";
export {
  BillingProvider,
  OriginError,
  type BillingProviderConfig,
  type Subscription,
  type SubscriptionParams,
} from "./billing-provider";
export { SubscriptionService, type SubscriptionOrigin } from "./subscription-service";
