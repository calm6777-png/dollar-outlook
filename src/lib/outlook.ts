// 달러/원 전망 계산: 16:00 KST 기준으로 맞춘 시계열에서 지표·요인 점수·예상 범위·요약 문장을 만듭니다.
import * as ind from "./indicators.ts";
import { asOf, buildSeries, hourlyBars, sessionCandles, type Bar, type Candle, type RawChart, type Series } from "./market.ts";

export type Kind = "pct" | "bp" | "lvl";

export interface Instrument {
  key: string;
  sym: string;
  name: string;
  kind: Kind; // pct: % 변화, bp: 금리 bp 변화, lvl: 포인트 변화
  dp: number;
  model?: boolean; // 마감 이후 예상 변동 회귀식에 넣는 종목
  overnight?: boolean; // 마감 이후 변화 표에 보일 종목
}

export const KRW: Instrument = { key: "krw", sym: "KRW=X", name: "달러/원", kind: "pct", dp: 2 };

export const DRIVERS: Instrument[] = [
  { key: "dxy", sym: "DX-Y.NYB", name: "달러인덱스", kind: "pct", dp: 2, model: true, overnight: true },
  { key: "cny", sym: "CNY=X", name: "달러/위안", kind: "pct", dp: 4, model: true, overnight: true },
  { key: "jpy", sym: "JPY=X", name: "달러/엔", kind: "pct", dp: 2, overnight: true },
  { key: "twd", sym: "TWD=X", name: "달러/대만달러", kind: "pct", dp: 3 },
  { key: "tnx", sym: "^TNX", name: "미 국채 10년", kind: "bp", dp: 3, model: true, overnight: true },
  { key: "kospi", sym: "^KS11", name: "코스피", kind: "pct", dp: 2 },
  { key: "nq", sym: "NQ=F", name: "나스닥100 선물", kind: "pct", dp: 2, model: true, overnight: true },
  { key: "vix", sym: "^VIX", name: "VIX 변동성", kind: "lvl", dp: 2 },
  { key: "wti", sym: "CL=F", name: "WTI 유가", kind: "pct", dp: 2 },
  { key: "gold", sym: "GC=F", name: "금", kind: "pct", dp: 1 },
];

export const ALL_SYMBOLS = [KRW.sym, ...DRIVERS.map((d) => d.sym)];

const WEIGHTS = { trend: 0.2, momentum: 0.15, overheat: 0.1, dollar: 0.2, risk: 0.15, rates: 0.05, overnight: 0.15 };
export const SIGNAL = 20; // |점수| 20 이상을 방향 신호로 봅니다.

export interface Factor {
  key: string;
  name: string;
  weight: number;
  score: number; // -1 ~ 1, +는 달러/원 상승 쪽
  contribution: number; // 종합 점수에 보탠 점수
  detail: string;
}

export function change(kind: Kind, from: number, to: number): number {
  if (kind === "pct") return (to / from - 1) * 100;
  if (kind === "bp") return (to - from) * 100;
  return to - from;
}

const clamp = (x: number, lo = -1, hi = 1) => Math.max(lo, Math.min(hi, x));
const finite = (x: number) => Number.isFinite(x);

export function fmt(n: number, dp = 1): string {
  if (!finite(n)) return "–";
  const [int, frac] = Math.abs(n).toFixed(dp).split(".");
  const s = int.replace(/\B(?=(\d{3})+(?!\d))/g, ",") + (frac ? `.${frac}` : "");
  return n < 0 && Number(Math.abs(n).toFixed(dp)) !== 0 ? `-${s}` : s;
}

export function signed(n: number, dp = 1): string {
  if (!finite(n)) return "–";
  const s = fmt(Math.abs(n), dp);
  if (Number(Math.abs(n).toFixed(dp)) === 0) return s;
  return n > 0 ? `+${s}` : `-${s}`;
}

// ---------- 일봉 격자 ----------

interface Grid {
  candles: Candle[];
  c: number[];
  ma5: number[];
  ma20: number[];
  ma60: number[];
  ma120: number[];
  hist: number[];
  rsi: number[];
  pctB: number[];
  bbU: number[];
  bbL: number[];
  atr: number[];
  drv: Record<string, number[]>;
}

