/**
 * Auto-Cuan: Vercel Serverless Function — Stock News & Corporate Actions
 * Fetches real-time news via Yahoo Finance RSS and Google News RSS fallback.
 * Supports ticker-specific queries.
 */

export const config = {
  maxDuration: 15,
};

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(204).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const ticker = req.query.ticker || '';
  const query = ticker
    ? `${ticker} saham corporate action dividen`
    : req.query.q || 'IHSG saham indonesia bursa efek';

  try {
    // Try Yahoo Finance RSS first
    if (ticker) {
      const yahooNews = await fetchYahooRSS(ticker);
      if (yahooNews.length > 0) {
        return res.status(200).json({ news: yahooNews, source: 'Yahoo Finance', ticker });
      }
    }

    // Fallback: Google News RSS
    const googleNews = await fetchGoogleNewsRSS(query);
    return res.status(200).json({ news: googleNews, source: 'Google News', ticker: ticker || 'IHSG' });
  } catch (error) {
    console.error('news error:', error);
    return res.status(200).json({ news: [], error: error.message });
  }
}

async function fetchYahooRSS(ticker) {
  try {
    // Yahoo Finance RSS for specific ticker
    const url = `https://feeds.finance.yahoo.com/rss/2.0/headline?s=${encodeURIComponent(ticker)}&region=ID&lang=id-ID`;
    const response = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) return [];
    const xml = await response.text();
    return parseRSS(xml);
  } catch {
    return [];
  }
}

async function fetchGoogleNewsRSS(query) {
  try {
    const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=id&gl=ID&ceid=ID:id`;
    const response = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) return [];
    const xml = await response.text();
    return parseRSS(xml);
  } catch {
    return [];
  }
}

function parseRSS(xml) {
  const items = [];
  const regex = /<item>([\s\S]*?)<\/item>/g;
  let match;
  while ((match = regex.exec(xml)) !== null && items.length < 10) {
    const block = match[1];
    const title = getTag(block, 'title');
    const link = getTag(block, 'link');
    const pubDate = getTag(block, 'pubDate');
    const desc = getTag(block, 'description');
    if (title && title.trim()) {
      items.push({
        title: cleanHtml(title.trim()),
        link: link ? link.trim() : '#',
        pubDate: pubDate ? relativeTime(pubDate.trim()) : '',
        description: desc ? cleanHtml(desc.trim()).slice(0, 120) : '',
      });
    }
  }
  return items;
}

function getTag(xml, tag) {
  const cdata = new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]></${tag}>`, 'i');
  const cm = xml.match(cdata);
  if (cm) return cm[1];
  const plain = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i');
  const pm = xml.match(plain);
  if (pm) return pm[1];
  if (tag === 'link') {
    const lm = xml.match(/<link[^>]*\/?\s*>\s*(https?:\/\/[^\s<]+)/i);
    if (lm) return lm[1];
  }
  return '';
}

function cleanHtml(str) {
  return str.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

function relativeTime(dateStr) {
  try {
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return dateStr;
    const diff = Date.now() - d.getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 60) return `${mins} menit lalu`;
    const hrs = Math.floor(diff / 3600000);
    if (hrs < 24) return `${hrs} jam lalu`;
    const days = Math.floor(diff / 86400000);
    if (days < 7) return `${days} hari lalu`;
    return d.toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: 'numeric' });
  } catch {
    return dateStr;
  }
}
