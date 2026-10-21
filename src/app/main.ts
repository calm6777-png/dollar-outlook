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
  calendar: [] as CalendarEvent[],
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
  const res = await fetch(url, init);
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
    $("updated").textContent = `${timeFmt.format(o.now)} 업데이트 · 시세 ${timeFmt.format(o.krw.time * 1000)}`;
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
  if (calendar.status === "fulfilled") state.calendar = calendar.value;
  renderCalendar(calendar.status === "fulfilled" ? calendar.value : null);
  renderNews(news.status === "fulfilled" ? news.value : null);
}

// ---------- 그리기 ----------

function render(o: Outlook) {
  renderHero(o);
  renderFactors(o);
  renderOvernight(o);
  renderLevels(o);
  renderMarkets(o);
  renderChart(o, false);
  if (state.calendar.length) renderCalendar(state.calendar);
}

function marketState(): string {
  const now = Date.now() / 1000;
  const m = kstMinutes(now);
  const dow = new Date((now + KST) * 1000).getUTCDay();
  if (dow === 0 || dow === 6) return "주말";
  if (m < 8 * 60 + 45) return "달러선물 개장 전";
  if (m < 15 * 60 + 45) return "달러선물 주간장 진행 중";
  return "주간장 마감 후";
}

function renderHero(o: Outlook) {
  const ref = o.krw.ref!;
  const sc = o.score;
  const v = Math.max(-100, Math.min(100, sc.value));
  const r = o.range;
  const pv = r.pivots;

  // 예상 밴드 그림의 눈금 범위
  const lo = Math.min(r.low, pv.s1, o.krw.price);
  const hi = Math.max(r.high, pv.r1, o.krw.price);
  const pad = (hi - lo) * 0.08 || 1;
  const pos = (x: number) => (((x - (lo - pad)) / (hi - lo + 2 * pad)) * 100).toFixed(2);

  const bt = sc.backtest;
  const baseline = Math.max(bt.baseUpRate, 1 - bt.baseUpRate);
  const weak = !(bt.hitRate > baseline + 0.03);
  const btLine =
    bt.signals >= 15 && finite(bt.hitRate)
      ? `점수 ±${SIGNAL} 이상이었던 날의 다음 날 방향 적중률은 ${(bt.hitRate * 100).toFixed(0)}%입니다(최근 ${bt.days}거래일 중 ${bt.signals}번). 매일 한 방향으로만 찍었다면 ${(baseline * 100).toFixed(0)}%였으니${
          weak ? ", 점수는 방향 예측보다 지금 분위기를 요약하는 용도로 보세요." : " 그보다 조금 낫습니다."
        }`
      : "과거 데이터가 부족해 점수의 적중률은 아직 계산하지 않았습니다.";

  $("hero").innerHTML = `
    <div class="hero-top">
      <span class="label">달러/원 현재가</span>
      <span class="badge">${esc(marketState())}</span>
    </div>
    <div class="price">${fmt(o.krw.price, 2)}</div>
    <div class="delta ${tone(ref.diff)}">${arrow(ref.diff)} ${fmt(Math.abs(ref.diff), 1)}원 (${signed(ref.pct, 2)}%)
      <span class="muted">${esc(ref.label)} ${fmt(ref.price, 1)}원 대비</span></div>

    <div class="block">
      <div class="score-row">
        <span class="label">지표 종합 점수</span>
        <span><span class="score-val ${sc.tone}">${signed(sc.value, 0)}</span>
        <span class="score-label ${sc.tone}">${esc(sc.label)}</span></span>
      </div>
      <div class="gauge" role="img" aria-label="종합 점수 ${Math.round(v)}점, -100부터 100 사이">
        <span class="fill ${v >= 0 ? "pos" : "neg"}" style="width:${Math.abs(v) / 2}%"></span>
        <span class="zone" style="left:${50 - SIGNAL / 2}%"></span>
        <span class="zone" style="left:${50 + SIGNAL / 2}%"></span>
        <span class="zero"></span>
      </div>
      <div class="gauge-scale"><span>-100 하락 우위</span><span>중립</span><span>상승 우위 +100</span></div>
    </div>

    <div class="block">
      <div class="score-row">
        <span class="label">오늘 예상 밴드</span>
        <span class="num"><b>${fmt(r.low, 1)} ~ ${fmt(r.high, 1)}</b> 원</span>
      </div>
      <div class="band" role="img" aria-label="예상 밴드 ${fmt(r.low, 1)}원부터 ${fmt(r.high, 1)}원, 현재가 ${fmt(o.krw.price, 1)}원">
        <span class="track"></span>
        <span class="range" style="left:${pos(r.low)}%;width:${(+pos(r.high) - +pos(r.low)).toFixed(2)}%"></span>
        <span class="tick" style="left:${pos(pv.s1)}%"><span>S1</span></span>
        <span class="tick" style="left:${pos(pv.p)}%"><span>P</span></span>
        <span class="tick" style="left:${pos(pv.r1)}%"><span>R1</span></span>
        <span class="now" style="left:${pos(o.krw.price)}%"><span>${fmt(o.krw.price, 1)}</span></span>
      </div>
      <p class="note">${esc(r.baseLabel)} ${fmt(r.base, 1)}원 ± 세션 ATR(14)의 절반(${fmt(r.atr / 2, 1)}원)${o.krw.session ? ", 오늘 이미 찍은 고가·저가 포함" : ""}. 피벗은 ${esc(r.pivotFrom.slice(5).replace("-", "/"))} 세션 고가·저가·종가 기준.</p>
    </div>

    <div class="block">
      <ul class="summary">${o.summary.map((s) => `<li>${esc(s)}</li>`).join("")}</ul>
      <div class="metric-grid">
        <div class="metric"><div class="k">RSI(14)</div><div class="v num">${fmt(o.tech.rsi, 0)}</div></div>
        <div class="metric"><div class="k">MACD 히스토</div><div class="v num">${signed(o.tech.macdHist, 2)}</div></div>
        <div class="metric"><div class="k">볼린저 %B</div><div class="v num">${fmt(o.tech.pctB, 2)}</div></div>
        <div class="metric"><div class="k">세션 ATR</div><div class="v num">${fmt(o.tech.atr, 1)}원</div></div>
      </div>
      <p class="note">${esc(btLine)}</p>
    </div>`;
}

