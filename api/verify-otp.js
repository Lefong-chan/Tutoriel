import admin from "firebase-admin";
import jwt from "jsonwebtoken";

const allowedOrigin = process.env.ALLOWED_ORIGIN;
const SECRET = process.env.JWT_SECRET;

if (!process.env.FIREBASE_KEY) throw new Error("FIREBASE_KEY not set");
if (!SECRET) throw new Error("JWT_SECRET not set");

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

  const { identifier, otp } = req.body;

  if (!identifier || !otp)
    return res.status(400).json({ error: "Identifier and OTP required" });

  try {

    const idClean = identifier.toLowerCase().trim();

    const snap = await db
      .ref("users")
      .orderByChild("email")
      .equalTo(idClean)
      .limitToFirst(1)
      .get();

    if (!snap.exists())
      return res.status(400).json({ error: "User not found" });

    const userKey = Object.keys(snap.val())[0];
    const userData = snap.val()[userKey];

    if (userData.emailVerified)
      return res.status(400).json({ error: "Email already verified" });

    /* ================= OTP ATTEMPT LIMIT ================= */

    const maxAttempts = 5;
    const attempts = userData.otpAttempts || 0;

    if (attempts >= maxAttempts) {
      return res.status(429).json({
        error: "Too many incorrect attempts"
      });
    }

    if (!userData.otp || userData.otp !== otp) {

      await db.ref("users/" + userData.uid).update({
        otpAttempts: attempts + 1
      });

      return res.status(400).json({ error: "Invalid OTP" });
    }

    if (!userData.otpExpires || Date.now() > userData.otpExpires)
      return res.status(400).json({ error: "OTP expired" });

    /* ================= SUCCESS ================= */

    await db.ref("users/" + userData.uid).update({
      emailVerified: true,
      otp: null,
      otpExpires: null,
      otpAttempts: 0,
      resendCount: 0,
      resendWindowStart: null
    });

    const token = jwt.sign(
      {
        uid: userData.uid,
        email: userData.email,
        provider: userData.provider
      },
      SECRET,
      { expiresIn: "7d" }
    );

    /* ================= HTTP ONLY COOKIE ================= */

    res.setHeader("Set-Cookie", `
      token=${token};
      HttpOnly;
      Secure;
      SameSite=Strict;
      Path=/;
      Max-Age=${7 * 24 * 60 * 60}
    `.replace(/\s+/g, " ").trim());

    return res.status(200).json({
      success: true
    });

  } catch (err) {

    console.error("VERIFY OTP ERROR:", err);
    return res.status(500).json({ error: "Server error" });
  }
}
