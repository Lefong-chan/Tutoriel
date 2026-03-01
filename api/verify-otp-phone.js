import admin from "firebase-admin";
import jwt from "jsonwebtoken";

/* ================= ENV ================= */

const SECRET = process.env.JWT_SECRET;
const allowedOrigin = process.env.ALLOWED_ORIGIN;
const isProd = process.env.NODE_ENV === "production";

if (!process.env.FIREBASE_KEY)
  throw new Error("FIREBASE_KEY not set");

if (!SECRET)
  throw new Error("JWT_SECRET not set");

/* ================= FIREBASE INIT ================= */

if (!admin.apps.length) {

  const serviceAccount =
    JSON.parse(process.env.FIREBASE_KEY);

  if (serviceAccount.private_key) {
    serviceAccount.private_key =
      serviceAccount.private_key.replace(/\\n/g, "\n");
  }

  admin.initializeApp({
    credential:
      admin.credential.cert(serviceAccount),
    databaseURL:
      "https://tutoriel-ff487-default-rtdb.firebaseio.com/"
  });
}

const db = admin.database();

/* ================= CONFIG ================= */

const MAX_ATTEMPTS = 5;
const LOCK_TIME = 60 * 60 * 1000; // 1 hour

/* ================= HANDLER ================= */

export default async function handler(req, res) {

  /* ===== METHOD CHECK ===== */

  if (req.method !== "POST")
    return res.status(405).json({
      error: "Method not allowed"
    });

  /* ===== ORIGIN PROTECTION ===== */

  if (
    allowedOrigin &&
    req.headers.origin !== allowedOrigin
  )
    return res.status(403).json({
      error: "Forbidden"
    });

  const { phone, otp } = req.body;

  if (!phone || !otp)
    return res.status(400).json({
      error: "Invalid code"
    });

  try {

    const cleanPhone = phone.trim();
    const cleanOtp = otp.toString().trim();
    const now = Date.now();

    const snap = await db
      .ref("users")
      .orderByChild("phone")
      .equalTo(cleanPhone)
      .limitToFirst(1)
      .get();

    /* ===============================
      ANTI ENUMERATION
       =============================== */

    if (!snap.exists()) {

      await new Promise(r => setTimeout(r, 300));

      return res.status(400).json({
        error: "Invalid code"
      });
    }

    const userData =
      Object.values(snap.val())[0];

    const userRef =
      db.ref("users/" + userData.uid);

    /* ===== PROVIDER + VERIFIED SILENT CHECK ===== */

    if (
      userData.provider !== "local" ||
      userData.phoneVerified
    ) {
      return res.status(400).json({
        error: "Invalid code"
      });
    }

    /* ===== LOCK CHECK ===== */

    if (
      userData.phoneOtpBlockUntil &&
      now < userData.phoneOtpBlockUntil
    ) {

      const retryAfter =
        Math.ceil(
          (userData.phoneOtpBlockUntil - now) / 1000
        );

      return res.status(429).json({
        error:
          "Too many attempts. Try again later.",
        retryAfter
      });
    }

    /* ===== EXPIRATION CHECK ===== */

    if (
      !userData.phoneOTPExpires ||
      now > userData.phoneOTPExpires
    ) {

      await userRef.update({
        phoneOtpAttempts: 0
      });

      return res.status(400).json({
        error: "Invalid code"
      });
    }

    /* ===== WRONG OTP ===== */

    if (
      !userData.phoneOTP ||
      userData.phoneOTP !== cleanOtp
    ) {

      let attempts =
        (userData.phoneOtpAttempts || 0) + 1;

      const updateData = {
        phoneOtpAttempts: attempts
      };

      if (attempts >= MAX_ATTEMPTS) {
        updateData.phoneOtpBlockUntil =
          now + LOCK_TIME;
      }

      await userRef.update(updateData);

      if (attempts >= MAX_ATTEMPTS) {
        return res.status(429).json({
          error:
            "Too many attempts. Account locked for 1 hour.",
          retryAfter: 3600
        });
      }

      return res.status(400).json({
        error: "Invalid code"
      });
    }

    /* ===============================
      SUCCESS
       =============================== */

    await userRef.update({

      phoneVerified: true,

      phoneOTP: null,
      phoneOTPExpires: null,

      phoneOtpAttempts: 0,
      phoneOtpBlockUntil: null
    });

    const token = jwt.sign(
      {
        uid: userData.uid,
        phone: userData.phone,
        provider: userData.provider
      },
      SECRET,
      { expiresIn: "7d" }
    );

    /* ================= COOKIE ================= */

    const cookieOptions = [
      `token=${token}`,
      "HttpOnly",
      `Max-Age=${7 * 24 * 60 * 60}`,
      "Path=/",
      `SameSite=${isProd ? "None" : "Lax"}`,
      "Priority=High"
    ];

    if (isProd) {
      cookieOptions.push("Secure");
    }

    res.setHeader(
      "Set-Cookie",
      cookieOptions.join("; ")
    );

    return res.status(200).json({
      success: true
    });

  } catch (err) {

    console.error(
      "VERIFY PHONE OTP ERROR:",
      err
    );

    return res.status(500).json({
      error: "Server error"
    });
  }
}
