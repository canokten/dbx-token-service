// api/databricks-token.js
export default async function handler(req, res) {
  const ORIGIN = req.headers.origin || "";
  const ALLOWED = process.env.ALLOWED_ORIGIN || "";
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Origin", ALLOWED);
    res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization");
    res.status(204).end(); return;
  }
  if (ORIGIN !== ALLOWED) {
    res.status(403).json({ error: "Origin not allowed" }); return;
  }
  res.setHeader("Access-Control-Allow-Origin", ALLOWED);
  res.setHeader("Content-Type", "application/json");

  try {
    const {
      INSTANCE_URL,
      WORKSPACE_ID,
      SERVICE_PRINCIPAL_ID,
      SERVICE_PRINCIPAL_SECRET,
      DASHBOARD_ALLOWLIST // comma-separated IDs
    } = process.env;

    const dashboardId = (req.query.dashboard || "").trim();
    if (!dashboardId) throw new Error("Missing ?dashboard=<dashboard_id>");

    const allowed = (DASHBOARD_ALLOWLIST || "")
      .split(",").map(s => s.trim()).filter(Boolean);
    if (!allowed.includes(dashboardId)) throw new Error("Dashboard not allowed");

    const external_viewer_id = (req.query.viewer || "public") + "";
    const external_value    = (req.query.val    || "na") + "";

    const basic = Buffer.from(
      `${SERVICE_PRINCIPAL_ID}:${SERVICE_PRINCIPAL_SECRET}`
    ).toString("base64");

    // 1) OIDC all-apis
    const oidcResp = await fetch(`${INSTANCE_URL}/oidc/v1/token`, {
      method: "POST",
      headers: { "Content-Type":"application/x-www-form-urlencoded", "Authorization":`Basic ${basic}` },
      body: new URLSearchParams({ grant_type:"client_credentials", scope:"all-apis" })
    });
    if (!oidcResp.ok) throw new Error(`OIDC token error: ${oidcResp.status} ${await oidcResp.text()}`);
    const { access_token: oidcToken } = await oidcResp.json();

    // 2) tokeninfo for the chosen dashboard
    const ti = new URL(`${INSTANCE_URL}/api/2.0/lakeview/dashboards/${dashboardId}/published/tokeninfo`);
    ti.searchParams.set("external_viewer_id", external_viewer_id);
    ti.searchParams.set("external_value", external_value);

    const tiResp = await fetch(ti, { headers: { Authorization:`Bearer ${oidcToken}` }});
    if (!tiResp.ok) throw new Error(`tokeninfo error: ${tiResp.status} ${await tiResp.text()}`);
    const tokenInfo = await tiResp.json();

    // 3) down-scoped token
    const { authorization_details, ...params } = tokenInfo;
    const scopedResp = await fetch(`${INSTANCE_URL}/oidc/v1/token`, {
      method: "POST",
      headers: { "Content-Type":"application/x-www-form-urlencoded", "Authorization":`Basic ${basic}` },
      body: new URLSearchParams({
        grant_type:"client_credentials",
        ...params,
        authorization_details: JSON.stringify(authorization_details),
      })
    });
    if (!scopedResp.ok) throw new Error(`Down-scoped token error: ${scopedResp.status} ${await scopedResp.text()}`);
    const { access_token } = await scopedResp.json();

    res.status(200).json({
      token: access_token,
      instanceUrl: INSTANCE_URL,
      workspaceId: WORKSPACE_ID,
      dashboardId,
      external_viewer_id,
      external_value
    });
  } catch (e) {
    res.status(500).json({ error: e.message || String(e) });
  }
}
