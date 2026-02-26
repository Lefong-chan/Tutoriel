import admin from "firebase-admin";
import bcrypt from "bcryptjs";
import { sendOTPEmail } from "./mailer.js";

const allowedOrigin = process.env.ALLOWED_ORIGIN;

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
  let snap;

  do {
    uid = Math.floor(
      100000000 + Math.random() * 900000000
    ).toString();

    snap = await db.ref("users/" + uid).get();

  } while (snap.exists());

  return uid;
}

function generateOTP() {
  return Math.floor(
    100000 + Math.random() * 900000
  ).toString();
}

/* =====================================================
   HANDLER
===================================================== */

export default async function handler(req, res) {

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  if (allowedOrigin && req.headers.origin !== allowedOrigin) {
    return res.status(403).json({ error: "Forbidden" });
  }

  const { email, phone, password } = req.body;

  if ((!email && !phone) || !password || password.length < 6) {
    return res.status(400).json({
      error: "Email or phone and valid password required"
    });
  }

  try {

    let emailLower = null;
    let phoneClean = null;

    /* ================= EMAIL CHECK ================= */

    if (email) {

      emailLower = email.toLowerCase().trim();

      const existingEmail = await db
        .ref("users")
        .orderByChild("email")
        .equalTo(emailLower)
        .limitToFirst(1)
        .get();

      if (existingEmail.exists()) {
        return res.status(400).json({
          error: "Email already registered"
        });
      }
    }

    /* ================= PHONE CHECK ================= */

    if (phone) {

      phoneClean = phone.trim();

      const existingPhone = await db
        .ref("users")
        .orderByChild("phone")
        .equalTo(phoneClean)
        .limitToFirst(1)
        .get();

      if (existingPhone.exists()) {
        return res.status(400).json({
          error: "Phone already registered"
        });
      }
    }

    /* ================= PASSWORD HASH ================= */

    const hashed = await bcrypt.hash(password, 12);
    const uid = await generateUID();
    const now = Date.now();

    /* ================= OTP CONFIG ================= */

    const otp = emailLower ? generateOTP() : null;
    const otpExpires = emailLower
      ? now + (60 * 1000)
      : null;

    /* ================= SAVE USER ================= */

    await db.ref("users/" + uid).set({

      uid,
      email: emailLower,
      phone: phoneClean,
      password: hashed,
      provider: "local",

      emailVerified: emailLower ? false : true,

      otp,
      otpExpires,

      resendCount: 0,
      resendWindowStart: now,

      createdAt: now
    });

    /* ================= SEND EMAIL ================= */

    if (emailLower) {
      await sendOTPEmail(emailLower, otp);
    }

    return res.status(201).json({
      success: true,
      emailVerificationRequired: !!emailLower
    });

  } catch (err) {

    console.error("REGISTER ERROR:", err);

    return res.status(500).json({
      error: "Server error"
    });
  }
}
