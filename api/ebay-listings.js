// Trephemera — eBay API Proxy
// Env: EBAY_APP_ID, EBAY_CERT_ID, EBAY_SELLER, EBAY_DEV_ID (optional), EBAY_USER_REFRESH_TOKEN

let cachedAppToken = null;
let appTokenExpiry = 0;
let cachedUserToken = null;
let userTokenExpiry = 0;

const TRADING_URL = 'https://api.ebay.com/ws/api.dll';
const SITE_ID = '23'; // eBay Belgium
const OAUTH_SCOPE = process.env.EBAY_OAUTH_SCOPES || 'https://api.ebay.com/oauth/api_scope';

function stripHtml(html) {
    return (html || '')
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function extractTag(xml, tag) {
    const re = new RegExp(`<${tag}[^>]*>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?<\\/${tag}>`, 'i');
    const m = (xml || '').match(re);
    return m ? m[1].trim() : '';
}

function extractAllTags(xml, tag) {
    const re = new RegExp(`<${tag}[^>]*>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?<\\/${tag}>`, 'gi');
    const out = [];
    let m;
    while ((m = re.exec(xml || '')) !== null) out.push(m[1].trim());
    return out;
}

function extractItemBlocks(xml) {
    const items = [];
    const re = /<Item>([\s\S]*?)<\/Item>/gi;
    let m;
    while ((m = re.exec(xml || '')) !== null) items.push(m[1]);
    return items;
}

// Pulls a single named value out of an Item's <ItemSpecifics><NameValueList> block,
// e.g. extractItemSpecific(block, 'Brand') -> "Rolex". This is the seller-entered
// item specific straight from eBay, not a guess from the title.
function extractItemSpecific(block, name) {
    const re = /<NameValueList>([\s\S]*?)<\/NameValueList>/gi;
    let m;
    while ((m = re.exec(block || '')) !== null) {
        const n = extractTag(m[1], 'Name');
        if (n && n.toLowerCase() === name.toLowerCase()) return extractTag(m[1], 'Value');
    }
    return '';
}

function legacyIdFromBrowseId(id) {
    const parts = (id || '').split('|');
    return parts.length >= 2 ? parts[1] : id;
}

// Pulls the "Brand" aspect out of a full Browse API item resource's localizedAspects
// (only present on item/get, not on item_summary/search results).
function extractBrowseBrand(item) {
    const aspects = item.localizedAspects || item.aspects;
    if (Array.isArray(aspects)) {
        const found = aspects.find(a => (a.name || a.localizedName || '').toLowerCase() === 'brand');
        if (found) return found.value || (Array.isArray(found.values) ? found.values[0] : '') || '';
    }
    return '';
}

function normalizeBrowseItem(item, sold = false) {
    const desc = stripHtml(item.description) || item.shortDescription || '';
    return {
        itemId: item.itemId,
        title: item.title,
        price: item.price,
        condition: item.condition,
        image: item.image,
        additionalImages: item.additionalImages || [],
        itemWebUrl: item.itemWebUrl,
        shortDescription: desc,
        brand: extractBrowseBrand(item),
        sold
    };
}

function normalizeTradingSoldItem(block) {
    const itemId = extractTag(block, 'ItemID');
    const pictureUrls = extractAllTags(block, 'PictureURL');
    const galleryUrl = extractTag(block, 'GalleryURL');
    const mainImage = galleryUrl || pictureUrls[0] || '';
    const priceVal = extractTag(block, 'CurrentPrice') || extractTag(block, 'ConvertedCurrentPrice');
    const priceMatch = block.match(/<(?:CurrentPrice|ConvertedCurrentPrice)[^>]*currencyID="([^"]+)"/i);
    const currency = priceMatch ? priceMatch[1] : 'EUR';

    return {
        itemId,
        title: extractTag(block, 'Title'),
        price: priceVal ? { value: priceVal, currency } : null,
        condition: extractTag(block, 'ConditionDisplayName'),
        image: mainImage ? { imageUrl: mainImage } : undefined,
        additionalImages: pictureUrls.filter(u => u !== mainImage).map(url => ({ imageUrl: url })),
        itemWebUrl: extractTag(block, 'ViewItemURL'),
        shortDescription: stripHtml(extractTag(block, 'Description')) || '',
        brand: extractItemSpecific(block, 'Brand'),
        sold: true
    };
}

