import { test } from "node:test";
import assert from "node:assert/strict";
import { groupPositions, pickQuestion, consistent, differingFields, combineCarts } from "../src/server/behavior.ts";

const probes = [{ items: [{ sku: "A", price: 1000, qty: 1 }] }, { items: [{ sku: "B", price: 5000, qty: 1 }], coupon: { percent: 10 } }];
const r = (tax: number, total: number) => ({ subtotal: 5000, discount: 500, shipping: 499, tax, total, giftCard: 0, due: total, points: 0 });

test("drafts with identical behavior collapse into one position", () => {
  const base = { subtotal: 1000, tax: 190, total: 1689 };
  const ps = groupPositions([
    { id: "d1", outcomes: [base, r(855, 4854)] },
    { id: "d2", outcomes: [base, r(855, 4854)] },
    { id: "d3", outcomes: [base, r(950, 4949)] },
  ]);
  assert.equal(ps.length, 2);
  assert.deepEqual(ps[0].draftIds, ["d1", "d2"]);
});

test("question picks the probe where positions disagree, restricted to differing fields", () => {
  const base = { subtotal: 1000, tax: 190, total: 1689 };
  const ps = groupPositions([
    { id: "d1", outcomes: [base, r(855, 4854)] },
    { id: "d2", outcomes: [base, r(855, 4854)] },
    { id: "d3", outcomes: [base, r(950, 4949)] },
  ]);
  const q = pickQuestion(ps, probes)!;
  assert.equal(q.probeIndex, 1);
  assert.deepEqual(q.fields, ["tax", "total", "due"]);
  assert.equal(q.options.length, 2);
  assert.deepEqual(q.options[0].outcome, { tax: 855, total: 4854, due: 4854 });
  assert.equal(q.settles, 1);
});

test("rejections are a behavior too", () => {
  const ps = groupPositions([
    { id: "d1", outcomes: [{ error: "too many" }] },
    { id: "d2", outcomes: [{ subtotal: 1, total: 1 }] },
  ]);
  const q = pickQuestion(ps, [probes[0]])!;
  assert.ok(q.options.some((o) => "error" in o.outcome));
});

test("consistency against a precedent", () => {
  assert.ok(consistent({ tax: 855, total: 4854, due: 4854 }, { tax: 855, total: 4854 }));
  assert.ok(!consistent({ tax: 950, total: 4949 }, { tax: 855 }));
  assert.ok(consistent({ error: "x" }, { error: "rejected" }));
  assert.ok(!consistent({ total: 1 }, { error: "rejected" }));
});

test("differing fields ignore errors; combined carts union items", () => {
  assert.deepEqual(differingFields([{ total: 1, tax: 2 }, { total: 1, tax: 3 }, { error: "e" }]), ["tax"]);
  const c = combineCarts({ items: [{ sku: "A" }], coupon: { percent: 10 } }, { items: [{ sku: "B" }], customer: { tier: "member" } });
  assert.deepEqual(c.items, [{ sku: "A" }, { sku: "B" }]);
  assert.deepEqual(c.customer, { tier: "member" });
});
