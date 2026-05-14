/**
 * Auto-Cuan: Vercel Serverless Function - News Feed
 * Fetches Indonesian stock market news from Google News RSS.
 */

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const query = req.query.q || 'IHSG saham indonesia';

  try {
    const rssUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(query + ' saham indonesia')}&hl=id&gl=ID&ceid=ID:id`;

    const rssRes = await fetch(rssUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      },
    });

    if (!rssRes.ok) {
      return res.status(200).json({ news: [], error: 'Failed to fetch news' });
    }

    const xml = await rssRes.text();

    // Simple XML parsing for RSS items (no external deps needed)
    const items = [];
    const itemRegex = /<item>([\s\S]*?)<\/item>/g;
    let match;

    while ((match = itemRegex.exec(xml)) !== null && items.length < 8) {
      const itemXml = match[1];

      const title = extractTag(itemXml, 'title');
      const link = extractTag(itemXml, 'link');
      const pubDate = extractTag(itemXml, 'pubDate');

      if (title) {
        items.push({ title, link: link || '', pubDate: pubDate || '' });
      }
    }

    return res.status(200).json({ news: items });
  } catch (error) {
    console.error('news error:', error);
    return res.status(200).json({ news: [], error: error.message });
  }
}

/**
 * Extract text content from a simple XML tag.
 */
function extractTag(xml, tag) {
  // Handle CDATA sections
  const cdataRegex = new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]></${tag}>`);
  const cdataMatch = xml.match(cdataRegex);
  if (cdataMatch) return cdataMatch[1].trim();

  // Handle plain text
  const plainRegex = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`);
  const plainMatch = xml.match(plainRegex);
  if (plainMatch) return plainMatch[1].trim();

  // Handle self-closed followed by text (RSS <link> quirk)
  if (tag === 'link') {
    const linkRegex = /<link\s*\/?>([^<\s]+)/;
    const linkMatch = xml.match(linkRegex);
    if (linkMatch) return linkMatch[1].trim();
  }

  return '';
}
