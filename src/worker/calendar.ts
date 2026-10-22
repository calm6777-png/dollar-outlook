// 앞으로 일주일 경제지표 일정. 원화에 영향이 큰 미국·중국 위주로 거릅니다.
// FXStreet 일정 API를 먼저 쓰고, 안 되면 Forex Factory 주간 JSON으로 대신합니다
// (Forex Factory는 Cloudflare 서버에서 오는 요청을 429로 막습니다).

export interface CalendarEvent {
  time: number; // ms
  country: string;
  countryKo: string;
  title: string;
  titleKo: string | null;
  impact: "High" | "Medium";
  forecast: string;
  previous: string;
}

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36";
const BEFORE = 6 * 3600_000; // 지난 6시간 일정까지 보여 줌(결과 확인용)
const AHEAD = 8 * 86400_000;

const COUNTRY_KO: Record<string, string> = { USD: "미국", CNY: "중국", JPY: "일본", EUR: "유로존", KRW: "한국" };

// 미국·중국은 중간 이상, 일본·유로존은 높음만 봅니다.
const MIN_IMPACT: Record<string, string[]> = {
  USD: ["High", "Medium"],
  CNY: ["High", "Medium"],
  JPY: ["High"],
  EUR: ["High"],
};

// 위에서부터 처음 맞는 것을 씁니다(구체적인 이름을 앞에). FXStreet·Forex Factory 이름을 모두 다룹니다.
const TITLE_KO: [RegExp, string][] = [
  // 미 연준
  [/^(Federal Funds Rate|Fed Interest Rate Decision)/, "미 기준금리 결정"],
  [/^(FOMC Statement|Fed Monetary Policy Statement)/, "FOMC 성명서"],
  [/^FOMC Press Conference/, "FOMC 기자회견"],
  [/^FOMC (Meeting )?Minutes/, "FOMC 의사록"],
  [/^FOMC Economic Projections/, "FOMC 경제전망"],
  [/^Interest Rate Projections/, "FOMC 금리 전망(점도표)"],
  [/^Fed Chair .* (Speaks|Testifies)|^Fed's Chair .* speech/, "연준 의장 발언"],
  [/^FOMC Member .* Speaks|^Fed's .* speech/, "연준 위원 발언"],
  [/Beige Book/, "베이지북"],
  // 물가
  [/^Core CPI m\/m|^Consumer Price Index ex Food & Energy \(MoM\)/, "근원 소비자물가(전월비)"],
  [/^Core CPI y\/y|^Consumer Price Index ex Food & Energy \(YoY\)/, "근원 소비자물가(전년비)"],
  [/^CPI m\/m|^Consumer Price Index \(MoM\)/, "소비자물가(전월비)"],
  [/^CPI y\/y|^Consumer Price Index \(YoY\)/, "소비자물가(전년비)"],
  [/^Core PPI m\/m|^Producer Price Index ex Food & Energy \(MoM\)/, "근원 생산자물가(전월비)"],
  [/^Producer Price Index ex Food & Energy \(YoY\)/, "근원 생산자물가(전년비)"],
  [/^PPI m\/m|^Producer Price Index \(MoM\)/, "생산자물가(전월비)"],
  [/^PPI y\/y|^Producer Price Index \(YoY\)/, "생산자물가(전년비)"],
  [/^Core PCE Price Index m\/m|^Core Personal Consumption Expenditures - Price Index \(MoM\)/, "근원 PCE 물가(전월비)"],
  [/^Core Personal Consumption Expenditures - Price Index \(YoY\)/, "근원 PCE 물가(전년비)"],
  [/^Personal Consumption Expenditures - Price Index/, "PCE 물가"],
  [/UoM 1-year .*Inflation Expectation/, "미시간대 1년 기대인플레이션"],
  [/UoM 5-year .*Inflation Expectation/, "미시간대 5년 기대인플레이션"],
  [/UoM .*Inflation Expectation/, "미시간대 기대인플레이션"],
  // 고용
  [/^ADP (Non-Farm )?Employment Change/, "ADP 민간 고용"],
  [/^Non-Farm Employment Change|^Nonfarm Payrolls/, "비농업 고용"],
  [/^Unemployment Rate/, "실업률"],
  [/^Average Hourly Earnings/, "평균 시간당 임금"],
  [/^Unemployment Claims|^Initial Jobless Claims/, "신규 실업수당 청구"],
  [/^JOLTS Job Openings/, "JOLTS 구인"],
  [/^Employment Cost Index/, "고용비용지수"],
  // 경기
  [/^ISM Manufacturing PMI/, "ISM 제조업 PMI"],
  [/^ISM Services PMI/, "ISM 서비스업 PMI"],
  [/^ISM Manufacturing Prices Paid/, "ISM 제조업 가격지수"],
  [/^Flash Manufacturing PMI|^S&P Global Manufacturing PMI/, "S&P 제조업 PMI"],
  [/^Flash Services PMI|^S&P Global Services PMI/, "S&P 서비스업 PMI"],
  [/^S&P Global Composite PMI/, "S&P 종합 PMI"],
  [/^Retail Sales Control Group/, "소매판매(통제그룹)"],
  [/^Core Retail Sales m\/m|^Retail Sales ex Autos/, "자동차 제외 소매판매"],
  [/^Retail Sales (m\/m|\(MoM\))/, "소매판매(전월비)"],
  [/^Retail Sales (y\/y|\(YoY\))/, "소매판매(전년비)"],
  [/^Gross Domestic Product Annualized|GDP q\/q/, "GDP(연율)"],
  [/^Gross Domestic Product \(QoQ\)/, "GDP(전분기비)"],
  [/^Gross Domestic Product \(YoY\)/, "GDP(전년비)"],
  [/UoM Consumer Sentiment|^Michigan Consumer Sentiment/, "미시간대 소비심리"],
  [/^Michigan Consumer Expectations/, "미시간대 기대지수"],
  [/^CB Consumer Confidence|^Consumer Confidence/, "소비자신뢰지수"],
  [/^Durable Goods Orders ex Defense/, "내구재 주문(국방 제외)"],
  [/^Durable Goods Orders ex Transportation|^Core Durable Goods Orders/, "내구재 주문(운송 제외)"],
  [/^Durable Goods Orders/, "내구재 주문"],
  [/^Nondefense Capital Goods Orders ex Aircraft/, "핵심 자본재 주문"],
  [/^Housing Price Index/, "주택가격지수"],
  [/^Housing Starts/, "주택착공"],
  [/^Building Permits/, "건축허가"],
  [/^Existing Home Sales/, "기존주택 판매"],
  [/^New Home Sales/, "신규주택 판매"],
  [/^Pending Home Sales/, "잠정주택 판매"],
  [/^Industrial Production/, "산업생산"],
  [/^Philly Fed Manufacturing Index|^Philadelphia Fed Manufacturing/, "필라델피아 연은 제조업지수"],
  [/^Empire State Manufacturing Index|^NY Empire State Manufacturing/, "뉴욕 연은 제조업지수"],
  [/^Personal Income/, "개인소득"],
  [/^Personal Spending/, "개인소비"],
  [/^Treasury Currency Report/, "미 재무부 환율보고서"],
  // 중국
  [/^NBS Manufacturing PMI|^Manufacturing PMI/, "제조업 PMI(국가통계국)"],
  [/^NBS Non-Manufacturing PMI|^Non-Manufacturing PMI/, "비제조업 PMI(국가통계국)"],
  [/^(Caixin|RatingDog) Manufacturing PMI/, "민간 제조업 PMI"],
  [/^(Caixin|RatingDog) Services PMI/, "민간 서비스업 PMI"],
  [/^Exports/, "수출"],
  [/^Imports/, "수입"],
  [/^Trade Balance/, "무역수지"],
  [/^PBoC Interest Rate Decision|Loan Prime Rate/, "인민은행 금리 결정"],
  [/^Fixed Asset Investment/, "고정자산투자"],
  // 일본·유로존
  [/^BoJ Interest Rate Decision|^BOJ Policy Rate/, "일본은행 금리 결정"],
  [/^BoJ Monetary Policy Statement/, "일본은행 성명서"],
  [/^BoJ Press Conference/, "일본은행 기자회견"],
  [/^BoJ Governor .* speech/, "일본은행 총재 발언"],
  [/^Tokyo (CPI|Consumer Price Index)/, "도쿄 소비자물가"],
  [/^Tankan/, "단칸 지수"],
  [/^Main Refinancing Rate|^ECB Main Refinancing Operations Rate/, "ECB 금리 결정"],
  [/^ECB Rate On Deposit Facility/, "ECB 예금금리"],
  [/^ECB Monetary Policy Statement/, "ECB 성명서"],
  [/^ECB Press Conference/, "ECB 기자회견"],
  [/^ECB Bank Lending Survey/, "ECB 은행대출 서베이"],
  [/^ECB Monetary Policy Meeting Accounts/, "ECB 의사록"],
  [/^ECB's President .* speech/, "ECB 총재 발언"],
  [/^Core Harmonized Index of Consumer Prices/, "근원 소비자물가(HICP)"],
  [/^Harmonized Index of Consumer Prices/, "소비자물가(HICP)"],
  [/^HCOB Manufacturing PMI/, "제조업 PMI"],
  [/^HCOB Services PMI/, "서비스업 PMI"],
  [/^HCOB Composite PMI/, "종합 PMI"],
  [/^Bank Holiday/, "휴장"],
];

export function translateTitle(title: string): string | null {
  for (const [re, ko] of TITLE_KO) if (re.test(title)) return ko;
  return null;
}

function keep(country: string, impact: string, time: number, now: number): boolean {
  return !!MIN_IMPACT[country]?.includes(impact) && Number.isFinite(time) && time >= now - BEFORE && time <= now + AHEAD;
}

function event(country: string, title: string, impact: string, time: number, forecast: string, previous: string): CalendarEvent {
  return {
    time,
    country,
    countryKo: COUNTRY_KO[country] ?? country,
    title,
    titleKo: translateTitle(title),
    impact: impact as "High" | "Medium",
    forecast,
    previous,
  };
}

// ---------- FXStreet ----------

interface FxsEvent {
  dateUtc: string;
  name: string;
  countryCode: string;
  volatility: string;
  consensus: number | null;
  previous: number | null;
  unit: string | null;
  potency: string | null;
  isAllDay: boolean;
}

const FXS_COUNTRY: Record<string, string> = { US: "USD", CN: "CNY", JP: "JPY", EMU: "EUR" };

function fxsValue(v: number | null, unit: string | null, potency: string | null): string {
  if (v == null) return "";
  const scale = potency && ["K", "M", "B", "T"].includes(potency) ? potency : "";
  const prefix = unit && unit !== "%" ? unit : "";
  return `${prefix}${Number(v.toFixed(3))}${scale}${unit === "%" ? "%" : ""}`;
}

async function fromFxstreet(now: number): Promise<CalendarEvent[]> {
  const iso = (ms: number) => new Date(ms).toISOString().slice(0, 19) + "Z";
  const countries = Object.keys(FXS_COUNTRY).map((c) => `countries=${c}`).join("&");
  const url = `https://calendar-api.fxstreet.com/en/api/v1/eventDates/${iso(now - BEFORE)}/${iso(now + AHEAD)}?volatilities=HIGH&volatilities=MEDIUM&${countries}`;
  const res = await fetch(url, {
    headers: { "User-Agent": UA, Accept: "application/json", Referer: "https://www.fxstreet.com/" },
    signal: AbortSignal.timeout(6000),
  });
  if (!res.ok) throw new Error(`FXStreet HTTP ${res.status}`);
  const list = (await res.json()) as FxsEvent[];
  if (!Array.isArray(list)) throw new Error("FXStreet 응답 형식이 다릅니다");
  return list
    .filter((e) => !e.isAllDay)
    .map((e) => {
      const country = FXS_COUNTRY[e.countryCode] ?? e.countryCode;
      const impact = e.volatility === "HIGH" ? "High" : "Medium";
      return event(country, e.name, impact, Date.parse(e.dateUtc), fxsValue(e.consensus, e.unit, e.potency), fxsValue(e.previous, e.unit, e.potency));
    })
    .filter((e) => keep(e.country, e.impact, e.time, now));
}

// ---------- Forex Factory ----------

interface FfEvent {
  title: string;
  country: string;
  date: string;
  impact: string;
  forecast: string;
  previous: string;
}

async function fromForexFactory(now: number): Promise<CalendarEvent[]> {
  const feeds = ["thisweek", "nextweek"].map((w) => `https://nfs.faireconomy.media/ff_calendar_${w}.json`);
  const [thisWeek, nextWeek] = await Promise.all(
    feeds.map(async (url) => {
      const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" }, signal: AbortSignal.timeout(6000) });
      if (!res.ok) throw new Error(`Forex Factory HTTP ${res.status}`);
      return (await res.json()) as FfEvent[];
    }).map((p, i) => (i === 0 ? p : p.catch(() => [] as FfEvent[]))), // 다음 주 파일은 주 후반에만 생깁니다.
  );
  const seen = new Set<string>();
  const out: CalendarEvent[] = [];
  for (const raw of [...thisWeek, ...nextWeek]) {
    const time = Date.parse(raw.date);
    const id = `${raw.country}|${raw.title}|${time}`;
    if (!keep(raw.country, raw.impact, time, now) || seen.has(id)) continue;
    seen.add(id);
    out.push(event(raw.country, raw.title, raw.impact, time, raw.forecast, raw.previous));
  }
  return out;
}

export async function fetchCalendar(now = Date.now()): Promise<CalendarEvent[]> {
  const failures: string[] = [];
  for (const source of [fromFxstreet, fromForexFactory]) {
    try {
      const events = await source(now);
      return events.sort((a, b) => a.time - b.time).slice(0, 30);
    } catch (e) {
      failures.push(e instanceof Error ? e.message : String(e));
    }
  }
  throw new Error(`일정을 받지 못했습니다(${failures.join(", ")})`);
}
