/**
 * Auto-Cuan: Vercel Serverless Function — Yahoo Finance News Feed
 * Fetches real-time stock news headlines via RSS-to-JSON proxy.
 * Supports ticker-specific queries for Indonesian stock market context.
 */

export const config = {
  maxDuration: 15,
};

export default async function handler(req, res) {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(204).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Accept ticker query param, default to IHSG/Indonesian stock news
  const ticker = req.query.ticker || '';
  const query = ticker
    ? `${ticker} saham indonesia`
    : req.query.q || 'IHSG saham indonesia bursa efek';

  try {
    // Primary: Try Yahoo Finance RSS
    const yahooNews = await fetchYahooFinanceRSS(ticker || 'IHSG');
    if (yahooNews.length > 0) {
      return res.status(200).json({ news: yahooNews, source: 'Yahoo Finance' });
    }

    // Fallback: Google News RSS for Indonesian stocks
    const googleNews = await fetchGoogleNewsRSS(query);
    return res.status(200).json({ news: googleNews, source: 'Google News' });

  } catch (error) {
    console.error('news error:', error);
    return res.status(200).json({ news: [], error: error.message });
  }
}

/**
 * Fetch news from Yahoo Finance RSS feed
 */
async function fetchYahooFinanceRSS(ticker) {
  try {
    const url = `https://feeds.finance.yahoo.com/rss/2.0/headline?s=${encodeURIComponent(ticker)}&region=ID&lang=id-ID`;
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      },
      signal: AbortSignal.timeout(8000),
    });

    if (!response.ok) return [];

    const xml = await response.text();
    return parseRSSItems(xml);
  } catch (e) {
    return [];
  }
}

/**
 * Fetch news from Google News RSS (fallback)
 */
async function fetchGoogleNewsRSS(query) {
  try {
    const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=id&gl=ID&ceid=ID:id`;
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      },
      signal: AbortSignal.timeout(8000),
    });

    if (!response.ok) return [];

    const xml = await response.text();
    return parseRSSItems(xml);
  } catch (e) {
    return [];
  }
}

/**
 * Parse RSS XML into structured news items (no external deps)
 */
function parseRSSItems(xml) {
  const items = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/g;
  let match;

  while ((match = itemRegex.exec(xml)) !== null && items.length < 10) {
    const itemXml = match[1];
    const title = extractTag(itemXml, 'title');
    const link = extractTag(itemXml, 'link');
    const pubDate = extractTag(itemXml, 'pubDate');
    const description = extractTag(itemXml, 'description');

    if (title && title.trim()) {
      items.push({
        title: decodeHTMLEntities(title.trim()),
        link: link ? link.trim() : '',
        pubDate: pubDate ? formatDate(pubDate.trim()) : '',
        description: description ? decodeHTMLEntities(description.trim()).slice(0, 150) : '',
      });
    }
  }

  return items;
}

/**
 * Extract text content from an XML tag (handles CDATA)
 */
function extractTag(xml, tag) {
  // CDATA pattern
  const cdataRegex = new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]></${tag}>`, 'i');
  const cdataMatch = xml.match(cdataRegex);
  if (cdataMatch) return cdataMatch[1];

  // Plain text pattern
  const plainRegex = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i');
  const plainMatch = xml.match(plainRegex);
  if (plainMatch) return plainMatch[1];

  // RSS <link> quirk: sometimes appears as plain text after tag
  if (tag === 'link') {
    const linkRegex = /<link[^>]*\/?\s*>\s*(https?:\/\/[^\s<]+)/i;
    const linkMatch = xml.match(linkRegex);
    if (linkMatch) return linkMatch[1];
  }

  return '';
}

/**
 * Decode common HTML entities
 */
function decodeHTMLEntities(str) {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/<[^>]+>/g, ''); // Strip any remaining HTML tags
}

/**
 * Format RSS date to a more readable Indonesian-friendly format
 */
function formatDate(dateStr) {
  try {
    const date = new Date(dateStr);
    if (isNaN(date.getTime())) return dateStr;
    
    const now = new Date();
    const diffMs = now - date;
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMins < 60) return `${diffMins} menit lalu`;
    if (diffHours < 24) return `${diffHours} jam lalu`;
    if (diffDays < 7) return `${diffDays} hari lalu`;

    return date.toLocaleDateString('id-ID', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    });
  } catch {
    return dateStr;
  }
}
