// api/auth.js

import admin from "firebase-admin";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { sendOTPEmail } from "./mailer.js";

// Fake SMS (admin no mandefa manually)
async function sendPhoneOTP(phone, otp) {
  console.log(`[FAKE SMS] To: ${phone} | Code: ${otp} (à envoyer manuellement)`);
  return Promise.resolve();
}

/* ================= ENV ================= */
const SECRET = process.env.JWT_SECRET;
const allowedOrigin = process.env.ALLOWED_ORIGIN;
const isProd = process.env.NODE_ENV === "production";
const PANEL_PASSWORD = process.env.ADMIN_PANEL_PASSWORD;

if (!SECRET) throw new Error("JWT_SECRET not set");
if (!process.env.FIREBASE_KEY) throw new Error("FIREBASE_KEY not set");
if (!PANEL_PASSWORD) throw new Error("ADMIN_PANEL_PASSWORD not set");

/* ================= FIREBASE INIT ================= */
if (!admin.apps.length) {
  const serviceAccount = JSON.parse(process.env.FIREBASE_KEY);
  if (serviceAccount.private_key) {
    serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, "\n");
  }
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: "https://tutoriel-ff487-default-rtdb.firebaseio.com/"
  });
}
const db = admin.database();

/* ================= CONFIG ================= */
const EMAIL_OTP_VALIDITY = 60 * 1000;          // 1 min (verification)
const PHONE_OTP_VALIDITY = 5 * 60 * 1000;      // 5 min (verification)
const RESET_OTP_VALIDITY = 10 * 60 * 1000;     // 10 min (forgot password)
const MAX_ATTEMPTS = 5;
const LOCK_TIME = 60 * 60 * 1000;              // 1 hour
const MAX_RESEND_PER_HOUR = 5;
const ONE_MINUTE = 60 * 1000;
const FIVE_MINUTES = 5 * 60 * 1000;
const ONE_HOUR = 60 * 60 * 1000;
const MAX_LOGIN_ATTEMPTS = 10;
const LOGIN_WINDOW_MS = 10 * 60 * 1000;        // 10 minutes

/* ================= REGEX ================= */
const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const phoneRegex = /^(\+261|0)[0-9]{9}$/;

/* ================= HELPERS ================= */
async function generateUID() {
  let uid;
  let snap;
  do {
    uid = Math.floor(100000000 + Math.random() * 900000000).toString();
    snap = await db.ref("users/" + uid).get();
  } while (snap.exists());
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
      case "verify-otp-phone":
        return await handleVerifyOtpPhone(payload, res);
      case "resend-otp":
        return await handleResendOtp(payload, res);
      case "resend-otp-phone":
        return await handleResendOtpPhone(payload, res);
      case "admin-phone-otp":
        return await handleAdminPhoneOtp(payload, res);
      
      // NOUVEAU : forgot password
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
  const { email, phone, password } = body;

  if ((!email && !phone) || !password || password.length < 6) {
    return res.status(400).json({
      error: "Email or phone and valid password required"
    });
  }

  try {
    let emailLower = null;
    let phoneClean = null;

    if (email) {
      emailLower = email.toLowerCase().trim();
      if (!emailRegex.test(emailLower)) {
        return res.status(400).json({ error: "Invalid email format" });
      }

      const existingEmail = await db
        .ref("users")
        .orderByChild("email")
        .equalTo(emailLower)
        .limitToFirst(1)
        .get();

      if (existingEmail.exists()) {
        return res.status(400).json({ error: "Account already exists" });
      }
    }

    if (phone) {
      phoneClean = phone.trim();
      if (!phoneRegex.test(phoneClean)) {
        return res.status(400).json({ error: "Invalid phone format" });
      }

      const existingPhone = await db
        .ref("users")
        .orderByChild("phone")
        .equalTo(phoneClean)
        .limitToFirst(1)
        .get();

      if (existingPhone.exists()) {
        return res.status(400).json({ error: "Account already exists" });
      }
    }

    const hashedPassword = await bcrypt.hash(password, 12);
    const uid = await generateUID();
    const now = Date.now();

    const emailOTP = emailLower ? generateOTP() : null;
    const emailOTPExpires = emailLower ? now + EMAIL_OTP_VALIDITY : null;
    const phoneOTP = phoneClean ? generateOTP() : null;
    const phoneOTPExpires = phoneClean ? now + PHONE_OTP_VALIDITY : null;

    await db.ref("users/" + uid).set({
      uid,
      email: emailLower,
      phone: phoneClean,
      password: hashedPassword,
      provider: "local",

      emailVerified: emailLower ? false : true,
      otp: emailOTP,
      otpExpires: emailOTPExpires,
      resendCount: 0,
      resendWindowStart: now,
      otpAttempts: 0,
      otpLockUntil: null,

      phoneVerified: phoneClean ? false : true,
      phoneOTP,
      phoneOTPExpires,
      phoneResendCount: 0,
      phoneResendWindowStart: now,
      phoneOtpAttempts: 0,
      phoneOtpBlockUntil: null,

      // Pour le forgot password
      resetOTP: null,
      resetOTPExpires: null,
      resetAttempts: 0,
      resetLockUntil: null,

      loginAttempts: 0,
      loginWindowStart: null,

      createdAt: now
    });

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
    throw err;
  }
}