function buildGrid(candles: Candle[], drivers: Record<string, Series | null>, now: number): Grid {
  const c = candles.map((b) => b.c);
  const bb = ind.bollinger(c, 20, 2);
  const drv: Record<string, number[]> = {};
  for (const d of DRIVERS) drv[d.key] = candles.map((k) => asOf(drivers[d.key], Math.min(k.snap, now)));
  return {
    candles,
    c,
    ma5: ind.sma(c, 5),
    ma20: ind.sma(c, 20),
    ma60: ind.sma(c, 60),
    ma120: ind.sma(c, 120),
    hist: ind.macd(c).hist,
    rsi: ind.rsi(c, 14),
    pctB: c.map((x, i) => (x - bb.lower[i]) / (bb.upper[i] - bb.lower[i])),
    bbU: bb.upper,
    bbL: bb.lower,
    atr: ind.atr(candles, 14),
    drv,
  };
}

// 5거래일 변화와, 그 변화가 평소(최근 120일) 대비 몇 표준편차인지
function move5(g: Grid, key: string, i: number): { chg: number; z: number } {
  const def = DRIVERS.find((d) => d.key === key)!;
  const v = g.drv[key];
  if (i < 5 || !finite(v[i]) || !finite(v[i - 5])) return { chg: NaN, z: NaN };
  const chg = change(def.kind, v[i - 5], v[i]);
  const past: number[] = [];
  for (let j = Math.max(5, i - 120); j < i; j++) {
    if (finite(v[j]) && finite(v[j - 5])) past.push(change(def.kind, v[j - 5], v[j]));
  }
  const sd = ind.stdev(past);
  return { chg, z: past.length >= 30 && sd > 0 ? chg / sd : NaN };
}

// ---------- 요인 점수 ----------

type Core = Omit<Factor, "contribution" | "weight">;

function dailyFactors(g: Grid, i: number, atrRef: number): Core[] {
  const out: Core[] = [];
  const c = g.c[i];

  const m5 = g.ma5[i];
  const m20 = g.ma20[i];
  const m60 = g.ma60[i];
  const m20prev = g.ma20[i - 5];
  if ([m5, m20, m60, m20prev].every(finite)) {
    const parts = [Math.sign(c - m20), Math.sign(m5 - m20), Math.sign(m20 - m60), Math.sign(m20 - m20prev)];
    out.push({
      key: "trend",
      name: "추세",
      score: ind.mean(parts),
      detail: `현재가 20일선 ${c >= m20 ? "위" : "아래"} · 20일선 ${m20 >= m20prev ? "상승" : "하락"} 중 · 20/60일선 ${m20 >= m60 ? "정배열" : "역배열"}`,
    });
  }

  const h = g.hist[i];
  const hPrev = g.hist[i - 1];
  if (finite(h) && finite(atrRef) && atrRef > 0) {
    out.push({
      key: "momentum",
      name: "모멘텀",
      score: Math.tanh(h / (0.25 * atrRef)),
      detail: `MACD 히스토그램 ${signed(h, 2)}${finite(hPrev) ? ` (전일보다 ${h >= hPrev ? "커짐" : "작아짐"})` : ""}`,
    });
  }

  const r = g.rsi[i];
  const b = g.pctB[i];
  if (finite(r) && finite(b)) {
    const rsiPart = r > 70 ? -clamp((r - 70) / 15, 0, 1) : r < 30 ? clamp((30 - r) / 15, 0, 1) : 0;
    const bbPart = b > 1 ? -1 : b < 0 ? 1 : b > 0.9 ? -0.5 : b < 0.1 ? 0.5 : 0;
    const state = r >= 70 ? "과매수" : r <= 30 ? "과매도" : "중립";
    out.push({
      key: "overheat",
      name: "과열·침체(역추세)",
      score: clamp(0.6 * rsiPart + 0.4 * bbPart),
      detail: `RSI ${r.toFixed(0)}(${state}) · 볼린저 %B ${b.toFixed(2)}`,
    });
  }

  const dxy = move5(g, "dxy", i);
  const cny = move5(g, "cny", i);
  const dollarZ = [dxy.z, cny.z].filter(finite);
  if (dollarZ.length) {
    out.push({
      key: "dollar",
      name: "글로벌 달러",
      score: Math.tanh(ind.mean(dollarZ)),
      detail: `5일간 달러인덱스 ${signed(dxy.chg, 2)}% · 달러/위안 ${signed(cny.chg, 2)}%`,
    });
  }

  const nq = move5(g, "nq", i);
  const kospi = move5(g, "kospi", i);
  const vix = move5(g, "vix", i);
  const riskZ = [-nq.z, -kospi.z, vix.z].filter(finite);
  if (riskZ.length) {
    out.push({
      key: "risk",
      name: "위험 회피",
      score: Math.tanh(ind.mean(riskZ)),
      detail: `5일간 나스닥 ${signed(nq.chg, 1)}% · 코스피 ${signed(kospi.chg, 1)}% · VIX ${signed(vix.chg, 1)}p`,
    });
  }

  const tnx = move5(g, "tnx", i);
  if (finite(tnx.z)) {
    out.push({
      key: "rates",
      name: "미 금리",
      score: Math.tanh(tnx.z),
      detail: `5일간 미 10년물 ${signed(tnx.chg, 0)}bp`,
    });
  }
  return out;
}

