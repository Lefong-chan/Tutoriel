import admin from "firebase-admin";

const allowedOrigin = process.env.ALLOWED_ORIGIN;

const MAX_RESEND_PER_HOUR = 5;
const FIVE_MINUTES = 5 * 60 * 1000;
const ONE_HOUR = 60 * 60 * 1000;

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

function generateOTP() {
  return Math.floor(
    100000 + Math.random() * 900000
  ).toString();
}

export default async function handler(req, res) {

  if (req.method !== "POST")
    return res.status(405).json({ error: "Method not allowed" });

  if (allowedOrigin && req.headers.origin !== allowedOrigin)
    return res.status(403).json({ error: "Forbidden" });

  const { phone } = req.body;

  if (!phone)
    return res.status(400).json({ error: "Phone required" });

  try {

    const cleanPhone = phone.trim();

    const snap = await db
      .ref("users")
      .orderByChild("phone")
      .equalTo(cleanPhone)
      .limitToFirst(1)
      .get();

    if (!snap.exists())
      return res.status(400).json({ error: "User not found" });

    const userData = Object.values(snap.val())[0];
    const now = Date.now();

    if (userData.phoneVerified)
      return res.status(400).json({ error: "Phone already verified" });

    if (userData.provider !== "local")
      return res.status(400).json({
        error: "OTP not required for this account"
      });

    if (userData.phoneOTPExpires && now < userData.phoneOTPExpires) {

      const retryAfter = Math.ceil(
        (userData.phoneOTPExpires - now) / 1000
      );

      return res.status(429).json({
        error: "Please wait before requesting a new code",
        retryAfter
      });
    }

    let resendCount = userData.phoneResendCount || 0;
    let resendWindowStart =
      userData.phoneResendWindowStart || now;

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
        retryAfter
      });
    }

    const newOTP = generateOTP();
    const newExpiry = now + FIVE_MINUTES;

    await db.ref("users/" + userData.uid).update({
      phoneOTP: newOTP,
      phoneOTPExpires: newExpiry,
      phoneResendCount: resendCount + 1,
      phoneResendWindowStart: resendWindowStart
    });

    return res.status(200).json({
      success: true,
      message: "New OTP generated",
      remainingResends:
        MAX_RESEND_PER_HOUR - (resendCount + 1)
    });

  } catch (err) {

    console.error("RESEND PHONE OTP ERROR:", err);

    return res.status(500).json({
      error: "Server error"
    });
  }
}
