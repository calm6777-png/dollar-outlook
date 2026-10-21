// 환율 관련 최신 기사 제목. Bing 뉴스 RSS를 먼저 쓰고, 안 되면 Google 뉴스 RSS로 대신합니다
// (Google은 Cloudflare 서버에서 오는 요청을 한참 끌다가 503으로 거절할 때가 많습니다).

export interface NewsItem {
  title: string;
  source: string;
  link: string;
  time: number; // ms
}

const QUERY = encodeURIComponent("원달러 환율");
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36";

const FEEDS = [
  { name: "Bing", url: `https://www.bing.com/news/search?q=${QUERY}&format=rss&setlang=ko-KR&cc=KR`, sourceTag: "News:Source" },
  { name: "Google", url: `https://news.google.com/rss/search?q=${QUERY}&hl=ko&gl=KR&ceid=KR:ko`, sourceTag: "source" },
];

export async function fetchNews(limit = 8): Promise<NewsItem[]> {
  const failures: string[] = [];
  for (const feed of FEEDS) {
    try {
      const res = await fetch(feed.url, { headers: { "User-Agent": UA, Accept: "application/rss+xml, application/xml" },
        signal: AbortSignal.timeout(4000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const items = parseRss(await res.text(), limit, feed.sourceTag);
      if (items.length) return items;
      throw new Error("기사 없음");
    } catch (e) {
      failures.push(`${feed.name} ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  throw new Error(`뉴스를 받지 못했습니다(${failures.join(", ")})`);
}

export function parseRss(xml: string, limit: number, sourceTag = "source"): NewsItem[] {
  const items: NewsItem[] = [];
  const seen = new Set<string>();
  for (const chunk of xml.split("<item>").slice(1)) {
    const source = decode(tag(chunk, sourceTag));
    let title = decode(tag(chunk, "title"));
    if (source && title.endsWith(` - ${source}`)) title = title.slice(0, -(source.length + 3));
    const link = articleUrl(decode(tag(chunk, "link")));
    const time = Date.parse(tag(chunk, "pubDate"));
    if (!title || !link.startsWith("http") || seen.has(title)) continue;
    seen.add(title);
    items.push({ title, source, link, time: Number.isFinite(time) ? time : 0 });
  }
  return items.sort((a, b) => b.time - a.time).slice(0, limit);
}

// Bing은 클릭 집계용 주소로 감싸 주므로 원래 기사 주소를 꺼냅니다.
function articleUrl(link: string): string {
  try {
    const u = new URL(link);
    const inner = u.hostname.endsWith("bing.com") ? u.searchParams.get("url") : null;
    return inner && /^https?:\/\//.test(inner) ? inner : link;
  } catch {
    return link;
  }
}

function tag(chunk: string, name: string): string {
  const m = chunk.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`));
  return m ? m[1].replace(/^<!\[CDATA\[|\]\]>$/g, "").trim() : "";
}

function decode(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}