function combine(cores: Core[]): { value: number; factors: Factor[] } {
  const total = cores.reduce((s, f) => s + WEIGHTS[f.key as keyof typeof WEIGHTS], 0);
  const factors = cores.map((f) => {
    const weight = WEIGHTS[f.key as keyof typeof WEIGHTS] / total;
    return { ...f, weight, contribution: 100 * weight * f.score };
  });
  return { value: factors.reduce((s, f) => s + f.contribution, 0), factors };
}

export function scoreLabel(v: number): { label: string; tone: "up" | "down" | "flat" } {
  if (v >= 50) return { label: "강한 상승 우위", tone: "up" };
  if (v >= SIGNAL) return { label: "상승 우위", tone: "up" };
  if (v <= -50) return { label: "강한 하락 우위", tone: "down" };
  if (v <= -SIGNAL) return { label: "하락 우위", tone: "down" };
  return { label: "중립 · 방향성 약함", tone: "flat" };
}

// 같은 점수 규칙(마감 이후 요인 제외)을 과거에 적용해 다음 세션(16시→16시) 방향을 얼마나 맞혔는지 셉니다.
function backtest(g: Grid, lastComplete: number) {
  let signals = 0;
  let hits = 0;
  let days = 0;
  let upDays = 0;
  for (let i = 125; i < lastComplete; i++) {
    const next = g.c[i + 1] - g.c[i];
    if (next === 0) continue;
    days++;
    if (next > 0) upDays++;
    const { value } = combine(dailyFactors(g, i, g.atr[i]));
    if (Math.abs(value) < SIGNAL) continue;
    signals++;
    if (Math.sign(value) === Math.sign(next)) hits++;
  }
  return { signals, hitRate: signals ? hits / signals : NaN, days, baseUpRate: days ? upDays / days : NaN };
}

// ---------- 전체 조립 ----------

export interface Outlook {
  now: number;
  krw: {
    price: number;
    time: number;
    ref: { time: number; label: string; price: number; diff: number; pct: number } | null;
    session: Candle | null; // 진행 중인 오늘 세션
  };
  score: {
    value: number;
    label: string;
    tone: "up" | "down" | "flat";
    factors: Factor[];
    backtest: ReturnType<typeof backtest>;
  };
  range: {
    atr: number;
    base: number;
    baseLabel: string;
    low: number;
    high: number;
    pivots: ReturnType<typeof ind.pivots>;
    pivotFrom: string;
    levels: { name: string; value: number; kind: "pivot" | "ma" | "hl" | "band" }[];
  };
  tech: { rsi: number; macdHist: number; pctB: number; atr: number; ma20: number; ma60: number; ma120: number };
  overnight: {
    label: string;
    actual: number;
    implied: number;
    r2: number;
    rows: { key: string; name: string; from: number; to: number; chg: number; kind: Kind; dp: number; won: number | null }[];
  } | null;
  markets: {
    key: string;
    name: string;
    kind: Kind;
    dp: number;
    price: number;
    chg1d: number;
    chg5d: number;
    corr60: number;
    spark: { d: string; c: number }[];
  }[];
  charts: {
    daily: Candle[];
    hourly: Bar[];
    min15: Bar[];
  };
  summary: string[];
  missing: string[];
}

export type MarketData = Record<string, { hist: RawChart | null; live: RawChart | null }>;

