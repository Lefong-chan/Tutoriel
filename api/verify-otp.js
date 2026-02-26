import admin from "firebase-admin";
import jwt from "jsonwebtoken";

const allowedOrigin = process.env.ALLOWED_ORIGIN;

if (!process.env.FIREBASE_KEY) {
  throw new Error("FIREBASE_KEY not set");
}

if (!process.env.JWT_SECRET) {
  throw new Error("JWT_SECRET not set");
}

// ===== FIREBASE INIT =====
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

// ===== HANDLER =====
export default async function handler(req, res) {

  if (req.method !== "POST") {
    return res.status(405).json({
      error: "Method not allowed"
    });
  }

  if (allowedOrigin && req.headers.origin !== allowedOrigin) {
    return res.status(403).json({
      error: "Forbidden"
    });
  }

  const { identifier, otp } = req.body;

  if (!identifier || !otp) {
    return res.status(400).json({
      error: "Identifier and OTP required"
    });
  }

  try {

    const identifierClean = identifier.toLowerCase().trim();

    // ===== FIND USER BY EMAIL =====
    const snap = await db
      .ref("users")
      .orderByChild("email")
      .equalTo(identifierClean)
      .limitToFirst(1)
      .get();

    if (!snap.exists()) {
      return res.status(400).json({
        error: "User not found"
      });
    }

    const userKey = Object.keys(snap.val())[0];
    const userData = snap.val()[userKey];

    // ===== CHECK VERIFIED =====
    if (userData.emailVerified) {
      return res.status(400).json({
        error: "Email already verified"
      });
    }

    // ===== CHECK OTP MATCH =====
    if (!userData.otp || userData.otp !== otp) {
      return res.status(400).json({
        error: "Invalid OTP"
      });
    }

    // ===== CHECK EXPIRATION =====
    if (!userData.otpExpires || Date.now() > userData.otpExpires) {
      return res.status(400).json({
        error: "OTP expired"
      });
    }

    // ===== UPDATE USER =====
    await db.ref("users/" + userData.uid).update({
      emailVerified: true,
      otp: null,
      otpExpires: null,
      resendCount: 0,
      resendWindowStart: null
    });

    // ===== GENERATE JWT TOKEN =====
    const token = jwt.sign(
      {
        uid: userData.uid,
        email: userData.email,
        provider: userData.provider
      },
      process.env.JWT_SECRET,
      { expiresIn: "7d" }
    );

    return res.status(200).json({
      success: true,
      token
    });

  } catch (err) {

    console.error("VERIFY OTP ERROR:", err);

    return res.status(500).json({
      error: "Server error"
    });
  }
}