function renderFactors(o: Outlook) {
  const rows = o.score.factors
    .map(
      (f) => `
      <div class="factor" title="${esc(`${f.name}: 요인 점수 ${Math.round(f.score * 100)} × 비중 ${Math.round(f.weight * 100)}% = ${signed(f.contribution, 1)}점`)}">
        <div class="name">${esc(f.name)}<small>비중 ${Math.round(f.weight * 100)}%</small></div>
        <div class="pts ${tone(Math.round(f.contribution * 10))}">${signed(f.contribution, 1)}</div>
        <div class="bar"><b class="${f.score >= 0 ? "pos" : "neg"}" style="width:${(Math.abs(f.score) * 50).toFixed(1)}%"></b></div>
        <div class="detail">${esc(f.detail)}</div>
      </div>`,
    )
    .join("");
  $("factors").innerHTML = `
    <div class="card-head"><h2>점수 구성</h2><span class="muted" style="font-size:12.5px">오른쪽 숫자 = 종합 점수에 보탠 점수</span></div>
    <div class="axis-note"><span>◀ 달러/원 하락 쪽</span><span>상승 쪽 ▶</span></div>
    ${rows}
    <p class="note">막대는 각 요인 자체의 강도(-100~+100)입니다. 글로벌 달러·위험 회피·미 금리는 최근 5거래일 변화가 평소(120일) 대비 얼마나 큰지로 잽니다. 과열·침체는 반대로 작용합니다(과매수면 하락 쪽).</p>`;
}

