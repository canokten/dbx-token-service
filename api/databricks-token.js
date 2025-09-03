// Vercel Node function: issues a user-scoped Databricks token for external embedding
export default async function handler(req, res) {
  // ---- CORS (allow only your GitHub Pages origin) ----
  const ORIGIN = req.headers.origin || "";
  const ALLOWED = process.env.ALLOWED_ORIGIN || "";
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Origin", ALLOWED);
    res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization");
    res.status(204).end();
    return;
  }
  if (ORIGIN !== ALLOWED) {
    res.status(403).json({ error: "Origin not allowed" });
    return;
  }
  res.setHeader("Access-Control-Allow-Origin", ALLOWED);
  res.setHeader("Content-Type", "application/json");

  try {
    const {
      INSTANCE_URL,            // e.g. https://xxx.databricks.com
      WORKSPACE_ID,            // numeric id from ?o=######## in URL (or "0")
      DASHBOARD_ID,            // Lakeview/AI/BI dashboard id
      SERVICE_PRINCIPAL_ID,    // app (client) id
      SERVICE_PRINCIPAL_SECRET // client secret
    } = process.env;

    const viewer = (req.query.viewer || "anon") + "";   // optional context
    const value  = (req.query.val    || "public") + "";

    // 1) Get OIDC "all-apis" token via service principal
    const basic = Buffer.from(`${SERVICE_PRINCIPAL_ID}:${SERVICE_PRINCIPAL_SECRET}`).toString("base64");
    const oidcResp = await fetch(`${INSTANCE_URL}/oidc/v1/token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Authorization": `Basic ${basic}`,
      },
      body: new URLSearchParams({ grant_type: "client_credentials", scope: "all-apis" }),
    });
    if (!oidcResp.ok) throw new Error(`OIDC token error: ${oidcResp.status} ${await oidcResp.text()}`);
    const { access_token: oidcToken } = await oidcResp.json();

    // 2) Request tokeninfo for this dashboard/viewer
    const tokenInfoUrl = new URL(`${INSTANCE_URL}/api/2.0/lakeview/dashboards/${DASHBOARD_ID}/published/tokeninfo`);
    tokenInfoUrl.searchParams.set("external_viewer_id", viewer);
    tokenInfoUrl.searchParams.set("external_value", value);

    const tiResp = await fetch(tokenInfoUrl.toString(), { headers: { Authorization: `Bearer ${oidcToken}` } });
    if (!tiResp.ok) throw new Error(`tokeninfo error: ${tiResp.status} ${await tiResp.text()}`);
    const tokenInfo = await tiResp.json();

    // 3) Exchange for a down-scoped token (safe for browser)
    const { authorization_details, ...params } = tokenInfo;
    const scopedResp = await fetch(`${INSTANCE_URL}/oidc/v1/token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Authorization": `Basic ${basic}`,
      },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        ...params,
        authorization_details: JSON.stringify(authorization_details),
      }),
    });
    if (!scopedResp.ok) throw new Error(`Down-scoped token error: ${scopedResp.status} ${await scopedResp.text()}`);
    const { access_token } = await scopedResp.json();

    res.status(200).json({
      token: access_token,
      instanceUrl: INSTANCE_URL,
      workspaceId: WORKSPACE_ID,
      dashboardId: DASHBOARD_ID,
      external_viewer_id: viewer,
      external_value: value,
    });
  } catch (e) {
    res.status(500).json({ error: e.message || String(e) });
  }
}

