// Trephemera — eBay API Proxy v3
// Uses Finding API for listing all seller items (no search query needed)
// Uses Browse API only for individual item details (description + full images)

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

        // ── ITEM DETAIL (for modal: full description + images) ──────────────
        const itemId = event.queryStringParameters && event.queryStringParameters.itemId;
        if (itemId) {
            const creds = Buffer.from(`${APP_ID}:${CERT_ID}`).toString('base64');
            const tokenRes = await fetch('https://api.ebay.com/identity/v1/oauth2/token', {
                method: 'POST',
                headers: {
                    'Authorization': `Basic ${creds}`,
                    'Content-Type': 'application/x-www-form-urlencoded'
                },
                body: 'grant_type=client_credentials&scope=https://api.ebay.com/oauth/api_scope'
            });
            const { access_token } = await tokenRes.json();
            const r = await fetch(
                `https://api.ebay.com/buy/browse/v1/item/${encodeURIComponent(itemId)}`,
                { headers: { 'Authorization': `Bearer ${access_token}`, 'X-EBAY-C-MARKETPLACE-ID': 'EBAY_BE' } }
            );
            const item = await r.json();
            const images = [
                item.image?.imageUrl,
                ...(item.additionalImages || []).map(x => x.imageUrl)
            ].filter(Boolean);
            const desc = (item.description || '')
                .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
                .replace(/<[^>]+>/g, ' ')
                .replace(/\s+/g, ' ').trim();
            return { statusCode: 200, headers, body: JSON.stringify({ desc, images }) };
        }

        // ── ALL SELLER LISTINGS via Finding API ──────────────────────────────
        // Finding API does NOT require a search query — perfect for listing all seller items
        // Try Belgium French first, then other sites
        const GLOBAL_IDS = ['EBAY-FRBE', 'EBAY-NL', 'EBAY-FR', 'EBAY-US', 'EBAY-GB', 'EBAY-DE'];

        for (const globalId of GLOBAL_IDS) {
            const params = [
                'OPERATION-NAME=findItemsAdvanced',
                'SERVICE-VERSION=1.0.0',
                `SECURITY-APPNAME=${encodeURIComponent(APP_ID)}`,
                'RESPONSE-DATA-FORMAT=JSON',
                `GLOBAL-ID=${globalId}`,
                `itemFilter(0).name=Seller`,
                `itemFilter(0).value=${encodeURIComponent(SELLER)}`,
                'outputSelector(0)=PictureURLLarge',
                'paginationInput.entriesPerPage=100',
                'paginationInput.pageNumber=1'
            ].join('&');

            const r = await fetch(`https://svcs.ebay.com/services/search/FindingService/v1?${params}`);
            const data = await r.json();

            const response  = data.findItemsAdvancedResponse?.[0];
            const rawItems  = response?.searchResult?.[0]?.item || [];
            const total     = parseInt(response?.paginationOutput?.[0]?.totalEntries?.[0] || '0');

            if (rawItems.length === 0) continue;

            // Fetch page 2 if more than 100 items
            let allRaw = [...rawItems];
            if (total > 100) {
                const params2 = params.replace('pageNumber=1', 'pageNumber=2');
                const r2 = await fetch(`https://svcs.ebay.com/services/search/FindingService/v1?${params2}`);
                const data2 = await r2.json();
                const page2 = data2.findItemsAdvancedResponse?.[0]?.searchResult?.[0]?.item || [];
                allRaw = [...allRaw, ...page2];
            }

            // Transform to the format collections.html expects
            const items = allRaw.map(item => ({
                itemId:           item.itemId?.[0],
                title:            item.title?.[0] || '',
                price: {
                    value:    item.sellingStatus?.[0]?.currentPrice?.[0]?.['__value__'] || '0',
                    currency: item.sellingStatus?.[0]?.currentPrice?.[0]?.['@currencyId'] || 'EUR'
                },
                itemWebUrl:       item.viewItemURL?.[0] || '',
                image:            item.pictureURLLarge?.[0]
                                    ? { imageUrl: item.pictureURLLarge[0] }
                                    : item.galleryURL?.[0]
                                        ? { imageUrl: item.galleryURL[0] }
                                        : null,
                condition:        item.condition?.[0]?.conditionDisplayName?.[0] || 'See Listing',
                shortDescription: ''
            }));

            return { statusCode: 200, headers, body: JSON.stringify(items) };
        }

        // Nothing found on any marketplace
        return { statusCode: 200, headers, body: JSON.stringify([]) };

    } catch (err) {
        console.error(err);
        return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
    }
};