/* ================= LOGIN ================= */
async function handleLogin(body, res) {
  const { identifier, password } = body;

  if (!identifier || !password) {
    return res.status(400).json({ error: "Invalid credentials" });
  }

  try {
    const value = identifier.trim();
    const now = Date.now();

    let loginType = null;
    let snap = null;

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
      return res.status(400).json({ error: "Invalid email or phone format" });
    }

    if (!snap.exists()) {
      await new Promise(r => setTimeout(r, 300));
      return res.status(400).json({ error: "Invalid credentials" });
    }

    const userData = Object.values(snap.val())[0];

    if (loginType === "email" && userData.otpLockUntil && now < userData.otpLockUntil) {
      const retryAfter = Math.ceil((userData.otpLockUntil - now) / 1000);
      return res.status(429).json({
        error: "Too many verification attempts. Try again later.",
        emailBlocked: true,
        retryAfter
      });
    }

    if (loginType === "phone" && userData.phoneOtpBlockUntil && now < userData.phoneOtpBlockUntil) {
      const retryAfter = Math.ceil((userData.phoneOtpBlockUntil - now) / 1000);
      return res.status(429).json({
        error: "Too many verification attempts. Try again later.",
        phoneBlocked: true,
        retryAfter
      });
    }

    let attempts = userData.loginAttempts || 0;
    let windowStart = userData.loginWindowStart ?? now;

    if (now - windowStart > LOGIN_WINDOW_MS) {
      attempts = 0;
      windowStart = now;
    }

    if (attempts >= MAX_LOGIN_ATTEMPTS) {
      return res.status(429).json({ error: "Too many login attempts. Try later." });
    }

    if (userData.provider !== "local") {
      return res.status(400).json({ error: "Use correct login method" });
    }

    const isMatch = await bcrypt.compare(password, userData.password);

    if (!isMatch) {
      await db.ref("users/" + userData.uid).update({
        loginAttempts: attempts + 1,
        loginWindowStart: windowStart
      });
      return res.status(400).json({ error: "Invalid credentials" });
    }

    if (loginType === "email" && !userData.emailVerified) {
      return res.status(403).json({ error: "Email not verified", emailNotVerified: true });
    }

    if (loginType === "phone" && !userData.phoneVerified) {
      return res.status(403).json({ error: "Phone not verified", phoneNotVerified: true });
    }

    await db.ref("users/" + userData.uid).update({
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

    res.setHeader("Set-Cookie", cookieOptions.join("; "));

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
    throw err;
  }
}

/* ================= VERIFY OTP (EMAIL) ================= */
async function handleVerifyOtp(body, res) {
  const { identifier, otp } = body;

  if (!identifier || !otp) {
    return res.status(400).json({ error: "Email and OTP required" });
  }

  try {
    const cleanIdentifier = identifier.toLowerCase().trim();
    const cleanOtp = otp.toString().trim();
    const now = Date.now();

    const snap = await db
      .ref("users")
      .orderByChild("email")
      .equalTo(cleanIdentifier)
      .limitToFirst(1)
      .get();

    if (!snap.exists()) {
      await new Promise(r => setTimeout(r, 300));
      return res.status(400).json({ error: "Invalid code" });
    }

    const userData = Object.values(snap.val())[0];
    const userRef = db.ref("users/" + userData.uid);

    if (userData.provider !== "local") {
      return res.status(400).json({ error: "Invalid account type" });
    }

    if (userData.emailVerified) {
      return res.status(400).json({ error: "Email already verified" });
    }

    if (userData.otpLockUntil && now < userData.otpLockUntil) {
      const retryAfter = Math.ceil((userData.otpLockUntil - now) / 1000);
      return res.status(429).json({
        error: "Too many attempts. Try again later.",
        retryAfter
      });
    }

    if (!userData.otpExpires || now > userData.otpExpires) {
      await userRef.update({ otpAttempts: 0 });
      return res.status(400).json({ error: "Code expired" });
    }

    if (!userData.otp || userData.otp !== cleanOtp) {
      let attempts = (userData.otpAttempts || 0) + 1;
      const updateData = { otpAttempts: attempts };

      if (attempts >= MAX_ATTEMPTS) {
        updateData.otpLockUntil = now + LOCK_TIME;
      }

      await userRef.update(updateData);

      if (attempts >= MAX_ATTEMPTS) {
        return res.status(429).json({
          error: "Too many attempts. Account locked for 1 hour.",
          retryAfter: 3600
        });
      }

      return res.status(400).json({ error: "Invalid code" });
    }

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

    res.setHeader("Set-Cookie", cookieOptions.join("; "));

    return res.status(200).json({ success: true });
  } catch (err) {
    console.error("VERIFY OTP ERROR:", err);
    throw err;
  }
}

/* ================= VERIFY OTP PHONE ================= */
async function handleVerifyOtpPhone(body, res) {
  const { phone, otp } = body;

  if (!phone || !otp) {
    return res.status(400).json({ error: "Invalid code" });
  }

  try {
    const cleanPhone = phone.trim();
    const cleanOtp = otp.toString().trim();
    const now = Date.now();

    const snap = await db
      .ref("users")
      .orderByChild("phone")
      .equalTo(cleanPhone)
      .limitToFirst(1)
      .get();

    if (!snap.exists()) {
      await new Promise(r => setTimeout(r, 300));
      return res.status(400).json({ error: "Invalid code" });
    }

    const userData = Object.values(snap.val())[0];
    const userRef = db.ref("users/" + userData.uid);

    if (userData.provider !== "local" || userData.phoneVerified) {
      return res.status(400).json({ error: "Invalid code" });
    }

    if (userData.phoneOtpBlockUntil && now < userData.phoneOtpBlockUntil) {
      const retryAfter = Math.ceil((userData.phoneOtpBlockUntil - now) / 1000);
      return res.status(429).json({
        error: "Too many attempts. Try again later.",
        retryAfter
      });
    }

    if (!userData.phoneOTPExpires || now > userData.phoneOTPExpires) {
      await userRef.update({ phoneOtpAttempts: 0 });
      return res.status(400).json({ error: "Invalid code" });
    }

    if (!userData.phoneOTP || userData.phoneOTP !== cleanOtp) {
      let attempts = (userData.phoneOtpAttempts || 0) + 1;
      const updateData = { phoneOtpAttempts: attempts };

      if (attempts >= MAX_ATTEMPTS) {
        updateData.phoneOtpBlockUntil = now + LOCK_TIME;
      }

      await userRef.update(updateData);

      if (attempts >= MAX_ATTEMPTS) {
        return res.status(429).json({
          error: "Too many attempts. Account locked for 1 hour.",
          retryAfter: 3600
        });
      }

      return res.status(400).json({ error: "Invalid code" });
    }

    await userRef.update({
      phoneVerified: true,
      phoneOTP: null,
      phoneOTPExpires: null,
      phoneOtpAttempts: 0,
      phoneOtpBlockUntil: null
    });

    const token = jwt.sign(
      {
        uid: userData.uid,
        phone: userData.phone,
        provider: userData.provider
      },
      SECRET,
      { expiresIn: "7d" }
    );

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

    res.setHeader("Set-Cookie", cookieOptions.join("; "));

    return res.status(200).json({ success: true });
  } catch (err) {
    console.error("VERIFY PHONE OTP ERROR:", err);
    throw err;
  }
}

/* ================= RESEND OTP (EMAIL) ================= */
async function handleResendOtp(body, res) {
  const { identifier } = body;

  if (!identifier) {
    return res.status(400).json({ error: "Identifier required" });
  }

  try {
    const cleanIdentifier = identifier.toLowerCase().trim();

    if (!emailRegex.test(cleanIdentifier)) {
      return res.status(400).json({ error: "Invalid email format" });
    }

    const snap = await db
      .ref("users")
      .orderByChild("email")
      .equalTo(cleanIdentifier)
      .limitToFirst(1)
      .get();

    if (!snap.exists()) {
      return res.status(200).json({ success: true });
    }

    const userData = Object.values(snap.val())[0];
    const userRef = db.ref("users/" + userData.uid);
    const now = Date.now();

    if (userData.provider !== "local") {
      return res.status(400).json({ error: "OTP not required for this account" });
    }

    if (userData.emailVerified) {
      return res.status(400).json({ error: "Email already verified" });
    }

    if (userData.otpExpires && now < userData.otpExpires) {
      const retryAfter = Math.ceil((userData.otpExpires - now) / 1000);
      return res.status(429).json({
        error: "Please wait before requesting a new OTP",
        retryAfter
      });
    }

    let resendCount = userData.resendCount || 0;
    let resendWindowStart = userData.resendWindowStart || now;

    if (now - resendWindowStart >= ONE_HOUR) {
      resendCount = 0;
      resendWindowStart = now;
    }

    if (resendCount >= MAX_RESEND_PER_HOUR) {
      const retryAfter = Math.ceil((ONE_HOUR - (now - resendWindowStart)) / 1000);
      return res.status(429).json({
        error: "Too many OTP requests. Try again later.",
        retryAfter
      });
    }

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
      remainingResends: MAX_RESEND_PER_HOUR - (resendCount + 1)
    });
  } catch (err) {
    console.error("RESEND OTP ERROR:", err);
    throw err;
  }
}

