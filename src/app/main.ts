// 화면: 시세를 받아 브라우저에서 전망을 계산하고 그립니다.
import * as ind from "../lib/indicators.ts";
import { KST, kstMinutes, type Bar } from "../lib/market.ts";
import { ALL_SYMBOLS, SIGNAL, buildOutlook, fmt, signed, type MarketData, type Outlook } from "../lib/outlook.ts";

// public/vendor/lightweight-charts.standalone.production.js 가 전역으로 올려 둡니다.
declare const LightweightCharts: any;

type TF = "D" | "60" | "15";
type Raw = Record<string, { chart?: { result?: unknown[] } } | null>;

interface CalendarEvent {
  time: number;
  country: string;
  countryKo: string;
  title: string;
  titleKo: string | null;
  impact: "High" | "Medium";
  forecast: string;
  previous: string;
}

interface NewsItem {
  title: string;
  source: string;
  link: string;
  time: number;
}

const LIVE_EVERY = 60_000;
const SIDE_EVERY = 10 * 60_000;
const HIST_TTL = 30 * 60_000;

const state = {
  hist: null as Raw | null,
  histAt: 0,
  outlook: null as Outlook | null,
  tf: "D" as TF,
  loading: false,
  lastLoad: 0,
  lastSide: 0,
  calendar: null as CalendarEvent[] | null,
};

const $ = (id: string) => document.getElementById(id)!;
const esc = (s: unknown) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const tone = (x: number) => (x > 0 ? "up" : x < 0 ? "down" : "flat");
const arrow = (x: number) => (x > 0 ? "▲" : x < 0 ? "▼" : "");
const finite = Number.isFinite;

const timeFmt = new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const dayFmt = new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", month: "long", day: "numeric", weekday: "short" });
const dayKey = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul" });

async function getJSON<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

function showError(text: string | null) {
  const el = $("error");
  el.hidden = !text;
  el.textContent = text ?? "";
}

// ---------- 불러오기 ----------

async function load(forceHist = false) {
  if (state.loading) return;
  state.loading = true;
  $("updated").textContent = "업데이트 중…";
  try {
    const needHist = forceHist || !state.hist || Date.now() - state.histAt > HIST_TTL;
    const [hist, live] = await Promise.all([
      needHist ? getJSON<Raw>("/api/market?p=hist") : Promise.resolve(state.hist!),
      getJSON<Raw>("/api/market?p=live", { cache: "no-cache" }),
    ]);
    if (needHist) {
      state.hist = hist;
      state.histAt = Date.now();
    }
    const data: MarketData = {};
    const pick = (r: Raw, s: string) => (r[s]?.chart?.result?.[0] ?? null) as MarketData[string]["hist"];
    for (const s of ALL_SYMBOLS) data[s] = { hist: pick(hist, s), live: pick(live, s) };
    const o = buildOutlook(data);
    state.outlook = o;
    state.lastLoad = Date.now();
    render(o);
    showError(o.missing.length ? `일부 종목(${o.missing.join(", ")}) 시세를 받지 못해 빼고 계산했습니다.` : null);
    $("updated").textContent = `${timeFmt.format(o.krw.time * 1000)} 기준`;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    showError(`시세를 불러오지 못했습니다(${msg}). 잠시 뒤 자동으로 다시 시도합니다.${state.outlook ? " 아래는 마지막으로 받은 값입니다." : ""}`);
    $("updated").textContent = "불러오기 실패";
  } finally {
    state.loading = false;
  }
}

async function loadSide() {
  state.lastSide = Date.now();
  const [calendar, news] = await Promise.allSettled([
    getJSON<CalendarEvent[]>("/api/calendar"),
    getJSON<NewsItem[]>("/api/news"),
  ]);
  state.calendar = calendar.status === "fulfilled" ? calendar.value : null;
  renderCalendar(calendar.status === "fulfilled" ? calendar.value : null);
  renderNews(news.status === "fulfilled" ? news.value : null);
}

// ---------- 그리기 ----------

function render(o: Outlook) {
  renderHero(o);
  renderLevels(o);
  renderFactors(o);
  renderMarkets(o);
  renderChart(o, false);
  if (state.calendar) renderCalendar(state.calendar);
}

function marketState(): string {
  const now = Date.now() / 1000;
  const m = kstMinutes(now);
  const dow = new Date((now + KST) * 1000).getUTCDay();
  if (dow === 0 || dow === 6) return "주말";
  if (m < 8 * 60 + 45) return "개장 전";
  if (m < 15 * 60 + 45) return "주간장 중";
  return "주간장 마감";
}

