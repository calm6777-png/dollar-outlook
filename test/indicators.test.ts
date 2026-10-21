import { test } from "node:test";
import assert from "node:assert/strict";
import { atr, correlation, pivots, ridge, rsi, sma } from "../src/lib/indicators.ts";

test("sma: 앞쪽은 NaN, 이후는 이동평균", () => {
  const v = sma([1, 2, 3, 4, 5], 3);
  assert.ok(Number.isNaN(v[1]));
  assert.deepEqual(v.slice(2), [2, 3, 4]);
});

test("rsi: 계속 오르면 100, 계속 내리면 0", () => {
  const up = Array.from({ length: 30 }, (_, i) => 100 + i);
  const down = Array.from({ length: 30 }, (_, i) => 100 - i);
  assert.equal(rsi(up).at(-1), 100);
  assert.equal(rsi(down).at(-1), 0);
});

test("pivots: 고전 피벗 공식", () => {
  const p = pivots({ h: 1330, l: 1320, c: 1326 });
  assert.equal(p.p, 1325.3333333333333);
  assert.equal(p.r1, 2 * p.p - 1320);
  assert.equal(p.s1, 2 * p.p - 1330);
  assert.equal(p.r2, p.p + 10);
  assert.equal(p.s2, p.p - 10);
});

test("atr: 폭이 일정하면 그 폭", () => {
  const bars = Array.from({ length: 30 }, () => ({ h: 11, l: 9, c: 10 }));
  assert.equal(atr(bars, 14).at(-1), 2);
});

test("correlation: 같은 방향 1, 반대 방향 -1", () => {
  const a = [1, 3, 2, 5, 4, 6, 8, 7, 9, 10];
  assert.ok(Math.abs(correlation(a, a) - 1) < 1e-12);
  assert.ok(Math.abs(correlation(a, a.map((x) => -2 * x)) + 1) < 1e-12);
});

test("ridge: 잡음이 없으면 알려진 계수를 거의 그대로 찾음", () => {
  const X: number[][] = [];
  const y: number[] = [];
  for (let i = 0; i < 200; i++) {
    const a = Math.sin(i * 0.7);
    const b = Math.cos(i * 1.3);
    X.push([a, b]);
    y.push(0.5 * a - 2 * b);
  }
  const { beta, r2 } = ridge(X, y, 1e-6);
  assert.ok(Math.abs(beta[0] - 0.5) < 1e-3);
  assert.ok(Math.abs(beta[1] + 2) < 1e-3);
  assert.ok(r2 > 0.999);
});
