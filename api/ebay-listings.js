// Trephemera — eBay API Proxy
// Env: EBAY_APP_ID, EBAY_CERT_ID, EBAY_SELLER, EBAY_DEV_ID (optional), EBAY_USER_REFRESH_TOKEN
// Env (persistent sold-item store): UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN
//   — provisioned via Vercel Dashboard → Storage → Marketplace → Upstash for Redis.
//   Vercel KV is deprecated; Upstash is its direct successor and uses the same
//   REST-token model, so no other code here needs to change if you migrate later.

const { Redis } = require('@upstash/redis');

let cachedAppToken = null;
let appTokenExpiry = 0;
let cachedUserToken = null;
let userTokenExpiry = 0;

const TRADING_URL = 'https://api.ebay.com/ws/api.dll';
const SITE_ID = '23'; // eBay Belgium
const OAUTH_SCOPE = process.env.EBAY_OAUTH_SCOPES || 'https://api.ebay.com/oauth/api_scope';

// ── Persistent sold-item store ──────────────────────────────────────────
// Redis holds every sold item we've ever seen, keyed by itemId, plus a set
// ("sold:index") listing every itemId we've stored so we can enumerate them.
// This is what lets sold items keep showing on the site after eBay's
// GetMyeBaySelling SoldList window (60 days) rolls past them.
const SOLD_INDEX_KEY = 'sold:index';
const soldItemKey = (id) => `sold:item:${id}`;

let redis = null;
function getRedis() {
    if (redis) return redis;
    // Vercel's Upstash-for-Redis integration injects KV_REST_API_URL / KV_REST_API_TOKEN
    // (legacy naming kept for backward compatibility with the old Vercel KV product),
    // not the UPSTASH_REDIS_REST_* names Redis.fromEnv() looks for by default — so we
    // point the client at them explicitly. Falls back to the Upstash-native names too,
    // in case the store was provisioned directly through Upstash instead of the
    // Vercel Marketplace.
    const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
    const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
    if (!url || !token) {
        return null; // not configured — caching is skipped, everything still works live-only
    }
    redis = new Redis({ url, token });
    return redis;
}

async function loadCachedSoldItems() {
    const client = getRedis();
    if (!client) return [];
    try {
        const ids = await client.smembers(SOLD_INDEX_KEY);
        if (!ids || !ids.length) return [];
        const items = await Promise.all(ids.map((id) => client.get(soldItemKey(id))));
        return items.filter(Boolean);
    } catch (err) {
        console.error('Redis read failed:', err.message);
        return [];
    }
}

async function persistSoldItems(items) {
    const client = getRedis();
    if (!client || !items.length) return;
    try {
        const pipeline = client.pipeline();
        for (const item of items) {
            if (!item.itemId) continue;
            pipeline.set(soldItemKey(item.itemId), item);
            pipeline.sadd(SOLD_INDEX_KEY, item.itemId);
        }
        await pipeline.exec();
    } catch (err) {
        console.error('Redis write failed:', err.message);
    }
}

// Live sold items win over cached copies of the same item (fresher price/desc/etc.);
// anything only present in the cache (because eBay stopped returning it) is kept as-is.
function dedupeSoldById(cached, live) {
    const map = new Map();
    for (const it of cached) if (it.itemId) map.set(String(it.itemId), it);
    for (const it of live) if (it.itemId) map.set(String(it.itemId), it);
    return [...map.values()];
}

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

// Pulls a named value out of an Item's <ItemSpecifics><NameValueList> block,
// e.g. extractItemSpecific(block, ['Brand','Manufacturer']) -> "Rolex". This is
// the seller-entered item specific straight from eBay, not a guess from the title.
// Some eBay categories (especially paper ephemera / collectibles, as opposed to
// the watches themselves) don't expose a "Brand" aspect at all and use
// "Manufacturer" or nothing instead, so we check a short priority list.
function extractItemSpecific(block, names) {
    const wanted = (Array.isArray(names) ? names : [names]).map(n => n.toLowerCase());
    const found = {};
    const re = /<NameValueList>([\s\S]*?)<\/NameValueList>/gi;
    let m;
    while ((m = re.exec(block || '')) !== null) {
        const n = extractTag(m[1], 'Name');
        if (n) found[n.toLowerCase()] = extractTag(m[1], 'Value');
    }
    for (const name of wanted) if (found[name]) return found[name];
    return '';
}

