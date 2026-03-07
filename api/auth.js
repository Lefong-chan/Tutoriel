// api/auth.js

import admin from "firebase-admin";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { sendOTPEmail } from "./mailer.js";

/* ================= ENV ================= */
const SECRET = process.env.JWT_SECRET;
const allowedOrigin = process.env.ALLOWED_ORIGIN;
const isProd = process.env.NODE_ENV === "production";

if (!SECRET) throw new Error("JWT_SECRET not set");
if (!process.env.FIREBASE_KEY) throw new Error("FIREBASE_KEY not set");

/* ================= FIREBASE INIT (FIRESTORE) ================= */
if (!admin.apps.length) {
  const serviceAccount = JSON.parse(process.env.FIREBASE_KEY);
  if (serviceAccount.private_key) {
    serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, "\n");
  }
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}
const db = admin.firestore();
const usersCollection = db.collection("users");

/* ================= CONFIG ================= */
const EMAIL_OTP_VALIDITY = 5 * 60 * 1000; // 5 minitra
const RESET_OTP_VALIDITY = 5 * 60 * 1000; // 5 minitra
const MAX_ATTEMPTS = 5;
const LOCK_TIME = 24 * 60 * 60 * 1000; // 24 ora
const MAX_RESEND_PER_HOUR = 5;
const ONE_MINUTE = 60 * 1000;
const ONE_HOUR = 60 * 60 * 1000;
const MAX_LOGIN_ATTEMPTS = 10;
const LOGIN_WINDOW_MS = 10 * 60 * 1000;

/* ================= REGEX ================= */
const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/* ================= HELPERS ================= */
async function generateUID() {
  let uid;
  let doc;
  do {
    uid = Math.floor(100000000 + Math.random() * 900000000).toString();
    doc = await usersCollection.doc(uid).get();
  } while (doc.exists);
  return uid;
}

function generateOTP() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

/* ================= MAIN HANDLER ================= */
export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  if (allowedOrigin && req.headers.origin !== allowedOrigin) {
    return res.status(403).json({ error: "Forbidden" });
  }

  const { action, ...payload } = req.body;

  if (!action) {
    return res.status(400).json({ error: "Action required" });
  }

  try {
    switch (action) {
      case "register":
        return await handleRegister(payload, res);
      case "login":
        return await handleLogin(payload, res);
      case "verify-otp":
        return await handleVerifyOtp(payload, res);
      case "resend-otp":
        return await handleResendOtp(payload, res);
      case "forgot-password-request":
        return await handleForgotPasswordRequest(payload, res);
      case "forgot-password-reset":
        return await handleForgotPasswordReset(payload, res);
      default:
        return res.status(400).json({ error: "Invalid action" });
    }
  } catch (err) {
    console.error(`AUTH ERROR [${action}]:`, err);
    return res.status(500).json({ error: "Server error" });
  }
}

/* ================= REGISTER ================= */
async function handleRegister(body, res) {
  const { email, password } = body;

  if (!email || !password || password.length < 6) {
    return res.status(400).json({ error: "Email and valid password required" });
  }

  const emailLower = email.toLowerCase().trim();
  if (!emailRegex.test(emailLower)) {
    return res.status(400).json({ error: "Invalid email format" });
  }

  try {
    const existingEmail = await usersCollection.where("email", "==", emailLower).limit(1).get();
    if (!existingEmail.empty) {
      return res.status(400).json({ error: "Account already exists" });
    }

    const hashedPassword = await bcrypt.hash(password, 12);
    const uid = await generateUID();
    const now = Date.now();
    const emailOTP = generateOTP();

    await usersCollection.doc(uid).set({
      uid,
      email: emailLower,
      password: hashedPassword,
      provider: "local",
      emailVerified: false,
      otp: emailOTP,
      otpExpires: now + EMAIL_OTP_VALIDITY,
      resendCount: 0,
      resendWindowStart: now,
      otpAttempts: 0,
      otpLockUntil: null,
      loginAttempts: 0,
      loginWindowStart: null,
      createdAt: now
    });

    await sendOTPEmail(emailLower, emailOTP);

    return res.status(201).json({ success: true, emailVerificationRequired: true });
  } catch (err) {
    console.error("REGISTER ERROR:", err);
    throw err;
  }
}

/* ================= LOGIN ================= */
async function handleLogin(body, res) {
  const { identifier, password } = body;

  if (!identifier || !password) {
    return res.status(400).json({ error: "Invalid credentials" });
  }

  const emailLower = identifier.toLowerCase().trim();
  const now = Date.now();

  try {
    const snap = await usersCollection.where("email", "==", emailLower).limit(1).get();

    if (snap.empty) {
      await new Promise(r => setTimeout(r, 300));
      return res.status(400).json({ error: "Invalid credentials" });
    }

    const userDoc = snap.docs[0];
    const userData = userDoc.data();

    // Check Lock
    if (userData.otpLockUntil && now < userData.otpLockUntil) {
      const retryAfter = Math.ceil((userData.otpLockUntil - now) / 1000);
      return res.status(429).json({ error: "Account locked. Try again later.", retryAfter });
    }

    // Rate limit login
    let attempts = userData.loginAttempts || 0;
    let windowStart = userData.loginWindowStart ?? now;
    if (now - windowStart > LOGIN_WINDOW_MS) {
      attempts = 0;
      windowStart = now;
    }
    if (attempts >= MAX_LOGIN_ATTEMPTS) {
      return res.status(429).json({ error: "Too many login attempts." });
    }

    const isMatch = await bcrypt.compare(password, userData.password);
    if (!isMatch) {
      await userDoc.ref.update({ loginAttempts: attempts + 1, loginWindowStart: windowStart });
      return res.status(400).json({ error: "Invalid credentials" });
    }

    if (!userData.emailVerified) {
      return res.status(403).json({ error: "Email not verified", emailNotVerified: true });
    }

    await userDoc.ref.update({ loginAttempts: 0, loginWindowStart: null });

    const token = jwt.sign({ uid: userData.uid, email: userData.email }, SECRET, { expiresIn: "7d" });

    const cookieOptions = [`token=${token}`, "HttpOnly", "Max-Age=604800", "Path=/", `SameSite=${isProd ? "None" : "Lax"}`, "Priority=High"];
    if (isProd) cookieOptions.push("Secure");
    res.setHeader("Set-Cookie", cookieOptions.join("; "));

    return res.status(200).json({ success: true, user: { uid: userData.uid, email: userData.email } });
  } catch (err) {
    console.error("LOGIN ERROR:", err);
    throw err;
  }
}