export function buildOutlook(data: MarketData, nowMs = Date.now()): Outlook {
  const now = Math.floor(nowMs / 1000);
  const krw = buildSeries(data[KRW.sym]?.hist, data[KRW.sym]?.live);
  if (!krw) throw new Error("달러/원 시세를 받지 못했습니다.");
  const drivers: Record<string, Series | null> = {};
  const missing: string[] = [];
  for (const d of DRIVERS) {
    drivers[d.key] = buildSeries(data[d.sym]?.hist, data[d.sym]?.live);
    if (!drivers[d.key]) missing.push(d.name);
  }

  const candles = sessionCandles(krw, now);
  if (candles.length < 30) throw new Error("달러/원 과거 시세가 부족합니다.");
  const g = buildGrid(candles, drivers, now);
  const n = candles.length;
  const L = n - 1;
  const lastComplete = candles[L].complete ? L : L - 1;
  const atrNow = g.atr[lastComplete];
  const price = krw.price;
  const session = candles[L].complete ? null : candles[L];

  // 직전 16:00 기준가
  const refCandle = candles[lastComplete];
  const [, rm, rd] = refCandle.d.split("-").map(Number);
  const ref = {
    time: refCandle.snap,
    label: `${rm}/${rd} 16시`,
    price: refCandle.c,
    diff: price - refCandle.c,
    pct: (price / refCandle.c - 1) * 100,
  };

  // 요인 점수
  const cores = dailyFactors(g, L, atrNow);
  if (finite(atrNow) && atrNow > 0 && now > ref.time) {
    cores.push({
      key: "overnight",
      name: "직전 16시 이후 변동",
      score: Math.tanh(ref.diff / (0.35 * atrNow)),
      detail: `${ref.label} ${fmt(ref.price, 1)}원 대비 ${signed(ref.diff, 1)}원`,
    });
  }
  const { value, factors } = combine(cores);

  // 직전 16시 이후 드라이버 변화 → 회귀식으로 본 예상 변동
  const model = DRIVERS.filter((d) => d.model);
  const X: number[][] = [];
  const y: number[] = [];
  for (let i = Math.max(1, lastComplete - 120); i <= lastComplete; i++) {
    const row = model.map((d) => change(d.kind, g.drv[d.key][i - 1], g.drv[d.key][i]));
    const yi = change("pct", g.c[i - 1], g.c[i]);
    if (row.every(finite) && finite(yi)) {
      X.push(row);
      y.push(yi);
    }
  }
  const fit = ind.ridge(X, y, 0.05);
  let impliedPct = 0;
  const rows: NonNullable<Outlook["overnight"]>["rows"] = [];
  for (const d of DRIVERS.filter((x) => x.overnight)) {
    const s = drivers[d.key];
    const from = asOf(s, ref.time);
    if (!s || !finite(from)) continue;
    const chg = change(d.kind, from, s.price);
    const mi = model.indexOf(d);
    let won: number | null = null;
    if (mi >= 0) {
      const pct = fit.beta[mi] * chg;
      impliedPct += pct;
      won = (pct / 100) * ref.price;
    }
    rows.push({ key: d.key, name: d.name, from, to: s.price, chg, kind: d.kind, dp: d.dp, won });
  }
  const overnight = { label: ref.label, actual: ref.diff, implied: (impliedPct / 100) * ref.price, r2: fit.r2, rows };

  // 예상 범위와 주요 가격대
  const base = session ? session.o : price;
  let low = base - atrNow / 2;
  let high = base + atrNow / 2;
  if (session) {
    low = Math.min(low, session.l);
    high = Math.max(high, session.h);
  }
  const pv = ind.pivots(refCandle);
  // 고저는 오늘 진행 중인 세션까지 포함합니다(이미 거래된 가격이므로).
  const recent = (len: number) => candles.slice(Math.max(0, L - len + 1), L + 1);
  const levels = [
    { name: "2차 저항(R2)", value: pv.r2, kind: "pivot" as const },
    { name: "1차 저항(R1)", value: pv.r1, kind: "pivot" as const },
    { name: "피벗(P)", value: pv.p, kind: "pivot" as const },
    { name: "1차 지지(S1)", value: pv.s1, kind: "pivot" as const },
    { name: "2차 지지(S2)", value: pv.s2, kind: "pivot" as const },
    { name: "20일 고점", value: Math.max(...recent(20).map((b) => b.h)), kind: "hl" as const },
    { name: "20일 저점", value: Math.min(...recent(20).map((b) => b.l)), kind: "hl" as const },
    { name: "60일 고점", value: Math.max(...recent(60).map((b) => b.h)), kind: "hl" as const },
    { name: "60일 저점", value: Math.min(...recent(60).map((b) => b.l)), kind: "hl" as const },
    { name: "20일선", value: g.ma20[L], kind: "ma" as const },
    { name: "60일선", value: g.ma60[L], kind: "ma" as const },
    { name: "120일선", value: g.ma120[L], kind: "ma" as const },
    { name: "볼린저 상단", value: g.bbU[L], kind: "band" as const },
    { name: "볼린저 하단", value: g.bbL[L], kind: "band" as const },
  ]
    .filter((x) => finite(x.value))
    .sort((a, b) => b.value - a.value);

  // 주변 시장
  const corr = (key: string, kind: Kind, len: number) => {
    const a: number[] = [];
    const b: number[] = [];
    for (let i = Math.max(1, lastComplete - len + 1); i <= lastComplete; i++) {
      const x = change(kind, g.drv[key][i - 1], g.drv[key][i]);
      const yv = change("pct", g.c[i - 1], g.c[i]);
      if (finite(x) && finite(yv)) {
        a.push(x);
        b.push(yv);
      }
    }
    return ind.correlation(a, b);
  };
  const markets: Outlook["markets"] = [];
  for (const d of DRIVERS) {
    const s = drivers[d.key];
    if (!s) continue;
    const v = g.drv[d.key];
    markets.push({
      key: d.key,
      name: d.name,
      kind: d.kind,
      dp: d.dp,
      price: s.price,
      chg1d: change(d.kind, v[lastComplete], s.price),
      chg5d: change(d.kind, v[L - 5], s.price),
      corr60: corr(d.key, d.kind, 60),
      spark: candles
        .slice(-30)
        .map((k, j) => ({ d: k.d, c: v[n - 30 + j] }))
        .filter((p) => finite(p.c)),
    });
  }

  const out: Outlook = {
    now: nowMs,
    krw: { price, time: krw.time, ref, session },
    score: { value, ...scoreLabel(value), factors, backtest: backtest(g, lastComplete) },
    range: {
      atr: atrNow,
      base,
      baseLabel: session ? "오늘 09시 시가" : "현재가",
      low,
      high,
      pivots: pv,
      pivotFrom: refCandle.d,
      levels,
    },
    tech: { rsi: g.rsi[L], macdHist: g.hist[L], pctB: g.pctB[L], atr: atrNow, ma20: g.ma20[L], ma60: g.ma60[L], ma120: g.ma120[L] },
    overnight: now > ref.time ? overnight : null,
    markets,
    charts: { daily: candles, hourly: hourlyBars(krw), min15: krw.bars15 },
    summary: [],
    missing,
  };
  out.summary = summarize(out);
  return out;
}

