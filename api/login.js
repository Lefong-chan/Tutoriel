import admin from "firebase-admin";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";

/* == ENV == */

const SECRET = process.env.JWT_SECRET;
const allowedOrigin = process.env.ALLOWED_ORIGIN;
const isProd = process.env.NODE_ENV === "production";

if (!SECRET) throw new Error("JWT_SECRET not set");
if (!process.env.FIREBASE_KEY)
  throw new Error("FIREBASE_KEY not set");

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

/* == VALIDATION REGEX == */

const emailRegex =
  /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const phoneRegex =
  /^(\+261|0)[0-9]{9}$/;

/* == HANDLER == */

export default async function handler(req, res) {

  if (req.method !== "POST")
    return res.status(405).json({
      error: "Method not allowed"
    });

  if (
    allowedOrigin &&
    req.headers.origin !== allowedOrigin
  )
    return res.status(403).json({
      error: "Forbidden"
    });

  const { identifier, password } = req.body;

  if (!identifier || !password)
    return res.status(400).json({
      error: "Invalid credentials"
    });

  try {

    const value = identifier.trim();
    const now = Date.now();

    let loginType = null;
    let snap = null;

    /* == IDENTIFIER DETECTION == */

    if (emailRegex.test(value)) {

      loginType = "email";

      snap = await db
        .ref("users")
        .orderByChild("email")
        .equalTo(value.toLowerCase())
        .limitToFirst(1)
        .get();

    } else if (phoneRegex.test(value)) {

      loginType = "phone";

      snap = await db
        .ref("users")
        .orderByChild("phone")
        .equalTo(value)
        .limitToFirst(1)
        .get();

    } else {
      return res.status(400).json({
        error: "Invalid email or phone format"
      });
    }

    if (!snap.exists()) {
      await new Promise(r => setTimeout(r, 300));
      return res.status(400).json({
        error: "Invalid credentials"
      });
    }

    const userData =
      Object.values(snap.val())[0];

    /* == OTP BLOCK CHECK == */

    if (
      loginType === "email" &&
      userData.otpLockUntil &&
      now < userData.otpLockUntil
    ) {

      const retryAfter =
        Math.ceil(
          (userData.otpLockUntil - now) / 1000
        );

      return res.status(429).json({
        error:
          "Too many verification attempts. Try again later.",
        emailBlocked: true,
        retryAfter
      });
    }

    if (
      loginType === "phone" &&
      userData.phoneOtpBlockUntil &&
      now < userData.phoneOtpBlockUntil
    ) {

      const retryAfter =
        Math.ceil(
          (userData.phoneOtpBlockUntil - now) / 1000
        );

      return res.status(429).json({
        error:
          "Too many verification attempts. Try again later.",
        phoneBlocked: true,
        retryAfter
      });
    }

    /* == LOGIN RATE LIMIT == */

    const MAX_ATTEMPTS = 10;
    const WINDOW_MS = 10 * 60 * 1000;

    let attempts =
      userData.loginAttempts || 0;

    let windowStart =
      userData.loginWindowStart ?? now;

    if (now - windowStart > WINDOW_MS) {
      attempts = 0;
      windowStart = now;
    }

    if (attempts >= MAX_ATTEMPTS) {
      return res.status(429).json({
        error:
          "Too many login attempts. Try later."
      });
    }

    /* == PROVIDER CHECK == */

    if (userData.provider !== "local")
      return res.status(400).json({
        error:
          "Use correct login method"
      });

    /* == PASSWORD CHECK == */

    const isMatch =
      await bcrypt.compare(
        password,
        userData.password
      );

    if (!isMatch) {

      await db
        .ref("users/" + userData.uid)
        .update({
          loginAttempts: attempts + 1,
          loginWindowStart: windowStart
        });

      return res.status(400).json({
        error: "Invalid credentials"
      });
    }

    /* == VERIFIED CHECK == */

    if (
      loginType === "email" &&
      !userData.emailVerified
    )
      return res.status(403).json({
        error: "Email not verified",
        emailNotVerified: true
      });

    if (
      loginType === "phone" &&
      !userData.phoneVerified
    )
      return res.status(403).json({
        error: "Phone not verified",
        phoneNotVerified: true
      });

    /* == SUCCESS == */

    await db
      .ref("users/" + userData.uid)
      .update({
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

    /* == COOKIE FIXED == */

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

    return res.status(500).json({
      error: "Server error"
    });
  }
}
