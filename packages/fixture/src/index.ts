// packages/fixture — the deterministic fixture generator, and only the generator.
//
// The single source of truth for what record a `(userId, variant, SEED_VALUE)` triple denotes. The
// bulk seeder (benchmark) and the fake third party (mock-billing) both build records here, so the
// bulk and lazy paths cannot disagree. See docs/ARCHITECTURE.md.

export { AVERAGE_VARIANTS, CATEGORY, PLAN_IDS, SERVICE, TENANT, type Subscription } from "./schema";
export { hashInt, mulberry32 } from "./prng";
export {
  expectedTotals,
  generateUsers,
  recordOrdinalFor,
  recordsFor,
  serializeSubscription,
  userCount,
  userIdFor,
  variantsFor,
  type ExpectedTotals,
  type UserFixture,
} from "./fixture";
