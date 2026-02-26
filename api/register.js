import admin from "firebase-admin";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { sendOTPEmail } from "./mailer.js";

const allowedOrigin = process.env.ALLOWED_ORIGIN;
const JWT_SECRET = process.env.JWT_SECRET;

/* =====================================================
   FIREBASE INIT
===================================================== */

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

/* =====================================================
   HELPERS
===================================================== */

async function generateUID() {
  let uid;
  let snapshot;

  do {
    uid = Math.floor(
      100000000 + Math.random() * 900000000
    ).toString();

    snapshot = await db.ref("users/" + uid).get();
  } while (snapshot.exists());

  return uid;
}

function generateOTP() {
  return Math.floor(
    100000 + Math.random() * 900000
  ).toString();
}

function isEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function isPhone(value) {
  return /^[0-9]{8,15}$/.test(value);
}

/* =====================================================
   HANDLER
===================================================== */

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

  const { identifier, password } = req.body;

  if (!identifier || !password || password.length < 6) {
    return res.status(400).json({
      error: "Identifier and valid password required"
    });
  }

  try {

    const cleanIdentifier = identifier.trim();

    let email = null;
    let phone = null;

    /* =====================================================
       IDENTIFIER TYPE CHECK
    ===================================================== */

    if (isEmail(cleanIdentifier)) {
      email = cleanIdentifier.toLowerCase();
    } else if (isPhone(cleanIdentifier)) {
      phone = cleanIdentifier;
    } else {
      return res.status(400).json({
        error: "Invalid email or phone format"
      });
    }

    /* =====================================================
       DUPLICATE CHECK
    ===================================================== */

    if (email) {
      const existingEmail = await db
        .ref("users")
        .orderByChild("email")
        .equalTo(email)
        .limitToFirst(1)
        .get();

      if (existingEmail.exists()) {
        return res.status(400).json({
          error: "Email already registered"
        });
      }
    }

    if (phone) {
      const existingPhone = await db
        .ref("users")
        .orderByChild("phone")
        .equalTo(phone)
        .limitToFirst(1)
        .get();

      if (existingPhone.exists()) {
        return res.status(400).json({
          error: "Phone already registered"
        });
      }
    }

    /* =====================================================
       PASSWORD HASH
    ===================================================== */

    const hashedPassword = await bcrypt.hash(password, 12);
    const uid = await generateUID();
    const now = Date.now();

    /* =====================================================
       OTP SETUP (EMAIL ONLY)
    ===================================================== */

    let otp = null;
    let otpExpires = null;

    if (email) {
      otp = generateOTP();
      otpExpires = now + (1 * 60 * 1000); // 1 minute
    }

    /* =====================================================
       SAVE USER
    ===================================================== */

    await db.ref("users/" + uid).set({
      uid,
      email,
      phone,
      password: hashedPassword,
      provider: "local",

      emailVerified: email ? false : true,

      otp,
      otpExpires,

      resendCount: 0,
      resendWindowStart: now,

      createdAt: now
    });

    /* =====================================================
       SEND OTP IF EMAIL
    ===================================================== */

    if (email) {
      await sendOTPEmail(email, otp);

      return res.status(201).json({
        success: true,
        emailVerificationRequired: true
      });
    }

    /* =====================================================
       PHONE REGISTER = AUTO LOGIN
    ===================================================== */

    if (!JWT_SECRET) {
      throw new Error("JWT_SECRET not set");
    }

    const token = jwt.sign(
      { uid },
      JWT_SECRET,
      { expiresIn: "7d" }
    );

    return res.status(201).json({
      success: true,
      token
    });

  } catch (err) {

    console.error("REGISTER ERROR:", err);

    return res.status(500).json({
      error: "Server error"
    });
  }
}
