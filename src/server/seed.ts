// The repository every session's trunk starts from: a small checkout engine,
// the contract agents must follow, and a plain-Node precedent runner so the
// repo works with any Git client, with or without Precedent.
import type { FeatureSpec } from "../shared/types.ts";

const CHECKOUT = `// Checkout engine. All money is integer cents.
// quote(cart) -> receipt (see AGENTS.md for the contract).
import { TAX_RATES, SHIPPING_STANDARD } from "./config.js";

export function quote(cart) {
  if (!cart || !Array.isArray(cart.items)) throw new Error("cart.items must be an array");
  for (const item of cart.items) {
    if (!Number.isInteger(item.price) || item.price < 0) throw new Error(\`invalid price for \${item.sku}\`);
    if (!Number.isInteger(item.qty) || item.qty < 1) throw new Error(\`invalid qty for \${item.sku}\`);
  }

  const subtotal = cart.items.reduce((sum, item) => sum + item.price * item.qty, 0);
  const discount = 0;
  const shipping = cart.items.length === 0 ? 0 : SHIPPING_STANDARD;
  const rate = TAX_RATES[cart.country ?? "DE"] ?? TAX_RATES.default;
  const tax = Math.round((subtotal - discount) * rate);
  const total = subtotal - discount + shipping + tax;

  return { subtotal, discount, shipping, tax, total, giftCard: 0, due: total, points: 0, applied: [] };
}
`;

const CONFIG = `// Tax is charged on goods (after discounts), not on shipping.
export const TAX_RATES = { DE: 0.19, FR: 0.2, NL: 0.21, HU: 0.27, default: 0.2 };

// Standard shipping, in cents.
export const SHIPPING_STANDARD = 499;
`;

const AGENTS_MD = `# Instructions for agents

This repository is a checkout engine. \`src/checkout.js\` exports \`quote(cart)\`.

## Cart (input)
\`\`\`js
{
  items: [{ sku: "MUG-1", name: "Mug", price: 1200, qty: 2, category: "mugs" }], // price in cents
  country: "DE",            // tax country, see src/config.js
  // features add more optional fields, e.g. coupon, customer, giftCard
}
\`\`\`

## Receipt (output)
Every field is an integer number of cents (points are whole points):
- \`subtotal\`  sum of price × qty before any discount
- \`discount\`  total of all discounts (a positive number)
- \`shipping\`  shipping charged
- \`tax\`       tax charged
- \`total\`     subtotal - discount + shipping + tax
- \`giftCard\`  amount paid by gift card
- \`due\`       amount the customer still pays (total - giftCard)
- \`points\`    loyalty points earned
- \`applied\`   human-readable labels of rules applied (free text)

Invalid carts must \`throw new Error(reason)\`.

## Rules
- Plain JavaScript ES modules, no dependencies, no network.
- Keep \`quote(cart)\` deterministic.
- \`precedents/\` holds binding decisions made by humans. Never change them; \`npm test\` must pass.
- When a ticket is ambiguous, make a reasonable choice and state it in one sentence.
`;

const README = `# Checkout engine (managed by Precedent)

This repository is maintained by a swarm of agents under [Precedent](https://github.com/).
Humans don't review diffs here. They decide behavior:

- \`CASEBOOK.md\` lists every decision a human made, in plain language.
- \`precedents/*.json\` are those decisions as binding examples (cart → expected receipt fields).
- \`git log --notes=precedent\` shows the agents' stated assumptions for each landing.

\`\`\`sh
npm test   # checks every precedent with plain Node, no install needed
\`\`\`
`;

const CASEBOOK = `# Casebook

Binding decisions about how this checkout behaves. Each one was made by a human
(or settled automatically when the ticket already answered it) and is enforced
by \`npm test\` through the matching file in \`precedents/\`.
`;

const PACKAGE_JSON = `{
  "name": "checkout-engine",
  "private": true,
  "type": "module",
  "scripts": { "test": "node test/precedents.mjs" }
}
`;