const SEGMENTS = ["강한 하락", "하락", "중립", "상승", "강한 상승"];

function segmentOf(v: number) {
  if (v <= -50) return 0;
  if (v <= -SIGNAL) return 1;
  if (v < SIGNAL) return 2;
  if (v < 50) return 3;
  return 4;
}

function renderHero(o: Outlook) {
  const ref = o.krw.ref!;
  const sc = o.score;
  const seg = segmentOf(sc.value);
  const segTone = seg < 2 ? "down" : seg > 2 ? "up" : "flat";
  const r = o.range;

  const bt = sc.backtest;
  const baseline = Math.max(bt.baseUpRate, 1 - bt.baseUpRate);
  const reliable = bt.hitRate > baseline + 0.03;
  const names = (list: typeof sc.factors) => list.slice(0, 2).map((f) => f.name.replace(/\(.*\)/, "")).join(", ");
  const ups = sc.factors.filter((f) => f.contribution >= 3).sort((a, b) => b.contribution - a.contribution);
  const downs = sc.factors.filter((f) => f.contribution <= -3).sort((a, b) => a.contribution - b.contribution);
  const why = [
    downs.length ? `<span>내리는 힘 <b>${esc(names(downs))}</b></span>` : "",
    ups.length ? `<span>올리는 힘 <b>${esc(names(ups))}</b></span>` : "",
    finite(bt.hitRate) && bt.signals >= 15
      ? `<span>과거 적중률 <b>${(bt.hitRate * 100).toFixed(0)}%</b>${reliable ? "" : " · 참고용"}</span>`
      : "",
  ].join("");

  $("hero").innerHTML = `
    <div class="hero-price">
      <div class="k">달러/원 <span class="chip">${esc(marketState())}</span></div>
      <div class="price num">${fmt(o.krw.price, 2)}</div>
      <div class="chg ${tone(Number(ref.diff.toFixed(1)))}">${arrow(ref.diff)} ${fmt(Math.abs(ref.diff), 1)}원 (${signed(ref.pct, 2)}%)<span class="sub">${esc(ref.label)} 대비</span></div>
    </div>
    <div class="hero-signal">
      <div class="k">오늘의 방향</div>
      <div class="signal-label ${sc.tone}">${esc(sc.label.replace(" · 방향성 약함", ""))}<small>${signed(sc.value, 0)}점</small></div>
      <div class="meter" role="img" aria-label="${esc(SEGMENTS[seg])} 구간">${SEGMENTS.map((_, i) => `<span class="${i === seg ? `on ${segTone}` : ""}"></span>`).join("")}</div>
      <div class="meter-labels"><span>하락</span><span>중립</span><span>상승</span></div>
    </div>
    <div class="hero-band">
      <div class="k">오늘 예상 범위</div>
      <div class="band-nums num">${fmt(r.low, 1)}<span class="tilde">~</span>${fmt(r.high, 1)}</div>
      <div class="band-sub sub">하루 평균 변동폭 ${fmt(r.atr, 1)}원 · ${esc(r.baseLabel)} ${fmt(r.base, 1)} 기준</div>
    </div>
    ${why ? `<div class="why">${why}</div>` : ""}`;
}

const LEVEL_NAMES: Record<string, string> = {
  "2차 저항(R2)": "2차 저항",
  "1차 저항(R1)": "1차 저항",
  "피벗(P)": "피벗",
  "1차 지지(S1)": "1차 지지",
  "2차 지지(S2)": "2차 지지",
  "20일선": "20일 이동평균",
  "20일 고점": "20일 고점",
  "20일 저점": "20일 저점",
};

function renderLevels(o: Outlook) {
  const price = o.krw.price;
  const rows: string[] = [];
  let placed = false;
  const now = `<div class="row lv now"><span class="name">현재가</span><span class="r">${fmt(price, 1)}</span><span></span></div>`;
  for (const l of o.range.levels.filter((x) => x.name in LEVEL_NAMES)) {
    if (!placed && l.value < price) {
      rows.push(now);
      placed = true;
    }
    rows.push(
      `<div class="row lv ${l.value >= price ? "res" : "sup"}"><span class="name">${esc(LEVEL_NAMES[l.name])}</span><span class="r">${fmt(l.value, 1)}</span><span class="r dist">${signed(l.value - price, 1)}</span></div>`,
    );
  }
  if (!placed) rows.push(now);
  $("levels").innerHTML = `
    <div class="panel-head"><h2>주요 가격대</h2><span class="sub">현재가와의 거리(원)</span></div>
    ${rows.join("")}`;
}