async function getAppToken(appId, certId) {
    if (cachedAppToken && Date.now() < appTokenExpiry) return cachedAppToken;
    const creds = Buffer.from(`${appId}:${certId}`).toString('base64');
    const r = await fetch('https://api.ebay.com/identity/v1/oauth2/token', {
        method: 'POST',
        headers: { 'Authorization': `Basic ${creds}`, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'grant_type=client_credentials&scope=https://api.ebay.com/oauth/api_scope'
    });
    const d = await r.json();
    if (!d.access_token) throw new Error('Could not get eBay access token');
    cachedAppToken = d.access_token;
    appTokenExpiry = Date.now() + ((d.expires_in || 7200) - 60) * 1000;
    return cachedAppToken;
}

async function getUserToken(appId, certId) {
    const refresh = process.env.EBAY_USER_REFRESH_TOKEN;
    if (!refresh) return null;

    if (cachedUserToken && Date.now() < userTokenExpiry) return cachedUserToken;

    const creds = Buffer.from(`${appId}:${certId}`).toString('base64');
    const r = await fetch('https://api.ebay.com/identity/v1/oauth2/token', {
        method: 'POST',
        headers: { 'Authorization': `Basic ${creds}`, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `grant_type=refresh_token&refresh_token=${encodeURIComponent(refresh)}&scope=${encodeURIComponent(OAUTH_SCOPE)}`
    });
    const d = await r.json();
    if (!d.access_token) return null;

    cachedUserToken = d.access_token;
    userTokenExpiry = Date.now() + ((d.expires_in || 7200) - 60) * 1000;
    return cachedUserToken;
}

async function tradingCall(callName, xml, userToken, appId, devId, certId) {
    const headers = {
        'X-EBAY-API-CALL-NAME': callName,
        'X-EBAY-API-COMPATIBILITY-LEVEL': '967',
        'X-EBAY-API-SITEID': SITE_ID,
        'X-EBAY-API-IAF-TOKEN': userToken,
        'Content-Type': 'text/xml'
    };
    if (devId) headers['X-EBAY-API-DEV-NAME'] = devId;
    if (appId) headers['X-EBAY-API-APP-NAME'] = appId;
    if (certId) headers['X-EBAY-API-CERT-NAME'] = certId;

    const r = await fetch(TRADING_URL, { method: 'POST', headers, body: xml });
    return r.text();
}

async function fetchSoldViaTrading(userToken, appId, devId, certId) {
    const allBlocks = [];
    let page = 1;
    let totalPages = 1;

    while (page <= totalPages) {
        const xml = `<?xml version="1.0" encoding="utf-8"?>
<GetMyeBaySellingRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <DetailLevel>ReturnAll</DetailLevel>
  <SoldList>
    <Include>true</Include>
    <DurationInDays>60</DurationInDays>
    <Pagination>
      <EntriesPerPage>200</EntriesPerPage>
      <PageNumber>${page}</PageNumber>
    </Pagination>
  </SoldList>
</GetMyeBaySellingRequest>`;

        const response = await tradingCall('GetMyeBaySelling', xml, userToken, appId, devId, certId);
        const ack = extractTag(response, 'Ack');
        if (ack !== 'Success' && ack !== 'Warning') return [];

        const soldList = response.match(/<SoldList>([\s\S]*?)<\/SoldList>/i)?.[1] || response;
        allBlocks.push(...extractItemBlocks(soldList));

        const pages = parseInt(extractTag(soldList, 'TotalNumberOfPages'), 10);
        totalPages = Number.isFinite(pages) && pages > 0 ? pages : 1;
        page++;
    }

    return allBlocks.map(normalizeTradingSoldItem).filter(i => i.itemId);
}

async function fetchActiveViaTrading(userToken, appId, devId, certId) {
    const allBlocks = [];
    let page = 1;
    let totalPages = 1;

    while (page <= totalPages) {
        const xml = `<?xml version="1.0" encoding="utf-8"?>
<GetMyeBaySellingRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <DetailLevel>ReturnAll</DetailLevel>
  <ActiveList>
    <Include>true</Include>
    <Pagination>
      <EntriesPerPage>200</EntriesPerPage>
      <PageNumber>${page}</PageNumber>
    </Pagination>
  </ActiveList>
</GetMyeBaySellingRequest>`;

        const response = await tradingCall('GetMyeBaySelling', xml, userToken, appId, devId, certId);
        const ack = extractTag(response, 'Ack');
        if (ack !== 'Success' && ack !== 'Warning') break;

        const activeList = response.match(/<ActiveList>([\s\S]*?)<\/ActiveList>/i)?.[1] || '';
        allBlocks.push(...extractItemBlocks(activeList));

        const pages = parseInt(extractTag(activeList, 'TotalNumberOfPages'), 10);
        totalPages = Number.isFinite(pages) && pages > 0 ? pages : 1;
        page++;
    }

    return allBlocks
        .map(b => { const i = normalizeTradingSoldItem(b); i.sold = false; return i; })
        .filter(i => i.itemId);
}

async function fetchBrowseItem(ebayHeaders, id) {
    const trimmed = (id || '').trim();
    if (!trimmed) return null;

    let r;
    if (trimmed.includes('|')) {
        r = await fetch(
            `https://api.ebay.com/buy/browse/v1/item/${encodeURIComponent(trimmed)}`,
            { headers: ebayHeaders }
        );
    } else {
        r = await fetch(
            `https://api.ebay.com/buy/browse/v1/item/get_item_by_legacy_id?legacy_item_id=${encodeURIComponent(trimmed)}`,
            { headers: ebayHeaders }
        );
    }

    const item = await r.json();
    if (item.errors) return null;
    return item;
}

async function enrichSoldItem(tradingItem, ebayHeaders, userToken, appId, devId, certId) {
    const browseItem = await fetchBrowseItem(ebayHeaders, tradingItem.itemId);
    if (browseItem) {
        const normalized = normalizeBrowseItem(browseItem, true);
        if (!normalized.brand) normalized.brand = tradingItem.brand || '';
        return normalized;
    }

    if (userToken && !tradingItem.shortDescription) {
        const getItemXml = `<?xml version="1.0" encoding="utf-8"?>
<GetItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <ItemID>${tradingItem.itemId}</ItemID>
  <DetailLevel>ReturnAll</DetailLevel>
</GetItemRequest>`;
        const response = await tradingCall('GetItem', getItemXml, userToken, appId, devId, certId);
        if (extractTag(response, 'Ack') === 'Success') {
            const block = response.match(/<Item>([\s\S]*?)<\/Item>/i)?.[1];
            if (block) return normalizeTradingSoldItem(block);
        }
    }

    return tradingItem;
}

async function fetchSoldItems(appId, devId, certId, ebayHeaders) {
    const userToken = await getUserToken(appId, certId);
    if (!userToken) return [];

    const tradingSold = await fetchSoldViaTrading(userToken, appId, devId, certId);
    const sold = [];
    for (const item of tradingSold) {
        sold.push(await enrichSoldItem(item, ebayHeaders, userToken, appId, devId, certId));
    }
    return sold;
}

function isActiveDuplicate(soldItem, activeIds) {
    if (activeIds.has(soldItem.itemId)) return true;
    const legacy = legacyIdFromBrowseId(soldItem.itemId);
    if (legacy && activeIds.has(legacy)) return true;
    return false;
}

module.exports = async (req, res) => {
    const APP_ID  = process.env.EBAY_APP_ID;
    const CERT_ID = process.env.EBAY_CERT_ID;
    const DEV_ID  = process.env.EBAY_DEV_ID || '';
    const SELLER  = process.env.EBAY_SELLER || 'trephemera';

    const LIST_CACHE = 'public, max-age=300, s-maxage=604800, stale-while-revalidate=86400';

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

    try {
        const token = await getAppToken(APP_ID, CERT_ID);
        const ebayHeaders = { 'Authorization': `Bearer ${token}`, 'X-EBAY-C-MARKETPLACE-ID': 'EBAY_BE' };

        const url = new URL(req.url, 'http://localhost');
        const itemId = url.searchParams.get('itemId');

        if (itemId) {
            const browseItem = await fetchBrowseItem(ebayHeaders, itemId);
            if (browseItem) {
                const images = [
                    browseItem.image?.imageUrl,
                    ...(browseItem.additionalImages || []).map(x => x.imageUrl)
                ].filter(Boolean);
                send(200, LIST_CACHE, { desc: stripHtml(browseItem.description), images });
                return;
            }

            const userToken = await getUserToken(APP_ID, CERT_ID);
            const legacyId = legacyIdFromBrowseId(itemId);
            if (userToken && legacyId) {
                const getItemXml = `<?xml version="1.0" encoding="utf-8"?>
<GetItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <ItemID>${legacyId}</ItemID>
  <DetailLevel>ReturnAll</DetailLevel>
</GetItemRequest>`;
                const response = await tradingCall('GetItem', getItemXml, userToken, APP_ID, DEV_ID, CERT_ID);
                if (extractTag(response, 'Ack') === 'Success') {
                    const block = response.match(/<Item>([\s\S]*?)<\/Item>/i)?.[1];
                    if (block) {
                        const normalized = normalizeTradingSoldItem(block);
                        const images = [
                            normalized.image?.imageUrl,
                            ...normalized.additionalImages.map(x => x.imageUrl)
                        ].filter(Boolean);
                        send(200, LIST_CACHE, { desc: normalized.shortDescription, images });
                        return;
                    }
                }
            }

            throw new Error('Item not found');
        }

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

        const active = Array.from(unique.values());

        // Supplement Browse API results with Trading API active list to catch any
        // items in categories not covered by the 3 Browse searches, and — since
        // Trading API already returns each item's ItemSpecifics in the same bulk
        // call — use it to attach the seller's actual "Brand" specific to every
        // active item instead of guessing the brand from the title.
        const userToken = await getUserToken(APP_ID, CERT_ID);
        if (userToken) {
            const tradingActive = await fetchActiveViaTrading(userToken, APP_ID, DEV_ID, CERT_ID);
            const tradingByLegacy = new Map();
            for (const t of tradingActive) if (t.itemId) tradingByLegacy.set(String(t.itemId), t);

            const browseIds = new Set();
            for (const item of active) {
                browseIds.add(item.itemId);
                const legacy = legacyIdFromBrowseId(item.itemId);
                if (legacy) browseIds.add(legacy);
                const match = tradingByLegacy.get(String(legacy)) || tradingByLegacy.get(String(item.itemId));
                if (match && match.brand) item.brand = match.brand;
            }
            for (const tradingItem of tradingActive) {
                const legacy = legacyIdFromBrowseId(tradingItem.itemId);
                if (!browseIds.has(tradingItem.itemId) && !browseIds.has(legacy)) {
                    const browseItem = await fetchBrowseItem(ebayHeaders, tradingItem.itemId);
                    const enriched = browseItem ? normalizeBrowseItem(browseItem, false) : tradingItem;
                    if (!enriched.brand) enriched.brand = tradingItem.brand || '';
                    active.push(enriched);
                }
            }
        }

        const sold = await fetchSoldItems(APP_ID, DEV_ID, CERT_ID, ebayHeaders);

        const activeIds = new Set();
        for (const item of active) {
            activeIds.add(item.itemId);
            const legacy = legacyIdFromBrowseId(item.itemId);
            if (legacy) activeIds.add(legacy);
        }

        const soldOnly = sold.filter(i => !isActiveDuplicate(i, activeIds));

        send(200, LIST_CACHE, [...active, ...soldOnly]);

    } catch (err) {
        send(500, 'no-store', { error: err.message });
    }
};