const RUNNER = `// Checks every precedent against src/checkout.js. Plain Node, no dependencies.
import { readdir, readFile } from "node:fs/promises";
import { quote } from "../src/checkout.js";

const dir = new URL("../precedents/", import.meta.url);
const files = (await readdir(dir).catch(() => [])).filter((f) => f.endsWith(".json")).sort();
let failed = 0;
let active = 0;
for (const file of files) {
  const p = JSON.parse(await readFile(new URL(file, dir), "utf8"));
  if (p.overruled) continue;
  active++;
  let actual;
  try {
    actual = quote(structuredClone(p.cart));
  } catch (e) {
    actual = { error: String(e?.message ?? e) };
  }
  const problems = [];
  if ("error" in p.expect) {
    if (!("error" in actual)) problems.push("expected the cart to be rejected");
  } else {
    for (const [field, value] of Object.entries(p.expect)) {
      if (actual[field] !== value) problems.push(\`\${field}: expected \${value}, got \${actual[field]}\`);
    }
  }
  if (problems.length) failed++;
  console.log(\`\${problems.length ? "✗" : "✓"} #\${p.n} \${p.title}\${problems.map((x) => "\\n    " + x).join("")}\`);
}
console.log(\`\\n\${active - failed}/\${active} precedents hold\`);
process.exit(failed ? 1 : 0);
`;

const PRECEDENTS_README = `# Precedents

One JSON file per decision: \`{ n, title, feature, cart, expect, rationale, decidedBy, decidedAt }\`.
\`expect\` lists only the receipt fields the decision is about, or \`{ "error": "rejected" }\`.
`;

export const SEED_FILES: Record<string, string> = {
	"README.md": README,
	"AGENTS.md": AGENTS_MD,
	"CASEBOOK.md": CASEBOOK,
	"package.json": PACKAGE_JSON,
	"src/checkout.js": CHECKOUT,
	"src/config.js": CONFIG,
	"test/precedents.mjs": RUNNER,
	"precedents/README.md": PRECEDENTS_README,
};

// Tickets are deliberately terse, like real ones. The gaps are where agents
// have to make product decisions, and those decisions are what humans rule on.
export const FEATURES: FeatureSpec[] = [
	{
		id: "percent-coupon",
		title: "Percentage coupons",
		spec: "Support cart.coupon = { code, percent }. It takes that percentage off the order. Report it in discount.",
	},
	{
		id: "bogo-mugs",
		title: "Buy one, get one free on mugs",
		spec: 'Items with category "mugs" are buy one, get one free. Report the saving in discount.',
	},
	{
		id: "free-shipping",
		title: "Free shipping over €50",
		spec: "Standard shipping is free for orders of €50 or more.",
	},
	{
		id: "member-discount",
		title: "Member discount",
		spec: 'Customers with cart.customer = { tier: "member" } get 10% off. Report it in discount.',
	},
	{
		id: "gift-card",
		title: "Gift cards",
		spec: "cart.giftCard = { balance } (cents) pays toward the order. Report the amount used in giftCard and what the customer still pays in due.",
	},
	{
		id: "loyalty-points",
		title: "Loyalty points",
		spec: "Customers earn 1 loyalty point per whole euro spent. Report it in points.",
	},
	{
		id: "bulk-discount",
		title: "Bulk discount",
		spec: "Buying 10 or more units of the same SKU gives 15% off that line. Report it in discount.",
	},
	{
		id: "express-shipping",
		title: "Express shipping",
		spec: 'cart.shipping = "express" costs €12.99 instead of standard shipping.',
	},
	{
		id: "purchase-limit",
		title: "Purchase limits",
		spec: "Items with limited: true can be bought at most 2 per order.",
	},
	{
		id: "fixed-coupon",
		title: "Fixed-amount coupons",
		spec: "Support cart.coupon = { code, amount } (cents). It takes that amount off the order. Report it in discount.",
	},
];

/** Ordinary carts every draft is checked on, to catch unintended changes to existing behavior. */
export const BASE_PROBES = [
	{ items: [{ sku: "MUG-1", name: "Mug", price: 1200, qty: 1, category: "mugs" }], country: "DE" },
	{ items: [{ sku: "TEE-1", name: "T-shirt", price: 2500, qty: 2, category: "apparel" }], country: "FR" },
	{ items: [{ sku: "BAG-1", name: "Tote bag", price: 1800, qty: 1, category: "bags" }, { sku: "MUG-2", name: "Espresso cup", price: 900, qty: 3, category: "mugs" }], country: "HU" },
	{ items: [], country: "DE" },
	{ items: [{ sku: "PEN-1", name: "Pen", price: 199, qty: 7, category: "office" }], country: "NL" },
];