function renderFactors(o: Outlook) {
  const rows = o.score.factors
    .map(
      (f) => `
      <details class="frow">
        <summary>
          <span class="name">${esc(f.name.replace(/\(.*\)/, ""))}</span>
          <span class="dbar"><b class="${f.score >= 0 ? "pos" : "neg"}" style="width:${(Math.abs(f.score) * 50).toFixed(1)}%"></b></span>
          <span class="pts ${tone(Math.round(f.contribution))}">${signed(f.contribution, 0)}</span>
        </summary>
        <p>${esc(f.detail)} · 비중 ${Math.round(f.weight * 100)}%</p>
      </details>`,
    )
    .join("");
  $("factors").innerHTML = `
    <div class="panel-head"><h2>점수 구성</h2><span class="sub">누르면 근거</span></div>
    ${rows}`;
}

function chgText(kind: string, chg: number) {
  if (kind === "bp") return `${signed(chg, 1)}bp`;
  if (kind === "lvl") return `${signed(chg, 2)}`;
  return `${signed(chg, 2)}%`;
}

// 색은 화면에 보이는 반올림 값을 따릅니다(0.00%가 파랗게 보이지 않도록).
function chgSpan(kind: string, chg: number) {
  const shown = Number(chg.toFixed(kind === "bp" ? 1 : 2));
  return `<span class="${tone(shown)}">${chgText(kind, chg)}</span>`;
}

function priceText(kind: string, v: number, dp: number) {
  return kind === "bp" ? `${fmt(v, dp)}%` : fmt(v, dp);
}

function renderMarkets(o: Outlook) {
  const ov = o.overnight;
  let implied = "";
  if (ov) {
    const gap = ov.actual - ov.implied;
    const same = Math.abs(gap) < Math.max(1.5, o.range.atr * 0.15);
    implied = `<div class="implied">
      <span>주변 시장으로 본 예상 <b class="${tone(Number(ov.implied.toFixed(1)))}">${signed(ov.implied, 1)}원</b></span>
      <span>실제 <b class="${tone(Number(ov.actual.toFixed(1)))}">${signed(ov.actual, 1)}원</b></span>
      <span>${same ? "예상과 비슷" : gap < 0 ? "원화가 따로 강함" : "원화가 따로 약함"}</span>
    </div>`;
  }
  const rows = o.markets
    .map(
      (m) =>
        `<div class="row mk"><span>${esc(m.name)}</span><span class="r">${priceText(m.kind, m.price, m.dp)}</span><span class="r">${chgSpan(m.kind, m.chg1d)}</span></div>`,
    )
    .join("");
  $("markets").innerHTML = `
    <div class="panel-head"><h2>주변 시장</h2><span class="sub">${esc(o.krw.ref?.label ?? "")} 이후</span></div>
    ${implied}${rows}`;
}

const weekday = new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", weekday: "short" });

function whenText(ms: number) {
  const days = Math.round((Date.parse(dayKey.format(ms)) - Date.parse(dayKey.format(Date.now()))) / 86400000);
  const day = days === 0 ? "오늘" : days === 1 ? "내일" : weekday.format(ms);
  return `${day} ${timeFmt.format(ms)}`;
}

function renderCalendar(events: CalendarEvent[] | null) {
  const el = $("calendar");
  const head = `<div class="panel-head"><h2>다가오는 일정</h2><span class="sub">한국 시간</span></div>`;
  if (!events) {
    el.innerHTML = `${head}<p class="empty">일정을 불러오지 못했습니다.</p>`;
    return;
  }
  const upcoming = events.filter((e) => e.time >= Date.now() - 30 * 60_000).slice(0, 8);
  const rows = upcoming
    .map((e) => {
      const fc = e.forecast ? `예상 ${e.forecast}` : e.previous ? `이전 ${e.previous}` : "";
      return `<div class="row ev">
          <span class="when">${esc(whenText(e.time))}</span>
          <span class="what">${e.impact === "High" ? '<i class="dot" title="중요" aria-label="중요"></i>' : ""}${esc(e.titleKo ?? e.title)}<small>${esc(e.countryKo)}</small></span>
          <span class="fc">${esc(fc)}</span>
        </div>`;
    })
    .join("");
  el.innerHTML = head + (rows || '<p class="empty">앞으로 일주일 안에 큰 일정이 없습니다.</p>');
}

