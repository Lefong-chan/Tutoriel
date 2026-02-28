import admin from "firebase-admin";
import jwt from "jsonwebtoken";

const SECRET = process.env.JWT_SECRET;
const allowedOrigin = process.env.ALLOWED_ORIGIN;

const MAX_ATTEMPTS = 5;
const BLOCK_DURATION = 60 * 60 * 1000; // 1 hour

if (!process.env.FIREBASE_KEY)
  throw new Error("FIREBASE_KEY not set");

if (!SECRET)
  throw new Error("JWT_SECRET not set");

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

  const { phone, otp } = req.body;

  if (!phone || !otp)
    return res.status(400).json({
      error: "Phone and OTP required"
    });

  try {

    const cleanPhone = phone.trim();
    const cleanOtp = otp.toString().trim();

    const snap = await db
      .ref("users")
      .orderByChild("phone")
      .equalTo(cleanPhone)
      .limitToFirst(1)
      .get();

    if (!snap.exists())
      return res.status(400).json({
        error: "User not found"
      });

    const userData = Object.values(snap.val())[0];
    const now = Date.now();

    /* ================= PROVIDER CHECK ================= */

    if (userData.provider !== "local")
      return res.status(400).json({
        error: "Invalid account type"
      });

    /* ================= ALREADY VERIFIED ================= */

    if (userData.phoneVerified)
      return res.status(400).json({
        error: "Phone already verified"
      });

    /* ================= BLOCK CHECK ================= */

    if (
      userData.phoneOtpBlockUntil &&
      now < userData.phoneOtpBlockUntil
    ) {
      const retryAfter = Math.ceil(
        (userData.phoneOtpBlockUntil - now) / 1000
      );

      return res.status(429).json({
        error: "Too many attempts. Try again later.",
        retryAfter
      });
    }

    /* ================= OTP CHECK ================= */

    if (
      !userData.phoneOTP ||
      userData.phoneOTP !== cleanOtp
    ) {

      let attempts = userData.phoneOtpAttempts || 0;
      attempts++;

      const updateData = {
        phoneOtpAttempts: attempts
      };

      if (attempts >= MAX_ATTEMPTS) {
        updateData.phoneOtpBlockUntil =
          now + BLOCK_DURATION;
      }

      await db
        .ref("users/" + userData.uid)
        .update(updateData);

      return res.status(400).json({
        error: "Invalid code"
      });
    }

    /* ================= EXPIRATION CHECK ================= */

    if (now > userData.phoneOTPExpires) {

      return res.status(400).json({
        error: "Code expired"
      });
    }

    /* ================= SUCCESS ================= */

    await db.ref("users/" + userData.uid).update({

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

    console.error("VERIFY PHONE OTP ERROR:", err);

    return res.status(500).json({
      error: "Server error"
    });
  }
}
