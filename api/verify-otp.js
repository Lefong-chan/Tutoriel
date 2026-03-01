import admin from "firebase-admin";
import jwt from "jsonwebtoken";

/* == ENV == */

const SECRET = process.env.JWT_SECRET;
const allowedOrigin = process.env.ALLOWED_ORIGIN;
const isProd = process.env.NODE_ENV === "production";

if (!process.env.FIREBASE_KEY)
  throw new Error("FIREBASE_KEY not set");

if (!SECRET)
  throw new Error("JWT_SECRET not set");

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

/* == CONFIG == */

const MAX_ATTEMPTS = 5;
const LOCK_TIME = 60 * 60 * 1000;

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

  const { identifier, otp } = req.body;

  if (!identifier || !otp)
    return res.status(400).json({
      error: "Email and OTP required"
    });

  try {

    const cleanIdentifier =
      identifier.toLowerCase().trim();

    const cleanOtp =
      otp.toString().trim();

    const snap = await db
      .ref("users")
      .orderByChild("email")
      .equalTo(cleanIdentifier)
      .limitToFirst(1)
      .get();

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

    const now = Date.now();

    /* == PROVIDER CHECK == */

    if (userData.provider !== "local")
      return res.status(400).json({
        error: "Invalid account type"
      });

    /* == ALREADY VERIFIED == */

    if (userData.emailVerified)
      return res.status(400).json({
        error: "Email already verified"
      });

    /* == LOCK CHECK == */

    if (
      userData.otpLockUntil &&
      now < userData.otpLockUntil
    ) {

      const retryAfter = Math.ceil(
        (userData.otpLockUntil - now) / 1000
      );

      return res.status(429).json({
        error: "Too many attempts. Try again later.",
        retryAfter
      });
    }

    /* ==
       EXPIRATION CHECK (IMPORTANT ORDER)
    == */

    if (
      !userData.otpExpires ||
      now > userData.otpExpires
    ) {

      await userRef.update({
        otpAttempts: 0
      });

      return res.status(400).json({
        error: "Code expired"
      });
    }

    /* == WRONG OTP == */

    if (
      !userData.otp ||
      userData.otp !== cleanOtp
    ) {

      let attempts =
        (userData.otpAttempts || 0) + 1;

      const updateData = {
        otpAttempts: attempts
      };

      if (attempts >= MAX_ATTEMPTS) {
        updateData.otpLockUntil =
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

    /* == SUCCESS == */

    await userRef.update({

      emailVerified: true,

      otp: null,
      otpExpires: null,

      otpAttempts: 0,
      otpLockUntil: null
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

    /* == COOKIE SAFE == */

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

    console.error("VERIFY OTP ERROR:", err);

    return res.status(500).json({
      error: "Server error"
    });
  }
}
