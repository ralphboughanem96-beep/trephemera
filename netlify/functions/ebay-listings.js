// Trephemera — eBay API Proxy
exports.handler = async (event) => {
    const APP_ID  = process.env.EBAY_APP_ID;
    const CERT_ID = process.env.EBAY_CERT_ID;
    const SELLER  = process.env.EBAY_SELLER || 'trephemera';

    // UPDATED: 1-week cache (604,800 seconds) to completely minimize Netlify credit usage
    const headers = {
        'Access-Control-Allow-Origin': '*',
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=300, s-maxage=604800, stale-while-revalidate=86400'
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

        if (!token) throw new Error('Could not get eBay access token');

        const ebayHeaders = {
            'Authorization': `Bearer ${token}`,
            'X-EBAY-C-MARKETPLACE-ID': 'EBAY_BE'
        };

        // Step 2: Handle Single Item Details (for the modal popup)
        const itemId = event.queryStringParameters && event.queryStringParameters.itemId;
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
                
            return { statusCode: 200, headers, body: JSON.stringify({ desc, images }) };
        }

        // Step 3: Fetch the full store using the 3 main categories concurrently
        const categories = ['281', '1', '371'];
        const encodedSellerFilter = `sellers:%7B${SELLER}%7D`; 

        const fetchPromises = categories.map(catId => 
            fetch(
                `https://api.ebay.com/buy/browse/v1/item_summary/search?category_ids=${catId}&filter=${encodedSellerFilter}&limit=200`,
                { headers: ebayHeaders }
            ).then(res => res.json())
        );

        // Wait for all 3 category requests to finish
        const results = await Promise.all(fetchPromises);

        // Combine and deduplicate the items using a Map
        const uniqueItemsMap = new Map();
        for (const data of results) {
            if (data.itemSummaries) {
                for (const item of data.itemSummaries) {
                    uniqueItemsMap.set(item.itemId, item);
                }
            }
        }

        // Convert the Map back into an array to send to your website
        const finalItems = Array.from(uniqueItemsMap.values());

        return {
            statusCode: 200,
            headers,
            body: JSON.stringify(finalItems)
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