/* ================= RESEND OTP PHONE ================= */
async function handleResendOtpPhone(body, res) {
  const { phone } = body;

  if (!phone) {
    return res.status(400).json({ error: "Phone required" });
  }

  try {
    const cleanPhone = phone.trim();

    if (!phoneRegex.test(cleanPhone)) {
      return res.status(400).json({ error: "Invalid phone format" });
    }

    const snap = await db
      .ref("users")
      .orderByChild("phone")
      .equalTo(cleanPhone)
      .limitToFirst(1)
      .get();

    if (!snap.exists()) {
      return res.status(200).json({
        success: true,
        message: "If the account exists, a code was sent."
      });
    }

    const userData = Object.values(snap.val())[0];
    const userRef = db.ref("users/" + userData.uid);
    const now = Date.now();

    if (userData.provider !== "local") {
      return res.status(400).json({ error: "OTP not required for this account" });
    }

    if (userData.phoneVerified) {
      return res.status(400).json({ error: "Phone already verified" });
    }

    if (userData.phoneOTPExpires && now < userData.phoneOTPExpires) {
      const retryAfter = Math.ceil((userData.phoneOTPExpires - now) / 1000);
      return res.status(429).json({
        error: "Please wait before requesting a new code",
        retryAfter
      });
    }

    let resendCount = userData.phoneResendCount || 0;
    let resendWindowStart = userData.phoneResendWindowStart || now;

    if (now - resendWindowStart >= ONE_HOUR) {
      resendCount = 0;
      resendWindowStart = now;
    }

    if (resendCount >= MAX_RESEND_PER_HOUR) {
      const retryAfter = Math.ceil((ONE_HOUR - (now - resendWindowStart)) / 1000);
      return res.status(429).json({
        error: "Too many OTP requests. Try again later.",
        retryAfter
      });
    }

    const newOTP = generateOTP();
    const newExpiry = now + FIVE_MINUTES;

    await userRef.update({
      phoneOTP: newOTP,
      phoneOTPExpires: newExpiry,
      phoneResendCount: resendCount + 1,
      phoneResendWindowStart: resendWindowStart,
      phoneOtpAttempts: 0,
      phoneOtpBlockUntil: null
    });

    await sendPhoneOTP(cleanPhone, newOTP);

    return res.status(200).json({
      success: true,
      message: "New OTP sent",
      remainingResends: MAX_RESEND_PER_HOUR - (resendCount + 1)
    });
  } catch (err) {
    console.error("RESEND PHONE OTP ERROR:", err);
    throw err;
  }
}

