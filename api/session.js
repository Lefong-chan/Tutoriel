import admin from "firebase-admin";
import jwt from "jsonwebtoken";

/* ================= ENV ================= */

const SECRET = process.env.JWT_SECRET;

if (!SECRET) throw new Error("JWT_SECRET not set");
if (!process.env.FIREBASE_KEY)
  throw new Error("FIREBASE_KEY not set");

/* ================= FIREBASE INIT ================= */

if (!admin.apps.length) {
  const serviceAccount = JSON.parse(process.env.FIREBASE_KEY);

  if (serviceAccount.private_key) {
    serviceAccount.private_key =
      serviceAccount.private_key.replace(/\\n/g, "\n");
  }

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL:
      "https://tutoriel-ff487-default-rtdb.firebaseio.com/"
  });
}

const db = admin.database();

/* ================= TOKEN HELPER ================= */

function getTokenFromCookie(req) {
  const cookieHeader = req.headers.cookie;
  if (!cookieHeader) return null;

  const cookies = cookieHeader.split(";").map(c => c.trim());

  for (let c of cookies) {
    if (c.startsWith("token=")) {
      return c.substring("token=".length);
    }
  }

  return null;
}

/* ================= MAIN HANDLER ================= */

export default async function handler(req, res) {

  /* ================= ME (GET) ================= */
  if (req.method === "GET") {
    try {

      const token = getTokenFromCookie(req);

      if (!token)
        return res.status(401).json({ error: "Not authenticated" });

      const decoded = jwt.verify(token, SECRET);

      const snap = await db.ref("users/" + decoded.uid).get();

      if (!snap.exists())
        return res.status(404).json({ error: "User not found" });

      const userData = snap.val();

      return res.status(200).json({
        uid: userData.uid,
        email: userData.email || null,
        phone: userData.phone || null,
        provider: userData.provider
      });

    } catch (err) {
      return res.status(401).json({
        error: "Invalid or expired session"
      });
    }
  }

  /* ================= LOGOUT (POST) ================= */
  if (req.method === "POST") {

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

  /* ================= METHOD NOT ALLOWED ================= */
  return res.status(405).json({ error: "Method not allowed" });
}
