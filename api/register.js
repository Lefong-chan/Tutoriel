import admin from "firebase-admin";
import bcrypt from "bcryptjs";
import { sendOTPEmail } from "./mailer.js";

/* == ENV == */

const allowedOrigin = process.env.ALLOWED_ORIGIN;

if (!process.env.FIREBASE_KEY) {
  throw new Error("FIREBASE_KEY not set");
}

/* == FIREBASE INIT == */

if (!admin.apps.length) {

  const serviceAccount =
    JSON.parse(process.env.FIREBASE_KEY);

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

/* == CONFIG == */

const EMAIL_OTP_VALIDITY = 60 * 1000;
const PHONE_OTP_VALIDITY = 5 * 60 * 1000;

/* == VALIDATION REGEX == */

const emailRegex =
  /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const phoneRegex =
  /^(\+261|0)[0-9]{9}$/;

/* == HELPERS == */

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

  const { email, phone, password } = req.body;

  if ((!email && !phone) ||
      !password ||
      password.length < 6)
    return res.status(400).json({
      error:
        "Email or phone and valid password required"
    });

  try {

    let emailLower = null;
    let phoneClean = null;

    /* == EMAIL CHECK == */

    if (email) {

      emailLower =
        email.toLowerCase().trim();

      if (!emailRegex.test(emailLower)) {
        return res.status(400).json({
          error: "Invalid email format"
        });
      }

      const existingEmail = await db
        .ref("users")
        .orderByChild("email")
        .equalTo(emailLower)
        .limitToFirst(1)
        .get();

      if (existingEmail.exists()) {
        return res.status(400).json({
          error: "Account already exists"
        });
      }
    }

    /* == PHONE CHECK == */

    if (phone) {

      phoneClean = phone.trim();

      if (!phoneRegex.test(phoneClean)) {
        return res.status(400).json({
          error: "Invalid phone format"
        });
      }

      const existingPhone = await db
        .ref("users")
        .orderByChild("phone")
        .equalTo(phoneClean)
        .limitToFirst(1)
        .get();

      if (existingPhone.exists()) {
        return res.status(400).json({
          error: "Account already exists"
        });
      }
    }

    /* == CREATE USER == */

    const hashedPassword =
      await bcrypt.hash(password, 12);

    const uid = await generateUID();
    const now = Date.now();

    const emailOTP =
      emailLower ? generateOTP() : null;

    const emailOTPExpires =
      emailLower ? now + EMAIL_OTP_VALIDITY : null;

    const phoneOTP =
      phoneClean ? generateOTP() : null;

    const phoneOTPExpires =
      phoneClean ? now + PHONE_OTP_VALIDITY : null;

    await db.ref("users/" + uid).set({

      uid,

      email: emailLower,
      phone: phoneClean,

      password: hashedPassword,
      provider: "local",

      /* == EMAIL VERIFICATION == */

      emailVerified: emailLower ? false : true,
      otp: emailOTP,
      otpExpires: emailOTPExpires,

      resendCount: 0,
      resendWindowStart: now,
      otpAttempts: 0,
      otpLockUntil: null,

      /* == PHONE VERIFICATION == */

      phoneVerified: phoneClean ? false : true,
      phoneOTP,
      phoneOTPExpires,

      phoneResendCount: 0,
      phoneResendWindowStart: now,
      phoneOtpAttempts: 0,
      phoneOtpBlockUntil: null,

      /* == LOGIN RATE LIMIT == */

      loginAttempts: 0,
      loginWindowStart: null,

      createdAt: now
    });

    /* == SEND EMAIL OTP == */

    if (emailLower) {
      await sendOTPEmail(emailLower, emailOTP);
    }

    return res.status(201).json({
      success: true,
      emailVerificationRequired: !!emailLower,
      phoneVerificationRequired: !!phoneClean
    });

  } catch (err) {

    console.error("REGISTER ERROR:", err);

    return res.status(500).json({
      error: "Server error"
    });
  }
}
