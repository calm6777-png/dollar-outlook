// Worker: 시세·일정·뉴스를 대신 받아 캐시해 두는 얇은 중계 서버입니다.
// 무거운 계산은 브라우저에서 합니다(무료 플랜 CPU 10ms 한도 안에 들도록 응답을 해석하지 않고 이어 붙이기만 함).
import { ALL_SYMBOLS } from "../lib/outlook.ts";
import { fetchCalendar } from "./calendar.ts";
import { fetchNews } from "./news.ts";

const PLANS = {
  hist: { range: "1y", interval: "60m", ttl: 1800 },
  live: { range: "5d", interval: "15m", ttl: 45 },
} as const;
type Plan = keyof typeof PLANS;

const HOSTS = ["https://query1.finance.yahoo.com", "https://query2.finance.yahoo.com"];
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36";

interface Entry {
  at: number;
  value: unknown;
}

// 같은 Worker 인스턴스 안에서 재사용하는 메모리 캐시. 갱신에 실패하면 마지막 값을 대신 씁니다.
const memo = new Map<string, Entry>();
const pending = new Map<string, Promise<unknown>>();

async function cached<T>(key: string, ttlSec: number, load: () => Promise<T>): Promise<T> {
  const hit = memo.get(key);
  if (hit && Date.now() - hit.at < ttlSec * 1000) return hit.value as T;
  let job = pending.get(key) as Promise<T> | undefined;
  if (!job) {
    job = load().finally(() => pending.delete(key));
    pending.set(key, job);
  }
  try {
    const value = await job;
    memo.set(key, { at: Date.now(), value });
    return value;
  } catch (error) {
    if (hit) return hit.value as T;
    throw error;
  }
}

async function yahoo(sym: string, plan: Plan): Promise<string> {
  const { range, interval, ttl } = PLANS[plan];
  let last: unknown;
  for (const host of HOSTS) {
    try {
      const url = `${host}/v8/finance/chart/${encodeURIComponent(sym)}?range=${range}&interval=${interval}&includePrePost=false`;
      const res = await fetch(url, {
        headers: { "User-Agent": UA, Accept: "application/json" },
        cf: { cacheTtl: ttl, cacheEverything: true },
      });
      const text = await res.text();
      if (!res.ok || !text.startsWith('{"chart":{"result":[')) throw new Error(`${sym} HTTP ${res.status}`);
      return text;
    } catch (e) {
      last = e;
    }
  }
  throw last instanceof Error ? last : new Error(String(last));
}

// {"KRW=X":{"chart":...},"DX-Y.NYB":null,...} 형태로, Yahoo 응답을 해석하지 않고 그대로 이어 붙입니다.
async function marketBundle(plan: Plan): Promise<string> {
  const parts = await Promise.all(
    ALL_SYMBOLS.map(async (sym) => {
      const body = await cached(`${plan}:${sym}`, PLANS[plan].ttl, () => yahoo(sym, plan)).catch(() => "null");
      return `${JSON.stringify(sym)}:${body}`;
    }),
  );
  return `{${parts.join(",")}}`;
}

function respond(body: string, maxAge: number, status = 200): Response {
  return new Response(body, {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": status === 200 ? `public, max-age=${maxAge}` : "no-store",
    },
  });
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    try {
      switch (url.pathname) {
        case "/api/market": {
          const plan: Plan = url.searchParams.get("p") === "hist" ? "hist" : "live";
          const body = await marketBundle(plan);
          if (body.includes(`${JSON.stringify(ALL_SYMBOLS[0])}:null`)) throw new Error("달러/원 시세 응답 없음");
          return respond(body, plan === "hist" ? 900 : 30);
        }
        case "/api/calendar":
          return respond(JSON.stringify(await cached("calendar", 3600, () => fetchCalendar())), 600);
        case "/api/news":
          return respond(JSON.stringify(await cached("news", 600, () => fetchNews())), 300);
        default:
          return respond(JSON.stringify({ error: "없는 경로입니다." }), 0, 404);
      }
    } catch (e) {
      return respond(JSON.stringify({ error: message(e) }), 0, 502);
    }
  },
} satisfies ExportedHandler;
