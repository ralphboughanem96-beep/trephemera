// Trephemera — eBay API Proxy v2 (debug)
exports.handler = async (event) => {
    const APP_ID  = process.env.EBAY_APP_ID;
    const CERT_ID = process.env.EBAY_CERT_ID;
    const SELLER  = process.env.EBAY_SELLER || 'trephemera';
    const DEBUG   = event.queryStringParameters?.debug === '1';

    const headers = {
        'Access-Control-Allow-Origin': '*',
        'Content-Type': 'application/json'
    };

    if (event.httpMethod === 'OPTIONS') {
        return { statusCode: 200, headers, body: '' };
    }

    const log = [];

    try {
        // Step 1: Get token
        const creds = Buffer.from(`${APP_ID}:${CERT_ID}`).toString('base64');
        const tokenRes = await fetch('https://api.ebay.com/identity/v1/oauth2/token', {
            method: 'POST',
            headers: {
                'Authorization': `Basic ${creds}`,
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: 'grant_type=client_credentials&scope=https://api.ebay.com/oauth/api_scope'
        });
        const tokenData = await tokenRes.json();
        const token = tokenData.access_token;

        log.push({ step: 'token', success: !!token, error: token ? null : tokenData });
        if (!token) {
            return { statusCode: 500, headers, body: JSON.stringify({ version: 'v2', log }) };
        }

        // Step 2: If fetching single item
        const itemId = event.queryStringParameters?.itemId;
        if (itemId) {
            const r = await fetch(
                `https://api.ebay.com/buy/browse/v1/item/${encodeURIComponent(itemId)}`,
                { headers: { 'Authorization': `Bearer ${token}`, 'X-EBAY-C-MARKETPLACE-ID': 'EBAY_BE' } }
            );
            const item = await r.json();
            const images = [item.image?.imageUrl, ...(item.additionalImages || []).map(x => x.imageUrl)].filter(Boolean);
            const desc = (item.description || '')
                .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
                .replace(/<[^>]+>/g, ' ')
                .replace(/\s+/g, ' ').trim();
            return { statusCode: 200, headers, body: JSON.stringify({ desc, images }) };
        }

        // Step 3: Try each marketplace
        const MARKETPLACES = ['EBAY_BE', 'EBAY_NL', 'EBAY_FR', 'EBAY_US', 'EBAY_GB', 'EBAY_DE'];

        for (const marketplace of MARKETPLACES) {
            const url = `https://api.ebay.com/buy/browse/v1/item_summary/search?filter=sellers:${SELLER}&limit=200`;
            const r = await fetch(url, {
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'X-EBAY-C-MARKETPLACE-ID': marketplace
                }
            });
            const data = await r.json();
            const items = data.itemSummaries || [];
            const count = items.length;

            log.push({
                marketplace,
                itemCount: count,
                total: data.total,
                warnings: data.warnings,
                error: data.errors || null
            });

            if (count > 0) {
                if (DEBUG) return { statusCode: 200, headers, body: JSON.stringify({ version: 'v2', found: marketplace, count, log }) };
                return { statusCode: 200, headers, body: JSON.stringify(items) };
            }
        }

        // Nothing found — return debug info always so we can diagnose
        return { statusCode: 200, headers, body: JSON.stringify({ version: 'v2', found: 'none', seller: SELLER, log }) };

    } catch (err) {
        return { statusCode: 500, headers, body: JSON.stringify({ version: 'v2', error: err.message, log }) };
    }
};
