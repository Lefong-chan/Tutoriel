export default async function handler(req, res) {

  if (req.method !== "POST")
    return res.status(405).json({ error: "Method not allowed" });

  res.setHeader("Set-Cookie", `
    token=;
    HttpOnly;
    Secure;
    SameSite=Strict;
    Path=/;
    Max-Age=0
  `.replace(/\s+/g, " ").trim());

  return res.status(200).json({ success: true });
}