// ---------- 요약 문장 ----------

function summarize(o: Outlook): string[] {
  const lines: string[] = [];
  const { krw, score, range, overnight, tech } = o;
  const dir = (x: number) => (x > 0 ? "올라" : x < 0 ? "내려" : "그대로인");
  const ref = krw.ref!;

  let s = `달러/원은 ${ref.label}(${fmt(ref.price, 1)}원)보다 ${fmt(Math.abs(ref.diff), 1)}원 ${dir(ref.diff)} ${fmt(krw.price, 1)}원입니다.`;
  if (overnight && Math.abs(overnight.actual - overnight.implied) >= Math.max(1.5, range.atr * 0.15)) {
    const gap = overnight.actual - overnight.implied;
    s += ` 같은 시간 달러·위안·나스닥·미 금리 움직임으로 본 예상 변동(${signed(overnight.implied, 1)}원)보다 ${fmt(Math.abs(gap), 1)}원 ${gap > 0 ? "높아" : "낮아"}, 원화가 상대적으로 ${gap > 0 ? "약합니다" : "강합니다"}.`;
  }
  lines.push(s);

  const ups = score.factors.filter((f) => f.contribution >= 3).sort((a, b) => b.contribution - a.contribution);
  const downs = score.factors.filter((f) => f.contribution <= -3).sort((a, b) => a.contribution - b.contribution);
  s = `지표 종합 점수는 ${signed(score.value, 0)}점, '${score.label}'입니다.`;
  if (ups.length) s += ` 끌어올리는 요인은 ${ups.slice(0, 2).map((f) => f.name).join("·")}`;
  if (downs.length) s += `${ups.length ? "," : ""} 끌어내리는 요인은 ${downs.slice(0, 2).map((f) => f.name).join("·")}`;
  if (ups.length || downs.length) s += "입니다.";
  lines.push(s);

  lines.push(
    `오늘 예상 밴드는 ${fmt(range.low, 1)}~${fmt(range.high, 1)}원(세션 ATR ${fmt(range.atr, 1)}원)입니다. 위로 ${fmt(range.pivots.r1, 1)}·${fmt(range.pivots.r2, 1)}원, 아래로 ${fmt(range.pivots.s1, 1)}·${fmt(range.pivots.s2, 1)}원이 피벗 기준 저항·지지입니다.`,
  );

  if (finite(tech.rsi)) {
    const state =
      tech.rsi >= 70
        ? "과매수 구간이라 되돌림 가능성도 염두에 둘 만합니다"
        : tech.rsi <= 30
          ? "과매도 구간이라 반등 가능성도 염두에 둘 만합니다"
          : "과열·침체 신호는 없습니다";
    lines.push(`RSI ${tech.rsi.toFixed(0)}로 ${state}.`);
  }
  return lines;
}