function ago(ms: number) {
  const min = Math.max(0, Math.round((Date.now() - ms) / 60000));
  if (min < 60) return `${min}분 전`;
  if (min < 60 * 24) return `${Math.round(min / 60)}시간 전`;
  return `${Math.round(min / 1440)}일 전`;
}

function renderNews(items: NewsItem[] | null) {
  const el = $("news");
  const head = `<div class="panel-head"><h2>환율 뉴스</h2></div>`;
  if (!items) {
    el.innerHTML = `${head}<p class="empty">뉴스를 불러오지 못했습니다.</p>`;
    return;
  }
  el.innerHTML =
    head +
    items
      .filter((n) => /^https?:\/\//.test(n.link))
      .slice(0, 5)
      .map(
        (n) => `<div class="row nw"><a href="${esc(n.link)}" target="_blank" rel="noopener noreferrer">${esc(n.title)}</a>
        <div class="meta">${esc(n.source)}${n.time ? ` · ${ago(n.time)}` : ""}</div></div>`,
      )
      .join("");
}

// ---------- 차트 ----------

let chart: any = null;
let series: Record<"candle" | "ma20" | "ma60" | "bbU" | "bbL", any> | null = null;
let pivotLines: any[] = [];
let shownTf: TF | null = null;

function cssVar(name: string) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function chartOptions() {
  return {
    layout: { background: { type: "solid", color: cssVar("--surface") }, textColor: cssVar("--muted"), fontFamily: cssVar("--font"), fontSize: 12 },
    grid: { vertLines: { color: cssVar("--grid") }, horzLines: { color: cssVar("--grid") } },
    rightPriceScale: { borderColor: cssVar("--axis") },
    timeScale: { borderColor: cssVar("--axis"), timeVisible: true, secondsVisible: false, rightOffset: 3 },
    crosshair: { mode: 0 },
    localization: { locale: "ko-KR", dateFormat: "yy.MM.dd", priceFormatter: (p: number) => fmt(p, 1) },
  };
}

function applySeriesColors() {
  if (!series) return;
  const up = cssVar("--up");
  const down = cssVar("--down");
  series.candle.applyOptions({ upColor: up, downColor: down, borderUpColor: up, borderDownColor: down, wickUpColor: up, wickDownColor: down });
  series.ma20.applyOptions({ color: cssVar("--ma20") });
  series.ma60.applyOptions({ color: cssVar("--ma60") });
  series.bbU.applyOptions({ color: cssVar("--band") });
  series.bbL.applyOptions({ color: cssVar("--band") });
  for (const l of pivotLines) l.applyOptions({ color: cssVar("--pivot"), axisLabelColor: cssVar("--pivot"), axisLabelTextColor: cssVar("--surface") });
}

function ensureChart(): boolean {
  if (chart) return true;
  if (typeof LightweightCharts === "undefined") return false;
  chart = LightweightCharts.createChart($("chart"), { autoSize: true, ...chartOptions() });
  const line = { priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false };
  series = {
    bbU: chart.addLineSeries({ ...line, lineWidth: 1 }),
    bbL: chart.addLineSeries({ ...line, lineWidth: 1 }),
    ma60: chart.addLineSeries({ ...line, lineWidth: 2 }),
    ma20: chart.addLineSeries({ ...line, lineWidth: 2 }),
    candle: chart.addCandlestickSeries({ priceLineVisible: true, lastValueVisible: true }),
  };
  applySeriesColors();
  chart.subscribeCrosshairMove((p: any) => showOHLC(p?.seriesData?.get(series!.candle) ?? null, p?.time));
  return true;
}

let lastBars: { time: string | number; open: number; high: number; low: number; close: number }[] = [];

function showOHLC(bar: { open: number; high: number; low: number; close: number } | null, time?: string | number) {
  const i = bar ? lastBars.findIndex((b) => b.time === time) : lastBars.length - 1;
  const b = bar ?? lastBars[i];
  if (!b) return;
  const prev = lastBars[i - 1];
  const chg = prev ? (b.close / prev.close - 1) * 100 : NaN;
  const t = time ?? lastBars[i].time;
  const when = typeof t === "string" ? t.replace(/-/g, ".") : new Date(t * 1000).toISOString().slice(0, 16).replace("T", " ").replace(/-/g, ".");
  $("ohlc").innerHTML = `${esc(when)} · 시 ${fmt(b.open, 1)} 고 ${fmt(b.high, 1)} 저 ${fmt(b.low, 1)} 종 <b>${fmt(b.close, 1)}</b>${
    finite(chg) ? ` <span class="${tone(chg)}">(${signed(chg, 2)}%)</span>` : ""
  }`;
}

function renderChart(o: Outlook, tfChanged: boolean) {
  if (!ensureChart()) return;
  const tf = state.tf;
  let bars: typeof lastBars;
  if (tf === "D") {
    bars = o.charts.daily.map((c) => ({ time: c.d, open: c.o, high: c.h, low: c.l, close: c.c }));
  } else {
    const src: Bar[] = tf === "60" ? o.charts.hourly.slice(-24 * 45) : o.charts.min15;
    bars = src.map((b) => ({ time: b.t + KST, open: b.o, high: b.h, low: b.l, close: b.c }));
    // 진행 중인 마지막 봉은 현재가로 맞춥니다(시세 응답의 마지막 봉 종가가 조금 늦을 수 있음).
    const last = bars[bars.length - 1];
    const step = tf === "60" ? 3600 : 900;
    if (last && o.krw.time + KST < (last.time as number) + step) {
      last.close = o.krw.price;
      last.high = Math.max(last.high, o.krw.price);
      last.low = Math.min(last.low, o.krw.price);
    }
  }
  lastBars = bars;
  const closes = bars.map((b) => b.close);
  const lineData = (v: number[]) => v.map((value, i) => ({ time: bars[i].time, value })).filter((p) => finite(p.value));
  const bb = ind.bollinger(closes, 20, 2);
  series!.candle.setData(bars);
  series!.ma20.setData(lineData(ind.sma(closes, 20)));
  series!.ma60.setData(lineData(ind.sma(closes, 60)));
  series!.bbU.setData(lineData(bb.upper));
  series!.bbL.setData(lineData(bb.lower));

  // 오늘 피벗은 시간봉에서만 그립니다(일봉 6개월 화면에서는 한데 뭉쳐 읽기 어렵습니다).
  for (const l of pivotLines) series!.candle.removePriceLine(l);
  const pv = o.range.pivots;
  const levels = [
    ["R2", pv.r2],
    ["R1", pv.r1],
    ["P", pv.p],
    ["S1", pv.s1],
    ["S2", pv.s2],
  ] as const;
  pivotLines =
    tf === "D" ? [] : levels.map(([title, price]) => series!.candle.createPriceLine({ price, title, lineWidth: 1, lineStyle: 0, axisLabelVisible: true }));
  applySeriesColors();

  if (tfChanged || shownTf !== tf) {
    const show = tf === "D" ? 130 : tf === "60" ? 24 * 7 : 4 * 24 * 2;
    chart.timeScale().setVisibleLogicalRange({ from: Math.max(0, bars.length - show), to: bars.length + 2 });
    shownTf = tf;
  }
  showOHLC(null);

  const unit = tf === "D" ? "일선" : "봉 평균";
  const sw = (color: string, text: string) => `<span><i style="background:${color}"></i>${text}</span>`;
  $("chart-legend").innerHTML = [
    sw("var(--ma20)", `20${unit}`),
    sw("var(--ma60)", `60${unit}`),
    sw("var(--band)", "볼린저밴드"),
    tf === "D" ? "" : sw("var(--pivot)", "오늘 피벗"),
  ].join("");
}

// ---------- 시작 ----------

function setTheme() {
  const root = document.documentElement;
  const dark = root.dataset.theme ? root.dataset.theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
  root.dataset.theme = dark ? "light" : "dark";
  try {
    localStorage.setItem("theme", root.dataset.theme);
  } catch {
    // 저장이 막혀 있어도 이번 화면에서는 바뀝니다.
  }
  restyleChart();
}

function restyleChart() {
  if (!chart) return;
  chart.applyOptions(chartOptions());
  applySeriesColors();
}

function init() {
  $("refresh").addEventListener("click", () => {
    load(true);
    loadSide();
  });
  $("theme").addEventListener("click", setTheme);
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", restyleChart);
  for (const b of document.querySelectorAll<HTMLButtonElement>(".seg button")) {
    b.addEventListener("click", () => {
      state.tf = b.dataset.tf as TF;
      for (const x of document.querySelectorAll<HTMLButtonElement>(".seg button")) x.setAttribute("aria-selected", String(x === b));
      if (state.outlook) renderChart(state.outlook, true);
    });
  }
  const tick = () => {
    if (document.visibilityState !== "visible") return;
    if (Date.now() - state.lastLoad >= LIVE_EVERY - 1000) load();
    if (Date.now() - state.lastSide >= SIDE_EVERY) loadSide();
  };
  setInterval(tick, 15_000);
  document.addEventListener("visibilitychange", tick);
  load();
  loadSide();
}

init();
