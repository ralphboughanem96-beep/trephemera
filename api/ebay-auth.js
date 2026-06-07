// One-time OAuth helper — connect your eBay seller account and get a refresh token.
// Env: EBAY_APP_ID, EBAY_CERT_ID, EBAY_RUNAME (RuName from eBay Developer Portal)
// Set RuName Auth Accepted URL to: https://trephemera.com/api/ebay-auth

const OAUTH_SCOPE = process.env.EBAY_OAUTH_SCOPES || 'https://api.ebay.com/oauth/api_scope';

module.exports = async (req, res) => {
    const APP_ID = process.env.EBAY_APP_ID;
    const CERT_ID = process.env.EBAY_CERT_ID;
    const RUNAME = process.env.EBAY_RUNAME;

    res.setHeader('Content-Type', 'text/html; charset=utf-8');

    if (!APP_ID || !CERT_ID || !RUNAME) {
        res.statusCode = 500;
        res.end('<h1>Missing config</h1><p>Set EBAY_APP_ID, EBAY_CERT_ID, and EBAY_RUNAME in Vercel.</p>');
        return;
    }

    const url = new URL(req.url, 'http://localhost');
    const code = url.searchParams.get('code');

    if (!code) {
        const authUrl = `https://auth.ebay.com/oauth2/authorize?client_id=${encodeURIComponent(APP_ID)}&response_type=code&redirect_uri=${encodeURIComponent(RUNAME)}&scope=${encodeURIComponent(OAUTH_SCOPE)}&prompt=login`;
        res.end(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Connect eBay</title>
<style>body{font-family:Georgia,serif;max-width:560px;margin:60px auto;padding:0 24px;color:#0a1520}
a{color:#9c744b}code{background:#f0e6d8;padding:2px 6px}</style></head><body>
<h1>Connect your eBay seller account</h1>
<p>This one-time step lets the site automatically load your <strong>sold items</strong> via the eBay Trading API.</p>
<p><a href="${authUrl}">Sign in with eBay</a></p>
<p>After signing in, you will be redirected back here with a refresh token to add to Vercel as <code>EBAY_USER_REFRESH_TOKEN</code>.</p>
</body></html>`);
        return;
    }

    try {
        const creds = Buffer.from(`${APP_ID}:${CERT_ID}`).toString('base64');
        const r = await fetch('https://api.ebay.com/identity/v1/oauth2/token', {
            method: 'POST',
            headers: { 'Authorization': `Basic ${creds}`, 'Content-Type': 'application/x-www-form-urlencoded' },
            body: `grant_type=authorization_code&code=${encodeURIComponent(code)}&redirect_uri=${encodeURIComponent(RUNAME)}`
        });
        const d = await r.json();

        if (!d.refresh_token) {
            res.statusCode = 500;
            res.end(`<h1>Authorization failed</h1><pre>${JSON.stringify(d, null, 2)}</pre>`);
            return;
        }

        res.end(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>eBay connected</title>
<style>body{font-family:Georgia,serif;max-width:640px;margin:60px auto;padding:0 24px;color:#0a1520}
pre{background:#f0e6d8;padding:16px;overflow:auto;word-break:break-all}ol{line-height:1.8}</style></head><body>
<h1>eBay account connected</h1>
<p>Add this value in Vercel → Settings → Environment Variables:</p>
<p><strong>Name:</strong> <code>EBAY_USER_REFRESH_TOKEN</code></p>
<pre>${d.refresh_token}</pre>
<ol>
<li>Copy the token above</li>
<li>Paste it into Vercel as <code>EBAY_USER_REFRESH_TOKEN</code></li>
<li>Redeploy the site</li>
<li>Your sold items will appear automatically in the collection</li>
</ol>
</body></html>`);
    } catch (err) {
        res.statusCode = 500;
        res.end(`<h1>Error</h1><p>${err.message}</p>`);
    }
};
