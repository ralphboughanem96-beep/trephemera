// Trephemera — eBay API Proxy (Vercel, raw Node response API for max compatibility)
// Env vars: EBAY_APP_ID, EBAY_CERT_ID, EBAY_SELLER

let cachedToken = null;
let tokenExpiry  = 0;

module.exports = async (req, res) => {
    const APP_ID  = process.env.EBAY_APP_ID;
    const CERT_ID = process.env.EBAY_CERT_ID;
    const SELLER  = process.env.EBAY_SELLER || 'trephemera';

    const LIST_CACHE = 'public, max-age=300, s-maxage=604800, stale-while-revalidate=86400';

    // Raw response helper — uses only methods that always exist on the Node response
    function send(status, cacheControl, payload) {
        res.statusCode = status;
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Cache-Control', cacheControl);
        res.end(JSON.stringify(payload));
    }

    if (req.method === 'OPTIONS') {
        res.statusCode = 200;
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.end();
        return;
    }

    async function getToken() {
        if (cachedToken && Date.now() < tokenExpiry) return cachedToken;
        const creds = Buffer.from(`${APP_ID}:${CERT_ID}`).toString('base64');
        const r = await fetch('https://api.ebay.com/identity/v1/oauth2/token', {
            method: 'POST',
            headers: { 'Authorization': `Basic ${creds}`, 'Content-Type': 'application/x-www-form-urlencoded' },
            body: 'grant_type=client_credentials&scope=https://api.ebay.com/oauth/api_scope'
        });
        const d = await r.json();
        if (!d.access_token) throw new Error('Could not get eBay access token');
        cachedToken = d.access_token;
        tokenExpiry = Date.now() + ((d.expires_in || 7200) - 60) * 1000;
        return cachedToken;
    }

    try {
        const token = await getToken();
        const ebayHeaders = { 'Authorization': `Bearer ${token}`, 'X-EBAY-C-MARKETPLACE-ID': 'EBAY_BE' };

        // Parse itemId straight from the URL (no helper dependency)
        const url = new URL(req.url, 'http://localhost');
        const itemId = url.searchParams.get('itemId');

        // Single item detail (modal popup)
        if (itemId) {
            const r = await fetch(
                `https://api.ebay.com/buy/browse/v1/item/${encodeURIComponent(itemId)}`,
                { headers: ebayHeaders }
            );
            const item = await r.json();
            if (item.errors) throw new Error(item.errors[0].message);
            const images = [
                item.image?.imageUrl,
                ...(item.additionalImages || []).map(x => x.imageUrl)
            ].filter(Boolean);
            const desc = (item.description || '')
                .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
                .replace(/<[^>]+>/g, ' ')
                .replace(/\s+/g, ' ')
                .trim();
            send(200, LIST_CACHE, { desc, images });
            return;
        }

        // Full store: 3 categories, concurrent, deduplicated
        const categories = ['281', '1', '371'];
        const sellerFilter = `sellers:%7B${SELLER}%7D`;
        const results = await Promise.all(categories.map(catId =>
            fetch(
                `https://api.ebay.com/buy/browse/v1/item_summary/search?category_ids=${catId}&filter=${sellerFilter}&limit=200`,
                { headers: ebayHeaders }
            ).then(r => r.json())
        ));

        const unique = new Map();
        for (const data of results) {
            if (data.itemSummaries) {
                for (const item of data.itemSummaries) unique.set(item.itemId, item);
            }
        }

        send(200, LIST_CACHE, Array.from(unique.values()));

    } catch (err) {
        send(500, 'no-store', { error: err.message });
    }
};