/* ================= FORGOT PASSWORD : DEMANDE DE CODE ================= */
async function handleForgotPasswordRequest(body, res) {
  const { identifier } = body;

  if (!identifier) {
    return res.status(400).json({ error: "Identifier required" });
  }

  try {
    const value = identifier.trim();
    const now = Date.now();

    let snap = null;
    let isEmail = false;
    let cleanIdentifier = null;

    // Détection du type (email ou phone)
    if (emailRegex.test(value)) {
      isEmail = true;
      cleanIdentifier = value.toLowerCase();
      snap = await db
        .ref("users")
        .orderByChild("email")
        .equalTo(cleanIdentifier)
        .limitToFirst(1)
        .get();
    } else if (phoneRegex.test(value)) {
      isEmail = false;
      cleanIdentifier = value;
      snap = await db
        .ref("users")
        .orderByChild("phone")
        .equalTo(cleanIdentifier)
        .limitToFirst(1)
        .get();
    } else {
      return res.status(400).json({ error: "Invalid email or phone format" });
    }

    // Sécurité : ne pas révéler si le compte existe
    if (!snap.exists()) {
      return res.status(200).json({ success: true });
    }

    const userData = Object.values(snap.val())[0];
    const userRef = db.ref("users/" + userData.uid);

    // Vérifier que le compte est local
    if (userData.provider !== "local") {
      return res.status(400).json({ error: "Cannot reset password for this account" });
    }

    // Vérifier si l'utilisateur est bloqué (trop de tentatives de reset)
    if (userData.resetLockUntil && now < userData.resetLockUntil) {
      const retryAfter = Math.ceil((userData.resetLockUntil - now) / 1000);
      return res.status(429).json({
        error: "Too many attempts. Try again later.",
        retryAfter
      });
    }

    // Vérifier le cooldown (ne pas envoyer de code trop souvent)
    if (userData.resetOTPExpires && now < userData.resetOTPExpires) {
      const retryAfter = Math.ceil((userData.resetOTPExpires - now) / 1000);
      return res.status(429).json({
        error: "Please wait before requesting a new code",
        retryAfter
      });
    }

    // Limite de 5 demandes par heure (comme pour les OTP de vérification)
    let resetRequestCount = userData.resetRequestCount || 0;
    let resetRequestWindowStart = userData.resetRequestWindowStart || now;

    if (now - resetRequestWindowStart >= ONE_HOUR) {
      resetRequestCount = 0;
      resetRequestWindowStart = now;
    }

    if (resetRequestCount >= MAX_RESEND_PER_HOUR) {
      const retryAfter = Math.ceil((ONE_HOUR - (now - resetRequestWindowStart)) / 1000);
      return res.status(429).json({
        error: "Too many reset requests. Try again later.",
        retryAfter
      });
    }

    // Générer un nouveau code de réinitialisation
    const resetOTP = generateOTP();
    const resetOTPExpires = now + RESET_OTP_VALIDITY;

    await userRef.update({
      resetOTP,
      resetOTPExpires,
      resetAttempts: 0,
      resetLockUntil: null,
      resetRequestCount: resetRequestCount + 1,
      resetRequestWindowStart
    });

    // Envoyer le code (email ou fake SMS)
    if (isEmail) {
      await sendOTPEmail(cleanIdentifier, resetOTP); // Réutilise la même fonction d'envoi d'email
    } else {
      await sendPhoneOTP(cleanIdentifier, resetOTP); // Fake SMS
    }

    return res.status(200).json({
      success: true,
      message: "Reset code sent"
    });

  } catch (err) {
    console.error("FORGOT PASSWORD REQUEST ERROR:", err);
    throw err;
  }
}

