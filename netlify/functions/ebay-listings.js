// Trephemera — eBay API Proxy
// Credentials are stored safely as Netlify environment variables
// Never exposed in the browser

exports.handler = async (event) => {
    const APP_ID  = process.env.EBAY_APP_ID;
    const CERT_ID = process.env.EBAY_CERT_ID;
    const SELLER  = process.env.EBAY_SELLER || 'trephemera';

    // THE FIX: Added Cache-Control headers to stop Netlify credit drain.
    // 's-maxage=3600' caches the response on Netlify's CDN for 1 hour.
    // Subsequent page loads cost 0 function invocations.
    const headers = {
        'Access-Control-Allow-Origin': '*',
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=300, s-maxage=3600, stale-while-revalidate=86400'
    };

    if (event.httpMethod === 'OPTIONS') {
        return { statusCode: 200, headers, body: '' };
    }

    try {
        // Step 1: Get OAuth token from eBay
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

        if (!token) {
            console.error('Token error:', tokenData);
            throw new Error('Could not get eBay access token');
        }

        const ebayHeaders = {
            'Authorization': `Bearer ${token}`,
            'X-EBAY-C-MARKETPLACE-ID': 'EBAY_BE'
        };

        // Step 2: If itemId is provided, fetch full item details
        const itemId = event.queryStringParameters && event.queryStringParameters.itemId;
        if (itemId) {
            const r = await fetch(
                `https://api.ebay.com/buy/browse/v1/item/${encodeURIComponent(itemId)}`,
                { headers: ebayHeaders }
            );
            const item = await r.json();
            
            // Catch eBay specific API errors
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
                
            return {
                statusCode: 200,
                headers,
                body: JSON.stringify({ desc, images })
            };
        }

        // Step 3: Fetch all seller listings
        // THE FIX: Added 'q=watch OR brochure OR manual' to satisfy eBay's query requirement
        const r = await fetch(
            `https://api.ebay.com/buy/browse/v1/item_summary/search?q=watch OR brochure OR manual&filter=sellers:${SELLER}&limit=200`,
            { headers: ebayHeaders }
        );
        const data = await r.json();

        // Catch eBay specific API errors instead of passing empty data silently
        if (data.errors) throw new Error(data.errors[0].message);

        const items = data.itemSummaries || [];

        return {
            statusCode: 200,
            headers,
            body: JSON.stringify(items)
        };

    } catch (err) {
        console.error('eBay function error:', err);
        return {
            statusCode: 500,
            headers,
            body: JSON.stringify({ error: err.message })
        };
    }
};