function legacyIdFromBrowseId(id) {
    const parts = (id || '').split('|');
    return parts.length >= 2 ? parts[1] : id;
}

const BRAND_ASPECT_NAMES = ['Brand', 'Manufacturer', 'Maker'];

// Pulls the "Brand" aspect out of a full Browse API item resource's localizedAspects
// (only present on item/get, not on item_summary/search results). Same fallback
// chain as the Trading API path above.
function extractBrowseBrand(item) {
    const aspects = item.localizedAspects || item.aspects;
    if (Array.isArray(aspects)) {
        for (const name of BRAND_ASPECT_NAMES) {
            const found = aspects.find(a => (a.name || a.localizedName || '').toLowerCase() === name.toLowerCase());
            if (found) {
                const v = found.value || (Array.isArray(found.values) ? found.values[0] : '') || '';
                if (v) return v;
            }
        }
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
        brand: extractItemSpecific(block, BRAND_ASPECT_NAMES),
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
    // Each sold item needs its own Browse/Trading round-trip for full details —
    // doing these one at a time was the main reason the listing endpoint could
    // take many seconds to respond. Fire them all at once instead.
    return Promise.all(
        tradingSold.map(item => enrichSoldItem(item, ebayHeaders, userToken, appId, devId, certId))
    );
}

// Attaches the real eBay "Brand" specific to every active listing (sourced cheaply
// from the bulk Trading API call we already make) and fills in any items missed by
// the 3 Browse category searches. The per-item lookups for missing items run in
// parallel rather than one at a time.
async function enrichActiveListings(active, ebayHeaders, appId, devId, certId) {
    const userToken = await getUserToken(appId, certId);
    if (!userToken) return active;

    const tradingActive = await fetchActiveViaTrading(userToken, appId, devId, certId);
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

    const missing = tradingActive.filter(t => {
        const legacy = legacyIdFromBrowseId(t.itemId);
        return !browseIds.has(t.itemId) && !browseIds.has(legacy);
    });
    const supplemented = await Promise.all(missing.map(async tradingItem => {
        const browseItem = await fetchBrowseItem(ebayHeaders, tradingItem.itemId);
        const enriched = browseItem ? normalizeBrowseItem(browseItem, false) : tradingItem;
        if (!enriched.brand) enriched.brand = tradingItem.brand || '';
        return enriched;
    }));

    return [...active, ...supplemented];
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

            // Not on eBay anymore (item too old / removed) — fall back to our own
            // permanent record for this item, if we stored it while it was sold.
            const client = getRedis();
            if (client) {
                try {
                    const cached = await client.get(soldItemKey(legacyIdFromBrowseId(itemId)))
                        || await client.get(soldItemKey(itemId));
                    if (cached) {
                        const images = [
                            cached.image?.imageUrl,
                            ...(cached.additionalImages || []).map(x => x.imageUrl)
                        ].filter(Boolean);
                        send(200, LIST_CACHE, { desc: cached.shortDescription, images });
                        return;
                    }
                } catch (err) {
                    console.error('Redis fallback read failed:', err.message);
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

        // These two are independent of each other — run them concurrently instead
        // of waiting for active-listing enrichment to finish before even starting
        // the sold-items lookup. Cached (permanently stored) sold items are loaded
        // in parallel too, since they don't depend on either eBay call.
        const [enrichedActive, liveSold, cachedSold] = await Promise.all([
            enrichActiveListings(active, ebayHeaders, APP_ID, DEV_ID, CERT_ID),
            fetchSoldItems(APP_ID, DEV_ID, CERT_ID, ebayHeaders),
            loadCachedSoldItems()
        ]);

        const activeIds = new Set();
        for (const item of enrichedActive) {
            activeIds.add(item.itemId);
            const legacy = legacyIdFromBrowseId(item.itemId);
            if (legacy) activeIds.add(legacy);
        }

        // Persist the freshly-fetched sold items before responding, so they survive
        // once eBay's 60-day SoldList window passes them by. Awaited (not
        // fire-and-forget) because some serverless runtimes can suspend the
        // function as soon as the response is sent.
        await persistSoldItems(liveSold);

        const mergedSold = dedupeSoldById(cachedSold, liveSold)
            .filter(i => !isActiveDuplicate(i, activeIds));

        send(200, LIST_CACHE, [...enrichedActive, ...mergedSold]);

    } catch (err) {
        send(500, 'no-store', { error: err.message });
    }
};