/* ================= FORGOT PASSWORD : RÉINITIALISATION ================= */
async function handleForgotPasswordReset(body, res) {
  const { identifier, otp, newPassword } = body;
  
  if (!identifier || !otp || !newPassword) {
    return res.status(400).json({ error: "Identifier, OTP and new password required" });
  }
  
  const isVerifyOnly = (newPassword === "VERIFY_ONLY");
  
  if (!isVerifyOnly && newPassword.length < 6) {
    return res.status(400).json({ error: "Password must be at least 6 characters" });
  }
  
  try {
    const value = identifier.trim();
    const cleanOtp = otp.toString().trim();
    const now = Date.now();
    
    let snap = null;
    let cleanIdentifier = null;
    
    if (emailRegex.test(value)) {
      cleanIdentifier = value.toLowerCase();
      snap = await db
        .ref("users")
        .orderByChild("email")
        .equalTo(cleanIdentifier)
        .limitToFirst(1)
        .get();
    } else if (phoneRegex.test(value)) {
      cleanIdentifier = value;
      snap = await db
        .ref("users")
        .orderByChild("phone")
        .equalTo(cleanIdentifier)
        .limitToFirst(1)
        .get();
    } else {
      return res.status(400).json({ error: "Invalid email or phone format" });
    }
    
    if (!snap.exists()) {
      await new Promise(r => setTimeout(r, 300));
      return res.status(400).json({ error: "Invalid code" });
    }
    
    const userData = Object.values(snap.val())[0];
    const userRef = db.ref("users/" + userData.uid);
    
    if (userData.provider !== "local") {
      return res.status(400).json({ error: "Invalid account type" });
    }
    
    if (userData.resetLockUntil && now < userData.resetLockUntil) {
      const retryAfter = Math.ceil((userData.resetLockUntil - now) / 1000);
      return res.status(429).json({
        error: "Too many attempts. Try again later.",
        retryAfter
      });
    }
    
    if (!userData.resetOTPExpires || now > userData.resetOTPExpires) {
      await userRef.update({ resetAttempts: 0 });
      return res.status(400).json({ error: "Code expired" });
    }
    
    if (!userData.resetOTP || userData.resetOTP !== cleanOtp) {
      let attempts = (userData.resetAttempts || 0) + 1;
      const updateData = { resetAttempts: attempts };
      
      if (attempts >= MAX_ATTEMPTS) {
        updateData.resetLockUntil = now + LOCK_TIME;
      }
      
      await userRef.update(updateData);
      
      if (attempts >= MAX_ATTEMPTS) {
        return res.status(429).json({
          error: "Too many attempts. Account locked for 1 hour.",
          retryAfter: 3600
        });
      }
      
      return res.status(400).json({ error: "Invalid code" });
    }
    
    // ✅ Si c'est une simple vérification (sans changement de mot de passe)
    if (isVerifyOnly) {
      // On réinitialise les tentatives mais on garde le code (il n'est pas consommé)
      await userRef.update({
        resetAttempts: 0
        // On ne touche pas à resetOTP, resetOTPExpires
      });
      return res.status(200).json({ success: true, message: "Code verified" });
    }
    
    // Sinon, on change le mot de passe
    const hashedNewPassword = await bcrypt.hash(newPassword, 12);
    
    await userRef.update({
      password: hashedNewPassword,
      resetOTP: null,
      resetOTPExpires: null,
      resetAttempts: 0,
      resetLockUntil: null
    });
    
    return res.status(200).json({
      success: true,
      message: "Password updated successfully"
    });
    
  } catch (err) {
    console.error("FORGOT PASSWORD RESET ERROR:", err);
    throw err;
  }
}

/* ================= ADMIN PHONE OTP (reste inchangé) ================= */
async function handleAdminPhoneOtp(body, res) {
  const { password, type } = body;

  if (!password || password !== PANEL_PASSWORD) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    const snap = await db.ref("users").get();

    if (!snap.exists()) {
      return res.json([]);
    }

    const users = snap.val();
    const result = [];

    Object.values(users).forEach(u => {
      if (type === "phone" && u.phone && u.phoneOTP && !u.phoneVerified) {
        result.push({
          uid: u.uid,
          identifier: u.phone,
          otp: u.phoneOTP,
          expires: u.phoneOTPExpires
        });
      }

      if (type === "email" && u.email && u.otp && !u.emailVerified) {
        result.push({
          uid: u.uid,
          identifier: u.email,
          otp: u.otp,
          expires: u.otpExpires
        });
      }
    });

    return res.json(result);
  } catch (err) {
    console.error("Admin OTP error:", err);
    return res.status(500).json({ error: "Server error" });
  }
}
