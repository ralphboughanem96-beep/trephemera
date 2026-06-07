// Trephemera — eBay API Proxy
// Tries multiple marketplaces to find the seller's listings

exports.handler = async (event) => {
    const APP_ID  = process.env.EBAY_APP_ID;
    const CERT_ID = process.env.EBAY_CERT_ID;
    const SELLER  = process.env.EBAY_SELLER || 'trephemera';

    const headers = {
        'Access-Control-Allow-Origin': '*',
        'Content-Type': 'application/json'
    };

    if (event.httpMethod === 'OPTIONS') {
        return { statusCode: 200, headers, body: '' };
    }

    try {
        // Get OAuth token
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
        if (!token) throw new Error('No access token: ' + JSON.stringify(tokenData));

        // If fetching single item details
        const itemId = event.queryStringParameters && event.queryStringParameters.itemId;
        if (itemId) {
            const r = await fetch(
                `https://api.ebay.com/buy/browse/v1/item/${encodeURIComponent(itemId)}`,
                { headers: { 'Authorization': `Bearer ${token}`, 'X-EBAY-C-MARKETPLACE-ID': 'EBAY_BE' } }
            );
            const item = await r.json();
            const images = [
                item.image?.imageUrl,
                ...(item.additionalImages || []).map(x => x.imageUrl)
            ].filter(Boolean);
            const desc = (item.description || '')
                .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
                .replace(/<[^>]+>/g, ' ')
                .replace(/\s+/g, ' ')
                .trim();
            return { statusCode: 200, headers, body: JSON.stringify({ desc, images }) };
        }

        // Try multiple marketplaces — return first one with results
        const MARKETPLACES = ['EBAY_BE', 'EBAY_NL', 'EBAY_FR', 'EBAY_US', 'EBAY_GB', 'EBAY_DE'];

        for (const marketplace of MARKETPLACES) {
            const r = await fetch(
                `https://api.ebay.com/buy/browse/v1/item_summary/search?filter=sellers:${SELLER}&limit=200`,
                {
                    headers: {
                        'Authorization': `Bearer ${token}`,
                        'X-EBAY-C-MARKETPLACE-ID': marketplace
                    }
                }
            );
            const data = await r.json();
            const items = data.itemSummaries || [];
            if (items.length > 0) {
                console.log(`Found ${items.length} items on ${marketplace}`);
                return { statusCode: 200, headers, body: JSON.stringify(items) };
            }
        }

        // Nothing found on any marketplace
        return { statusCode: 200, headers, body: JSON.stringify([]) };

    } catch (err) {
        console.error('eBay function error:', err);
        return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
    }
};
