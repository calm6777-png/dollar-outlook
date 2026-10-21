// 기술적 지표와 간단한 통계. 모든 배열은 입력과 같은 길이이며, 계산할 수 없는 자리는 NaN입니다.

export interface OHLC {
  h: number;
  l: number;
  c: number;
}

export function sma(v: number[], n: number): number[] {
  const out = new Array<number>(v.length).fill(NaN);
  let sum = 0;
  for (let i = 0; i < v.length; i++) {
    sum += v[i];
    if (i >= n) sum -= v[i - n];
    if (i >= n - 1) out[i] = sum / n;
  }
  return out;
}

export function ema(v: number[], n: number): number[] {
  const out = new Array<number>(v.length).fill(NaN);
  const start = v.findIndex((x) => Number.isFinite(x));
  if (start < 0 || v.length - start < n) return out;
  let prev = 0;
  for (let i = start; i < start + n; i++) prev += v[i];
  prev /= n;
  out[start + n - 1] = prev;
  const k = 2 / (n + 1);
  for (let i = start + n; i < v.length; i++) {
    prev = v[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

// Wilder 방식 RSI
export function rsi(c: number[], n = 14): number[] {
  const out = new Array<number>(c.length).fill(NaN);
  if (c.length <= n) return out;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= n; i++) {
    const d = c[i] - c[i - 1];
    if (d > 0) gain += d;
    else loss -= d;
  }
  gain /= n;
  loss /= n;
  const value = () => (loss === 0 ? 100 : 100 - 100 / (1 + gain / loss));
  out[n] = value();
  for (let i = n + 1; i < c.length; i++) {
    const d = c[i] - c[i - 1];
    gain = (gain * (n - 1) + Math.max(d, 0)) / n;
    loss = (loss * (n - 1) + Math.max(-d, 0)) / n;
    out[i] = value();
  }
  return out;
}

export function macd(c: number[], fast = 12, slow = 26, signalN = 9) {
  const f = ema(c, fast);
  const s = ema(c, slow);
  const line = c.map((_, i) => f[i] - s[i]);
  const signal = ema(line, signalN);
  const hist = line.map((x, i) => x - signal[i]);
  return { line, signal, hist };
}

export function bollinger(c: number[], n = 20, k = 2) {
  const mid = sma(c, n);
  const upper = new Array<number>(c.length).fill(NaN);
  const lower = new Array<number>(c.length).fill(NaN);
  for (let i = n - 1; i < c.length; i++) {
    let sq = 0;
    for (let j = i - n + 1; j <= i; j++) sq += (c[j] - mid[i]) ** 2;
    const sd = Math.sqrt(sq / n);
    upper[i] = mid[i] + k * sd;
    lower[i] = mid[i] - k * sd;
  }
  return { mid, upper, lower };
}

// Wilder 방식 ATR
export function atr(bars: OHLC[], n = 14): number[] {
  const out = new Array<number>(bars.length).fill(NaN);
  if (bars.length < n) return out;
  const tr = bars.map((b, i) =>
    i === 0 ? b.h - b.l : Math.max(b.h - b.l, Math.abs(b.h - bars[i - 1].c), Math.abs(b.l - bars[i - 1].c)),
  );
  let a = 0;
  for (let i = 0; i < n; i++) a += tr[i];
  a /= n;
  out[n - 1] = a;
  for (let i = n; i < bars.length; i++) {
    a = (a * (n - 1) + tr[i]) / n;
    out[i] = a;
  }
  return out;
}

export function pivots(prev: OHLC) {
  const p = (prev.h + prev.l + prev.c) / 3;
  return {
    r2: p + (prev.h - prev.l),
    r1: 2 * p - prev.l,
    p,
    s1: 2 * p - prev.h,
    s2: p - (prev.h - prev.l),
  };
}

export function mean(v: number[]): number {
  return v.reduce((a, b) => a + b, 0) / v.length;
}

export function stdev(v: number[]): number {
  if (v.length < 2) return NaN;
  const m = mean(v);
  return Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / (v.length - 1));
}

export function correlation(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (n < 10) return NaN;
  const ma = mean(a.slice(0, n));
  const mb = mean(b.slice(0, n));
  let sab = 0;
  let saa = 0;
  let sbb = 0;
  for (let i = 0; i < n; i++) {
    sab += (a[i] - ma) * (b[i] - mb);
    saa += (a[i] - ma) ** 2;
    sbb += (b[i] - mb) ** 2;
  }
  return saa && sbb ? sab / Math.sqrt(saa * sbb) : NaN;
}

// 표준화한 설명변수로 릿지 회귀를 풀고, 원래 단위의 계수와 결정계수를 돌려줍니다.
// 달러인덱스와 위안화처럼 서로 닮은 변수가 함께 들어가도 계수가 튀지 않게 하려는 용도입니다.
export function ridge(X: number[][], y: number[], lambda = 0.1): { beta: number[]; r2: number } {
  const n = y.length;
  const k = X[0]?.length ?? 0;
  if (n < k + 5) return { beta: new Array(k).fill(0), r2: NaN };
  const mx: number[] = [];
  const sx: number[] = [];
  for (let j = 0; j < k; j++) {
    const col = X.map((row) => row[j]);
    mx.push(mean(col));
    sx.push(stdev(col) || 1);
  }
  const my = mean(y);
  const Z = X.map((row) => row.map((x, j) => (x - mx[j]) / sx[j]));
  const A: number[][] = Array.from({ length: k }, () => new Array(k).fill(0));
  const b = new Array<number>(k).fill(0);
  for (let i = 0; i < n; i++) {
    for (let p = 0; p < k; p++) {
      b[p] += Z[i][p] * (y[i] - my);
      for (let q = 0; q < k; q++) A[p][q] += Z[i][p] * Z[i][q];
    }
  }
  for (let p = 0; p < k; p++) A[p][p] += lambda * n;
  const bz = solve(A, b);
  const beta = bz.map((v, j) => v / sx[j]);
  let ssRes = 0;
  let ssTot = 0;
  for (let i = 0; i < n; i++) {
    let fit = my;
    for (let j = 0; j < k; j++) fit += beta[j] * (X[i][j] - mx[j]);
    ssRes += (y[i] - fit) ** 2;
    ssTot += (y[i] - my) ** 2;
  }
  return { beta, r2: ssTot ? 1 - ssRes / ssTot : NaN };
}

function solve(A: number[][], b: number[]): number[] {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[pivot][col])) pivot = r;
    [M[col], M[pivot]] = [M[pivot], M[col]];
    const d = M[col][col] || 1e-12;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = M[r][col] / d;
      for (let c = col; c <= n; c++) M[r][c] -= f * M[col][c];
    }
  }
  return M.map((row, i) => row[n] / (row[i] || 1e-12));
}
