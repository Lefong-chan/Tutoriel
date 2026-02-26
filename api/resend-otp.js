// resend-otp.js

import admin from "firebase-admin";
import { sendOTPEmail } from "./mailer.js";

const allowedOrigin = process.env.ALLOWED_ORIGIN;

// ===== CONFIG =====
const MAX_RESEND_PER_HOUR = 5;
const ONE_MINUTE = 1 * 60 * 1000;
const ONE_HOUR = 60 * 60 * 1000;

// ===== FIREBASE INIT =====
if (!process.env.FIREBASE_KEY) {
  throw new Error("FIREBASE_KEY not set");
}

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

// ===== HELPERS =====
function generateOTP() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

// ===== HANDLER =====
export default async function handler(req, res) {

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  if (allowedOrigin && req.headers.origin !== allowedOrigin) {
    return res.status(403).json({ error: "Forbidden" });
  }

  const { email } = req.body;

  if (!email) {
    return res.status(400).json({ error: "Email required" });
  }

  try {

    const emailLower = email.toLowerCase().trim();

    const snap = await db
      .ref("users")
      .orderByChild("email")
      .equalTo(emailLower)
      .limitToFirst(1)
      .get();

    if (!snap.exists()) {
      return res.status(400).json({ error: "User not found" });
    }

    const userKey = Object.keys(snap.val())[0];
    const userData = snap.val()[userKey];
    const now = Date.now();

    if (userData.emailVerified) {
      return res.status(400).json({
        error: "Email already verified"
      });
    }

    /* =====================================================
      COOLDOWN 1 MINUTE
    ===================================================== */
    if (
      userData.otp &&
      userData.otpExpires &&
      now < userData.otpExpires
    ) {
      const remainingSeconds = Math.ceil(
        (userData.otpExpires - now) / 1000
      );

      return res.status(429).json({
        error: "Please wait before requesting a new OTP",
        remainingTime: remainingSeconds
      });
    }

    /* =====================================================
      RATE LIMIT: 5 / HOUR
    ===================================================== */
    let resendCount = userData.resendCount || 0;
    let resendWindowStart = userData.resendWindowStart || now;

    // Reset window if 1 hour passed
    if (now - resendWindowStart >= ONE_HOUR) {
      resendCount = 0;
      resendWindowStart = now;
    }

    if (resendCount >= MAX_RESEND_PER_HOUR) {
      const retryAfter = Math.ceil(
        (ONE_HOUR - (now - resendWindowStart)) / 1000
      );

      return res.status(429).json({
        error: "Too many OTP requests. Try again later.",
        retryAfter // seconds
      });
    }

    /* =====================================================
      GENERATE & SEND NEW OTP
    ===================================================== */
    const newOTP = generateOTP();
    const newExpiry = now + ONE_MINUTE;

    await db.ref("users/" + userData.uid).update({
      otp: newOTP,
      otpExpires: newExpiry,
      resendCount: resendCount + 1,
      resendWindowStart
    });

    await sendOTPEmail(emailLower, newOTP);

    return res.status(200).json({
      success: true,
      message: "New OTP sent",
      remainingResends: MAX_RESEND_PER_HOUR - (resendCount + 1)
    });

  } catch (err) {
    console.error("RESEND OTP ERROR:", err);
    return res.status(500).json({ error: "Server error" });
  }
}