/* ================= VERIFY OTP ================= */
async function handleVerifyOtp(body, res) {
  const { identifier, otp } = body;
  const now = Date.now();

  try {
    const emailLower = identifier.toLowerCase().trim();
    const snap = await usersCollection.where("email", "==", emailLower).limit(1).get();

    if (snap.empty) return res.status(400).json({ error: "Invalid code" });

    const userDoc = snap.docs[0];
    const userData = userDoc.data();

    if (userData.otpLockUntil && now < userData.otpLockUntil) {
      return res.status(429).json({ error: "Account locked for 24h due to many failed attempts." });
    }

    if (!userData.otpExpires || now > userData.otpExpires) {
      return res.status(400).json({ error: "Code expired" });
    }

    if (userData.otp !== otp.toString().trim()) {
      let attempts = (userData.otpAttempts || 0) + 1;
      const updateData = { otpAttempts: attempts };
      if (attempts >= MAX_ATTEMPTS) updateData.otpLockUntil = now + LOCK_TIME;
      
      await userDoc.ref.update(updateData);
      return res.status(400).json({ error: attempts >= MAX_ATTEMPTS ? "Too many attempts. Locked for 24h." : "Invalid code" });
    }

    await userDoc.ref.update({ emailVerified: true, otp: null, otpExpires: null, otpAttempts: 0, otpLockUntil: null });
    return res.status(200).json({ success: true });
  } catch (err) {
    throw err;
  }
}

/* ================= RESEND OTP ================= */
async function handleResendOtp(body, res) {
  const { identifier } = body;
  const now = Date.now();

  try {
    const emailLower = identifier.toLowerCase().trim();
    const snap = await usersCollection.where("email", "==", emailLower).limit(1).get();
    if (snap.empty) return res.status(200).json({ success: true });

    const userDoc = snap.docs[0];
    const userData = userDoc.data();

    if (userData.emailVerified) return res.status(400).json({ error: "Already verified" });

    const newOTP = generateOTP();
    await userDoc.ref.update({
      otp: newOTP,
      otpExpires: now + EMAIL_OTP_VALIDITY,
      otpAttempts: 0
    });

    await sendOTPEmail(emailLower, newOTP);
    return res.status(200).json({ success: true, message: "New OTP sent" });
  } catch (err) {
    throw err;
  }
}

/* ================= FORGOT PASSWORD REQUEST ================= */
async function handleForgotPasswordRequest(body, res) {
  const { identifier } = body;
  const now = Date.now();

  try {
    const emailLower = identifier.toLowerCase().trim();
    const snap = await usersCollection.where("email", "==", emailLower).limit(1).get();
    if (snap.empty) return res.status(200).json({ success: true });

    const userDoc = snap.docs[0];
    const userData = userDoc.data();
    const resetOTP = generateOTP();

    await userDoc.ref.update({
      resetOTP,
      resetOTPExpires: now + RESET_OTP_VALIDITY,
      resetAttempts: 0,
      resetLockUntil: null
    });

    await sendOTPEmail(emailLower, resetOTP);
    return res.status(200).json({ success: true, message: "Reset code sent" });
  } catch (err) {
    throw err;
  }
}

/* ================= FORGOT PASSWORD RESET ================= */
async function handleForgotPasswordReset(body, res) {
  const { identifier, otp, newPassword } = body;
  const now = Date.now();

  try {
    const emailLower = identifier.toLowerCase().trim();
    const snap = await usersCollection.where("email", "==", emailLower).limit(1).get();
    if (snap.empty) return res.status(400).json({ error: "Invalid code" });

    const userDoc = snap.docs[0];
    const userData = userDoc.data();

    if (userData.resetLockUntil && now < userData.resetLockUntil) {
      return res.status(429).json({ error: "Locked for 24h." });
    }

    if (!userData.resetOTPExpires || now > userData.resetOTPExpires) {
      return res.status(400).json({ error: "Code expired" });
    }

    if (userData.resetOTP !== otp.toString().trim()) {
      let attempts = (userData.resetAttempts || 0) + 1;
      const updateData = { resetAttempts: attempts };
      if (attempts >= MAX_ATTEMPTS) updateData.resetLockUntil = now + LOCK_TIME;
      
      await userDoc.ref.update(updateData);
      return res.status(400).json({ error: "Invalid code" });
    }

    const hashedNewPassword = await bcrypt.hash(newPassword, 12);
    await userDoc.ref.update({
      password: hashedNewPassword,
      resetOTP: null,
      resetOTPExpires: null,
      resetAttempts: 0,
      resetLockUntil: null
    });

    return res.status(200).json({ success: true, message: "Password updated" });
  } catch (err) {
    throw err;
  }
}
