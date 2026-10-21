import { test } from "node:test";
import assert from "node:assert/strict";
import { asOf, buildSeries, kstDate, kstMinutes, kstTime, sessionCandles, type RawChart } from "../src/lib/market.ts";
import { ALL_SYMBOLS, buildOutlook, type MarketData } from "../src/lib/outlook.ts";

// 2026-10-19(월) 00:00 KST의 일 번호
const MON = Math.floor((Date.UTC(2026, 9, 19) / 1000 + 9 * 3600) / 86400);

function raw(points: [number, number][], price?: number, time?: number): RawChart {
  return {
    meta: { regularMarketPrice: price ?? points.at(-1)![1], regularMarketTime: time ?? points.at(-1)![0] },
    timestamp: points.map((p) => p[0]),
    indicators: {
      quote: [{ open: points.map((p) => p[1]), high: points.map((p) => p[1] + 1), low: points.map((p) => p[1] - 1), close: points.map((p) => p[1]) }],
    },
  };
}

test("KST 변환: 06:30 UTC는 15:30 KST", () => {
  const t = Date.UTC(2026, 9, 20, 6, 30) / 1000;
  assert.equal(kstMinutes(t), 15 * 60 + 30);
  assert.equal(kstDate(t), "2026-10-20");
  assert.equal(kstTime(MON + 1, 16 * 60), Date.UTC(2026, 9, 20, 7, 0) / 1000);
});

test("asOf: 그 시각에 이미 끝난 봉의 종가만 쓴다", () => {
  const h = kstTime(MON, 15 * 60); // 15:00 KST 시작 1시간봉 → 16:00에 확정
  const s = buildSeries(raw([[h - 3600, 100], [h, 101], [h + 3600, 102]], 102, h + 7200), null)!;
  assert.equal(asOf(s, kstTime(MON, 16 * 60) - 1), 100); // 15:59:59에는 15시 봉이 아직 안 끝남
  assert.equal(asOf(s, kstTime(MON, 16 * 60)), 101);
  assert.ok(Number.isNaN(asOf(s, h - 3600)));
});

test("sessionCandles: 평일 09~16시 봉만 모으고 주말은 뺀다", () => {
  const pts: [number, number][] = [];
  for (let d = 0; d < 7; d++) {
    for (let hr = 0; hr < 24; hr++) pts.push([kstTime(MON + d, hr * 60), 1300 + d * 10 + hr]);
  }
  const s = buildSeries(raw(pts), null)!;
  const candles = sessionCandles(s, kstTime(MON + 7, 0));
  assert.deepEqual(candles.map((c) => c.d), ["2026-10-19", "2026-10-20", "2026-10-21", "2026-10-22", "2026-10-23"]);
  const mon = candles[0];
  assert.equal(mon.o, 1309); // 09시 봉 시가
  assert.equal(mon.c, 1315); // 15시 봉 종가(16시 확정)
  assert.ok(candles.every((c) => c.complete));
});

test("buildOutlook: 합성 시세로 끝까지 계산되고 점수는 -100~100", () => {
  const data: MarketData = {};
  let seed = 7;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) - 0.5;
  const start = kstTime(MON - 300, 0);
  const now = kstTime(MON + 2, 11 * 60);
  ALL_SYMBOLS.forEach((sym, k) => {
    let v = 100 + k * 50;
    const pts: [number, number][] = [];
    for (let t = start; t <= now; t += 3600) {
      v *= 1 + rand() * 0.004;
      pts.push([t, v]);
    }
    data[sym] = { hist: raw(pts), live: null };
  });
  const o = buildOutlook(data, now * 1000);
  assert.ok(o.score.value >= -100 && o.score.value <= 100);
  assert.ok(o.score.factors.length >= 6);
  assert.ok(Number.isFinite(o.range.atr) && o.range.low < o.range.high);
  assert.ok(o.krw.session && !o.krw.session.complete, "월요일+2일 11시는 진행 중인 세션");
  assert.equal(o.krw.ref?.label, "10/20 16시");
  assert.ok(o.summary.length >= 3);
  assert.deepEqual(o.missing, []);
});
