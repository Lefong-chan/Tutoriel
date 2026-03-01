import admin from "firebase-admin";
import { sendOTPEmail } from "./mailer.js";

/* == ENV == */

const allowedOrigin = process.env.ALLOWED_ORIGIN;

if (!process.env.FIREBASE_KEY) {
  throw new Error("FIREBASE_KEY not set");
}

/* == CONFIG == */

const MAX_RESEND_PER_HOUR = 5;
const ONE_MINUTE = 60 * 1000;
const ONE_HOUR = 60 * 60 * 1000;

const emailRegex =
  /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/* == FIREBASE INIT == */

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

/* == HELPER == */

function generateOTP() {
  return Math.floor(
    100000 + Math.random() * 900000
  ).toString();
}

/* == HANDLER == */

export default async function handler(req, res) {

  if (req.method !== "POST")
    return res.status(405).json({
      error: "Method not allowed"
    });

  if (allowedOrigin &&
      req.headers.origin !== allowedOrigin)
    return res.status(403).json({
      error: "Forbidden"
    });

  const { identifier } = req.body;

  if (!identifier)
    return res.status(400).json({
      error: "Identifier required"
    });

  try {

    const cleanIdentifier =
      identifier.toLowerCase().trim();

    if (!emailRegex.test(cleanIdentifier)) {
      return res.status(400).json({
        error: "Invalid email format"
      });
    }

    const snap = await db
      .ref("users")
      .orderByChild("email")
      .equalTo(cleanIdentifier)
      .limitToFirst(1)
      .get();

    /* SECURITY: aza milaza raha tsy misy account */

    if (!snap.exists()) {
      return res.status(200).json({
        success: true
      });
    }

    const userData =
      Object.values(snap.val())[0];

    const userRef =
      db.ref("users/" + userData.uid);

    const now = Date.now();

    /* == ACCOUNT CHECK == */

    if (userData.provider !== "local")
      return res.status(400).json({
        error: "OTP not required for this account"
      });

    if (userData.emailVerified)
      return res.status(400).json({
        error: "Email already verified"
      });

    /* == 1 MINUTE COOLDOWN == */

    if (userData.otpExpires &&
        now < userData.otpExpires) {

      const retryAfter = Math.ceil(
        (userData.otpExpires - now) / 1000
      );

      return res.status(429).json({
        error:
          "Please wait before requesting a new OTP",
        retryAfter
      });
    }

    /* == 5 PER HOUR LIMIT == */

    let resendCount =
      userData.resendCount || 0;

    let resendWindowStart =
      userData.resendWindowStart || now;

    if (now - resendWindowStart >= ONE_HOUR) {
      resendCount = 0;
      resendWindowStart = now;
    }

    if (resendCount >= MAX_RESEND_PER_HOUR) {

      const retryAfter = Math.ceil(
        (ONE_HOUR -
         (now - resendWindowStart)) / 1000
      );

      return res.status(429).json({
        error:
          "Too many OTP requests. Try again later.",
        retryAfter
      });
    }

    /* == GENERATE NEW OTP == */

    const newOTP = generateOTP();
    const newExpiry = now + ONE_MINUTE;

    await userRef.update({
      otp: newOTP,
      otpExpires: newExpiry,
      resendCount: resendCount + 1,
      resendWindowStart,
      otpAttempts: 0,
      otpLockUntil: null
    });

    await sendOTPEmail(cleanIdentifier, newOTP);

    return res.status(200).json({
      success: true,
      message: "New OTP sent",
      remainingResends:
        MAX_RESEND_PER_HOUR -
        (resendCount + 1)
    });

  } catch (err) {

    console.error(
      "RESEND OTP ERROR:",
      err
    );

    return res.status(500).json({
      error: "Server error"
    });
  }
}
