import admin from "firebase-admin";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";

const SECRET = process.env.JWT_SECRET;
const allowedOrigin = process.env.ALLOWED_ORIGIN;

if (!SECRET) throw new Error("JWT_SECRET not set");
if (!process.env.FIREBASE_KEY) throw new Error("FIREBASE_KEY not set");

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

export default async function handler(req, res) {

  if (req.method !== "POST")
    return res.status(405).json({ error: "Method not allowed" });

  if (allowedOrigin && req.headers.origin !== allowedOrigin)
    return res.status(403).json({ error: "Forbidden" });

  const { identifier, password } = req.body;

  if (!identifier || !password)
    return res.status(400).json({ error: "Invalid credentials" });

  try {

    const value = identifier.trim();
    let snap;

    if (value.includes("@")) {
      snap = await db
        .ref("users")
        .orderByChild("email")
        .equalTo(value.toLowerCase())
        .limitToFirst(1)
        .get();
    } else {
      snap = await db
        .ref("users")
        .orderByChild("phone")
        .equalTo(value)
        .limitToFirst(1)
        .get();
    }

    if (!snap.exists())
      return res.status(400).json({ error: "Invalid credentials" });

    const userData = Object.values(snap.val())[0];

    /* ================= LOGIN RATE LIMIT ================= */

    const maxAttempts = 10;
    const windowMs = 10 * 60 * 1000; // 10 min

    const now = Date.now();
    let attempts = userData.loginAttempts || 0;
    let windowStart = userData.loginWindowStart || now;

    if (now - windowStart > windowMs) {
      attempts = 0;
      windowStart = now;
    }

    if (attempts >= maxAttempts) {
      return res.status(429).json({
        error: "Too many login attempts. Try later."
      });
    }

    /* ================= PROVIDER CHECK ================= */

    if (userData.provider !== "local")
      return res.status(400).json({
        error: "Use correct login method"
      });

    /* ================= PASSWORD CHECK ================= */

    const isMatch = await bcrypt.compare(
      password,
      userData.password
    );

    if (!isMatch) {

      await db.ref("users/" + userData.uid).update({
        loginAttempts: attempts + 1,
        loginWindowStart: windowStart
      });

      return res.status(400).json({ error: "Invalid credentials" });
    }

    /* ================= EMAIL VERIFIED ================= */

    if (userData.email && !userData.emailVerified)
      return res.status(403).json({
        error: "Email not verified",
        emailNotVerified: true
      });
      
    /* ================= PHONE VERIFIED ================= */
    
    if (userData.phone && !userData.phoneVerified)
      return res.status(403).json({
        error: "Phone not verified",
        phoneNotVerified: true
    });

    /* ================= SUCCESS ================= */

    await db.ref("users/" + userData.uid).update({
      loginAttempts: 0,
      loginWindowStart: null
    });

    const token = jwt.sign(
      {
        uid: userData.uid,
        email: userData.email || null,
        phone: userData.phone || null,
        provider: userData.provider
      },
      SECRET,
      { expiresIn: "7d" }
    );

    res.setHeader("Set-Cookie", `
      token=${token};
      HttpOnly;
      Secure;
      SameSite=Strict;
      Path=/;
      Max-Age=${7 * 24 * 60 * 60}
    `.replace(/\s+/g, " ").trim());

    return res.status(200).json({
      success: true,
      user: {
        uid: userData.uid,
        email: userData.email || null,
        phone: userData.phone || null,
        provider: userData.provider
      }
    });

  } catch (err) {

    console.error("LOGIN ERROR:", err);
    return res.status(500).json({ error: "Server error" });
  }
}
