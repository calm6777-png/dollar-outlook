// Yahoo 차트 응답을 한국 시간(KST) 기준 시계열로 바꿉니다.
//
// Yahoo의 FX 일봉 종가는 찍히는 시각이 들쭉날쭉하고(위안은 며칠씩 같은 값이 반복되기도 함),
// 그대로 쓰면 상관관계·회귀·백테스트가 틀어집니다. 그래서 1시간봉/15분봉으로부터
// 모든 종목을 "같은 날 16:00 KST에 알 수 있던 마지막 가격"으로 다시 맞춥니다.
// 16:00은 달러선물 주간장(08:45~15:45) 마감 직후입니다.

export interface RawChart {
  meta: { regularMarketPrice?: number; regularMarketTime?: number };
  timestamp?: number[];
  indicators: { quote: { open: (number | null)[]; high: (number | null)[]; low: (number | null)[]; close: (number | null)[] }[] };
}

export interface Bar {
  t: number; // 봉 시작 시각(unix 초)
  o: number;
  h: number;
  l: number;
  c: number;
}

export interface Candle extends Bar {
  d: string; // KST 날짜 YYYY-MM-DD
  snap: number; // 이 날 16:00 KST(unix 초)
  complete: boolean; // 16:00이 지났는지
}

export interface Series {
  price: number;
  time: number;
  bars60: Bar[];
  bars15: Bar[];
  points: { t: number; c: number }[]; // (가격이 확정된 시각, 가격), 시간순
}

export const KST = 9 * 3600;
export const OPEN_MIN = 9 * 60;
export const SNAP_MIN = 16 * 60;

export function kstDay(sec: number): number {
  return Math.floor((sec + KST) / 86400);
}

export function kstMinutes(sec: number): number {
  return Math.floor((((sec + KST) % 86400) + 86400) % 86400 / 60);
}

export function kstDate(sec: number): string {
  return new Date((sec + KST) * 1000).toISOString().slice(0, 10);
}

// KST 날짜(일 번호)의 hh:mm 시각을 unix 초로
export function kstTime(day: number, minutes: number): number {
  return day * 86400 + minutes * 60 - KST;
}

export function parseBars(raw: RawChart | null | undefined): Bar[] {
  const ts = raw?.timestamp;
  const q = raw?.indicators?.quote?.[0];
  if (!ts || !q) return [];
  const bars: Bar[] = [];
  for (let i = 0; i < ts.length; i++) {
    const c = q.close[i];
    if (c == null || !Number.isFinite(c)) continue;
    const o = q.open[i] ?? c;
    bars.push({ t: ts[i], o, h: Math.max(q.high[i] ?? c, o, c), l: Math.min(q.low[i] ?? c, o, c), c });
  }
  return bars;
}

export function buildSeries(hist: RawChart | null | undefined, live: RawChart | null | undefined): Series | null {
  const bars60 = parseBars(hist);
  const bars15 = parseBars(live);
  const meta = live?.meta ?? hist?.meta;
  const lastBar = bars15[bars15.length - 1] ?? bars60[bars60.length - 1];
  if (!lastBar) return null;
  const price = meta?.regularMarketPrice ?? lastBar.c;
  const time = meta?.regularMarketTime ?? lastBar.t;

  // 15분봉이 시작되기 전까지는 1시간봉, 그 뒤로는 15분봉을 씁니다.
  const cut = bars15.length ? bars15[0].t : Infinity;
  const points: { t: number; c: number }[] = [];
  for (const b of bars60) if (b.t < cut) points.push({ t: Math.min(b.t + 3600, cut), c: b.c });
  for (const b of bars15) points.push({ t: b.t + 900, c: b.c });
  // 진행 중인 마지막 봉은 지금 시각의 현재가로 대신합니다.
  while (points.length && points[points.length - 1].t > time) points.pop();
  points.push({ t: time, c: price });
  return { price, time, bars60, bars15, points };
}

// 시각 T에 이미 알 수 있던 마지막 가격
export function asOf(s: Series | null, T: number): number {
  if (!s) return NaN;
  const p = s.points;
  let lo = 0;
  let hi = p.length - 1;
  if (!p.length || p[0].t > T) return NaN;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (p[mid].t <= T) lo = mid;
    else hi = mid - 1;
  }
  return p[lo].c;
}

// 평일 09:00~16:00 KST 봉으로 만든 '서울 세션 일봉'. 최근 며칠은 15분봉으로 더 정확히 다시 만듭니다.
export function sessionCandles(s: Series, now: number): Candle[] {
  const byDay = new Map<number, Bar[]>();
  const fineDays = new Set(s.bars15.map((b) => kstDay(b.t)));
  const add = (b: Bar) => {
    const m = kstMinutes(b.t);
    if (m < OPEN_MIN || m >= SNAP_MIN) return;
    const day = kstDay(b.t);
    const dow = new Date(day * 86400 * 1000).getUTCDay();
    if (dow === 0 || dow === 6) return;
    const list = byDay.get(day) ?? [];
    list.push(b);
    byDay.set(day, list);
  };
  for (const b of s.bars60) if (!fineDays.has(kstDay(b.t))) add(b);
  for (const b of s.bars15) add(b);

  const candles = [...byDay.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([day, list]) => {
      const snap = kstTime(day, SNAP_MIN);
      const complete = now >= snap;
      return {
        d: kstDate(snap),
        t: kstTime(day, OPEN_MIN),
        snap,
        complete,
        o: list[0].o,
        h: Math.max(...list.map((b) => b.h)),
        l: Math.min(...list.map((b) => b.l)),
        c: list[list.length - 1].c,
      };
    });
  const last = candles[candles.length - 1];
  if (last && !last.complete) {
    last.c = s.price;
    last.h = Math.max(last.h, s.price);
    last.l = Math.min(last.l, s.price);
  }
  return tameWicks(candles);
}

// 무료 시세에 가끔 섞이는 비정상적으로 긴 꼬리를 최근 60봉 폭 중앙값 기준으로 잘라 냅니다.
function tameWicks<T extends Bar>(bars: T[]): T[] {
  const ranges = bars.slice(-60).map((b) => b.h - b.l).sort((a, b) => a - b);
  const median = ranges[Math.floor(ranges.length / 2)] || 0;
  if (median <= 0) return bars;
  for (const b of bars) {
    const top = Math.max(b.o, b.c);
    const bottom = Math.min(b.o, b.c);
    if (b.h - top > median * 4) b.h = top + median;
    if (bottom - b.l > median * 4) b.l = bottom - median;
  }
  return bars;
}

// 차트용 시간봉: 오래된 구간은 1시간봉, 최근 5일은 15분봉을 1시간으로 묶어 씁니다.
export function hourlyBars(s: Series): Bar[] {
  const cut = s.bars15.length ? s.bars15[0].t : Infinity;
  const out = s.bars60.filter((b) => b.t < cut).map((b) => ({ ...b }));
  let cur: Bar | null = null;
  for (const b of s.bars15) {
    const hour = Math.floor(b.t / 3600) * 3600;
    if (!cur || cur.t !== hour) {
      cur = { t: hour, o: b.o, h: b.h, l: b.l, c: b.c };
      out.push(cur);
    } else {
      cur.h = Math.max(cur.h, b.h);
      cur.l = Math.min(cur.l, b.l);
      cur.c = b.c;
    }
  }
  return out;
}