function chgText(kind: string, chg: number) {
  if (kind === "bp") return `${signed(chg, 1)}bp`;
  if (kind === "lvl") return `${signed(chg, 2)}p`;
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

function renderOvernight(o: Outlook) {
  const ov = o.overnight;
  if (!ov) {
    $("overnight").innerHTML = `<div class="card-head"><h2>직전 16시 이후</h2></div><p class="note">16시 직후라 아직 비교할 변화가 없습니다.</p>`;
    return;
  }
  const rows = ov.rows
    .map(
      (r) => `<tr>
        <td>${esc(r.name)}</td>
        <td class="r">${priceText(r.kind, r.to, r.dp)}</td>
        <td class="r">${chgSpan(r.kind, r.chg)}</td>
        <td class="r">${r.won == null ? '<span class="muted">–</span>' : `${signed(r.won, 1)}`}</td>
      </tr>`,
    )
    .join("");
  $("overnight").innerHTML = `
    <div class="card-head"><h2>직전 16시 이후</h2><span class="muted" style="font-size:12.5px">${esc(ov.label)} → 지금</span></div>
    <table>
      <thead><tr><th>지표</th><th class="r">현재</th><th class="r">변화</th><th class="r">원화 영향(원)</th></tr></thead>
      <tbody>${rows}</tbody>
      <tfoot>
        <tr><td colspan="3">드라이버로 본 예상 변동</td><td class="r ${tone(ov.implied)}">${signed(ov.implied, 1)}</td></tr>
        <tr><td colspan="3">실제 달러/원 변동</td><td class="r ${tone(ov.actual)}">${signed(ov.actual, 1)}</td></tr>
      </tfoot>
    </table>
    <p class="note">원화 영향은 최근 120거래일의 16시 기준 일간 변화로 추정한 민감도(릿지 회귀, 설명력 R² ${fmt(ov.r2, 2)})를 곱한 값입니다. 실제 변동이 예상보다 크게 높으면 원화가 따로 약한 것이고, 낮으면 따로 강한 것입니다.</p>`;
}

function renderLevels(o: Outlook) {
  const price = o.krw.price;
  const kindName = { pivot: "피벗", ma: "이평", hl: "고저", band: "밴드" } as const;
  const rows: string[] = [];
  let placed = false;
  const current = `<tr class="current"><td>현재가</td><td class="r">${fmt(price, 1)}</td><td class="r">0.0</td></tr>`;
  for (const l of o.range.levels) {
    if (!placed && l.value < price) {
      rows.push(current);
      placed = true;
    }
    rows.push(
      `<tr><td>${esc(l.name)}<span class="kind">${kindName[l.kind]}</span></td><td class="r">${fmt(l.value, 1)}</td><td class="r muted">${signed(l.value - price, 1)}</td></tr>`,
    );
  }
  if (!placed) rows.push(current);
  $("levels").innerHTML = `
    <div class="card-head"><h2>주요 가격대</h2></div>
    <table class="ladder">
      <thead><tr><th>가격대</th><th class="r">원</th><th class="r">거리</th></tr></thead>
      <tbody>${rows.join("")}</tbody>
    </table>
    <p class="note">고저·이평·밴드는 16시 기준 세션 일봉으로 계산합니다.</p>`;
}

function sparkSvg(points: { d: string; c: number }[]) {
  if (points.length < 2) return "";
  const vals = points.map((p) => p.c);
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const span = max - min || 1;
  const xs = (i: number) => (i / (points.length - 1)) * 100;
  const ys = (v: number) => 34 - ((v - min) / span) * 32;
  const d = points.map((p, i) => `${i ? "L" : "M"}${xs(i).toFixed(2)},${ys(p.c).toFixed(2)}`).join("");
  return `<svg viewBox="0 0 100 36" preserveAspectRatio="none" aria-hidden="true">
    <path d="${d}" fill="none" stroke="var(--ink-2)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>
    <line class="hair" x1="0" x2="0" y1="0" y2="36" stroke="var(--muted)" stroke-width="1" vector-effect="non-scaling-stroke" visibility="hidden"/>
  </svg>`;
}

function renderMarkets(o: Outlook) {
  const tiles = o.markets
    .map(
      (m) => `
      <div class="tile" data-key="${esc(m.key)}">
        <div class="t-name">${esc(m.name)}</div>
        <div class="t-val num">${priceText(m.kind, m.price, m.dp)}</div>
        <div class="t-chg">${chgSpan(m.kind, m.chg1d)}<span class="muted">5일 ${chgSpan(m.kind, m.chg5d)}</span></div>
        ${sparkSvg(m.spark)}
        <div class="t-corr">달러/원과 60일 상관 ${signed(m.corr60, 2)}</div>
      </div>`,
    )
    .join("");
  $("markets").innerHTML = `
    <div class="card-head"><h2>주변 시장</h2><span class="muted" style="font-size:12.5px">변화는 직전 16시 대비 · 선은 최근 30거래일 16시 값</span></div>
    <div class="tiles">${tiles}</div>
    <p class="note">상관은 16시 기준 일간 변화끼리의 상관계수입니다. +면 같은 방향(예: 달러인덱스↑ → 달러/원↑), -면 반대 방향(예: 코스피↑ → 달러/원↓)으로 움직여 왔다는 뜻입니다.</p>`;

  // 선 위를 가리키면 그날 값과 날짜를 보여 줍니다.
  for (const tile of $("markets").querySelectorAll<HTMLElement>(".tile")) {
    const m = o.markets.find((x) => x.key === tile.dataset.key)!;
    const svg = tile.querySelector("svg");
    if (!svg) continue;
    const val = tile.querySelector<HTMLElement>(".t-val")!;
    const chg = tile.querySelector<HTMLElement>(".t-chg")!;
    const hair = svg.querySelector<SVGLineElement>(".hair")!;
    const original = [val.innerHTML, chg.innerHTML];
    svg.addEventListener("pointermove", (e) => {
      const box = svg.getBoundingClientRect();
      const i = Math.round(((e.clientX - box.left) / box.width) * (m.spark.length - 1));
      const p = m.spark[Math.max(0, Math.min(m.spark.length - 1, i))];
      const x = ((Math.max(0, Math.min(m.spark.length - 1, i)) / (m.spark.length - 1)) * 100).toFixed(2);
      hair.setAttribute("x1", x);
      hair.setAttribute("x2", x);
      hair.setAttribute("visibility", "visible");
      val.textContent = priceText(m.kind, p.c, m.dp);
      chg.innerHTML = `<span class="muted">${esc(p.d.slice(5).replace("-", "/"))} 16시</span>`;
    });
    svg.addEventListener("pointerleave", () => {
      hair.setAttribute("visibility", "hidden");
      [val.innerHTML, chg.innerHTML] = original;
    });
  }
}

function renderCalendar(events: CalendarEvent[] | null) {
  const el = $("calendar");
  if (!events) {
    el.innerHTML = `<div class="card-head"><h2>경제지표 일정</h2></div><p class="note">일정을 불러오지 못했습니다.</p>`;
    return;
  }
  const now = Date.now();
  const groups = new Map<string, CalendarEvent[]>();
  for (const e of events) {
    const k = dayKey.format(e.time);
    groups.set(k, [...(groups.get(k) ?? []), e]);
  }
  const html = [...groups.values()]
    .map(
      (list) => `
      <div class="day-head">${esc(dayFmt.format(list[0].time))}</div>
      ${list
        .map((e) => {
          const meta = [e.forecast && `예상 ${e.forecast}`, e.previous && `이전 ${e.previous}`].filter(Boolean).join(" · ");
          return `<div class="event${e.time < now ? " past" : ""}">
            <span class="time">${timeFmt.format(e.time)}</span>
            <span class="title"><span class="muted">${esc(e.countryKo)}</span> ${esc(e.titleKo ?? e.title)}${e.titleKo ? `<small>${esc(e.title)}</small>` : ""}</span>
            <span class="impact ${e.impact === "High" ? "high" : "medium"}"><i></i>${e.impact === "High" ? "중요도 높음" : "중간"}</span>
            ${meta ? `<span class="meta">${esc(meta)}</span>` : ""}
          </div>`;
        })
        .join("")}`,
    )
    .join("");
  el.innerHTML = `
    <div class="card-head"><h2>경제지표 일정</h2><span class="muted" style="font-size:12.5px">한국 시간 · 미국·중국 중심</span></div>
    ${html || '<p class="note">앞으로 일주일 안에 큰 일정이 없습니다.</p>'}`;
}

function ago(ms: number) {
  const min = Math.max(0, Math.round((Date.now() - ms) / 60000));
  if (min < 60) return `${min}분 전`;
  if (min < 60 * 24) return `${Math.round(min / 60)}시간 전`;
  return `${Math.round(min / 1440)}일 전`;
}

function renderNews(items: NewsItem[] | null) {
  const el = $("news");
  if (!items) {
    el.innerHTML = `<div class="card-head"><h2>환율 뉴스</h2></div><p class="note">뉴스를 불러오지 못했습니다.</p>`;
    return;
  }
  el.innerHTML = `
    <div class="card-head"><h2>환율 뉴스</h2><span class="muted" style="font-size:12.5px">'원달러 환율' 최신 기사</span></div>
    <ul class="news-list">${items
      .filter((n) => /^https?:\/\//.test(n.link))
      .map(
        (n) => `<li><a href="${esc(n.link)}" target="_blank" rel="noopener noreferrer">${esc(n.title)}</a>
        <div class="meta">${esc(n.source)}${n.time ? ` · ${ago(n.time)}` : ""}</div></li>`,
      )
      .join("")}</ul>`;
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

  const unit = tf === "D" ? "일" : "봉";
  const sw = (cls: string, color: string, text: string) => `<span><i class="${cls}" style="background:${color}"></i>${text}</span>`;
  $("chart-legend").innerHTML = [
    sw("sw-candle", "var(--up)", "상승"),
    sw("sw-candle", "var(--down)", "하락"),
    sw("sw-line", "var(--ma20)", `20${unit} 이동평균`),
    sw("sw-line", "var(--ma60)", `60${unit} 이동평균`),
    sw("sw-line", "var(--band)", "볼린저밴드(20, 2)"),
    tf === "D" ? "" : sw("sw-line", "var(--pivot)", "오늘 피벗(R2~S2)"),
  ].join("");
  $("chart-note").textContent =
    tf === "D"
      ? "일봉 = 서울 세션(09:00~16:00 KST). 밤사이 움직임은 다음 봉 시가와의 간격으로 보입니다. 오늘 피벗선은 1시간·15분 화면에 표시합니다."
      : `한국 시간 기준 ${tf === "60" ? "1시간" : "15분"}봉(24시간). 손가락이나 마우스로 끌어 지난 구간을 볼 수 있습니다.`;
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
