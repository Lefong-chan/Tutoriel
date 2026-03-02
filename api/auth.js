// api/auth.js

import admin from "firebase-admin";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { sendOTPEmail } from "./mailer.js";

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

/* ================= FIREBASE INIT (FIRESTORE) ================= */
if (!admin.apps.length) {
  const serviceAccount = JSON.parse(process.env.FIREBASE_KEY);
  if (serviceAccount.private_key) {
    serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, "\n");
  }
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    // databaseURL n'est plus nécessaire pour Firestore, mais on peut le laisser si utilisé ailleurs
  });
}
const db = admin.firestore();  // <- Firestore instance
const usersCollection = db.collection("users");

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

      const existingEmail = await usersCollection
        .where("email", "==", emailLower)
        .limit(1)
        .get();

      if (!existingEmail.empty) {
        return res.status(400).json({ error: "Account already exists" });
      }
    }

    if (phone) {
      phoneClean = phone.trim();
      if (!phoneRegex.test(phoneClean)) {
        return res.status(400).json({ error: "Invalid phone format" });
      }

      const existingPhone = await usersCollection
        .where("phone", "==", phoneClean)
        .limit(1)
        .get();

      if (!existingPhone.empty) {
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

    await usersCollection.doc(uid).set({
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
      resetRequestCount: 0,
      resetRequestWindowStart: now,

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

    let query = null;

    if (emailRegex.test(value)) {
      query = usersCollection.where("email", "==", value.toLowerCase()).limit(1);
    } else if (phoneRegex.test(value)) {
      query = usersCollection.where("phone", "==", value).limit(1);
    } else {
      return res.status(400).json({ error: "Invalid email or phone format" });
    }

    const snap = await query.get();

    if (snap.empty) {
      await new Promise(r => setTimeout(r, 300));
      return res.status(400).json({ error: "Invalid credentials" });
    }

    const userDoc = snap.docs[0];
    const userData = userDoc.data();

    if (emailRegex.test(value) && userData.otpLockUntil && now < userData.otpLockUntil) {
      const retryAfter = Math.ceil((userData.otpLockUntil - now) / 1000);
      return res.status(429).json({
        error: "Too many verification attempts. Try again later.",
        emailBlocked: true,
        retryAfter
      });
    }

    if (phoneRegex.test(value) && userData.phoneOtpBlockUntil && now < userData.phoneOtpBlockUntil) {
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
      await userDoc.ref.update({
        loginAttempts: attempts + 1,
        loginWindowStart: windowStart
      });
      return res.status(400).json({ error: "Invalid credentials" });
    }

    if (emailRegex.test(value) && !userData.emailVerified) {
      return res.status(403).json({ error: "Email not verified", emailNotVerified: true });
    }

    if (phoneRegex.test(value) && !userData.phoneVerified) {
      return res.status(403).json({ error: "Phone not verified", phoneNotVerified: true });
    }

    await userDoc.ref.update({
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

    const snap = await usersCollection
      .where("email", "==", cleanIdentifier)
      .limit(1)
      .get();

    if (snap.empty) {
      await new Promise(r => setTimeout(r, 300));
      return res.status(400).json({ error: "Invalid code" });
    }

    const userDoc = snap.docs[0];
    const userData = userDoc.data();

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
      await userDoc.ref.update({ otpAttempts: 0 });
      return res.status(400).json({ error: "Code expired" });
    }

    if (!userData.otp || userData.otp !== cleanOtp) {
      let attempts = (userData.otpAttempts || 0) + 1;
      const updateData = { otpAttempts: attempts };

      if (attempts >= MAX_ATTEMPTS) {
        updateData.otpLockUntil = now + LOCK_TIME;
      }

      await userDoc.ref.update(updateData);

      if (attempts >= MAX_ATTEMPTS) {
        return res.status(429).json({
          error: "Too many attempts. Account locked for 1 hour.",
          retryAfter: 3600
        });
      }

      return res.status(400).json({ error: "Invalid code" });
    }

    await userDoc.ref.update({
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

    const snap = await usersCollection
      .where("phone", "==", cleanPhone)
      .limit(1)
      .get();

    if (snap.empty) {
      await new Promise(r => setTimeout(r, 300));
      return res.status(400).json({ error: "Invalid code" });
    }

    const userDoc = snap.docs[0];
    const userData = userDoc.data();

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
      await userDoc.ref.update({ phoneOtpAttempts: 0 });
      return res.status(400).json({ error: "Invalid code" });
    }

    if (!userData.phoneOTP || userData.phoneOTP !== cleanOtp) {
      let attempts = (userData.phoneOtpAttempts || 0) + 1;
      const updateData = { phoneOtpAttempts: attempts };

      if (attempts >= MAX_ATTEMPTS) {
        updateData.phoneOtpBlockUntil = now + LOCK_TIME;
      }

      await userDoc.ref.update(updateData);

      if (attempts >= MAX_ATTEMPTS) {
        return res.status(429).json({
          error: "Too many attempts. Account locked for 1 hour.",
          retryAfter: 3600
        });
      }

      return res.status(400).json({ error: "Invalid code" });
    }

    await userDoc.ref.update({
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

    const snap = await usersCollection
      .where("email", "==", cleanIdentifier)
      .limit(1)
      .get();

    if (snap.empty) {
      return res.status(200).json({ success: true });
    }

    const userDoc = snap.docs[0];
    const userData = userDoc.data();
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

    await userDoc.ref.update({
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

    const snap = await usersCollection
      .where("phone", "==", cleanPhone)
      .limit(1)
      .get();

    if (snap.empty) {
      return res.status(200).json({
        success: true,
        message: "If the account exists, a code was sent."
      });
    }

    const userDoc = snap.docs[0];
    const userData = userDoc.data();
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

    await userDoc.ref.update({
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

    let query = null;
    let isEmail = false;

    if (emailRegex.test(value)) {
      isEmail = true;
      query = usersCollection.where("email", "==", value.toLowerCase()).limit(1);
    } else if (phoneRegex.test(value)) {
      isEmail = false;
      query = usersCollection.where("phone", "==", value).limit(1);
    } else {
      return res.status(400).json({ error: "Invalid email or phone format" });
    }

    const snap = await query.get();

    if (snap.empty) {
      return res.status(200).json({ success: true });
    }

    const userDoc = snap.docs[0];
    const userData = userDoc.data();

    if (userData.provider !== "local") {
      return res.status(400).json({ error: "Cannot reset password for this account" });
    }

    if (userData.resetLockUntil && now < userData.resetLockUntil) {
      const retryAfter = Math.ceil((userData.resetLockUntil - now) / 1000);
      return res.status(429).json({
        error: "Too many attempts. Try again later.",
        retryAfter
      });
    }

    if (userData.resetOTPExpires && now < userData.resetOTPExpires) {
      const retryAfter = Math.ceil((userData.resetOTPExpires - now) / 1000);
      return res.status(429).json({
        error: "Please wait before requesting a new code",
        retryAfter
      });
    }

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

    const resetOTP = generateOTP();
    const resetOTPExpires = now + RESET_OTP_VALIDITY;

    await userDoc.ref.update({
      resetOTP,
      resetOTPExpires,
      resetAttempts: 0,
      resetLockUntil: null,
      resetRequestCount: resetRequestCount + 1,
      resetRequestWindowStart
    });

    if (isEmail) {
      await sendOTPEmail(value.toLowerCase(), resetOTP);
    } else {
      await sendPhoneOTP(value, resetOTP);
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
    
    let query = null;
    
    if (emailRegex.test(value)) {
      query = usersCollection.where("email", "==", value.toLowerCase()).limit(1);
    } else if (phoneRegex.test(value)) {
      query = usersCollection.where("phone", "==", value).limit(1);
    } else {
      return res.status(400).json({ error: "Invalid email or phone format" });
    }
    
    const snap = await query.get();
    
    if (snap.empty) {
      await new Promise(r => setTimeout(r, 300));
      return res.status(400).json({ error: "Invalid code" });
    }
    
    const userDoc = snap.docs[0];
    const userData = userDoc.data();
    
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
      await userDoc.ref.update({ resetAttempts: 0 });
      return res.status(400).json({ error: "Code expired" });
    }
    
    if (!userData.resetOTP || userData.resetOTP !== cleanOtp) {
      let attempts = (userData.resetAttempts || 0) + 1;
      const updateData = { resetAttempts: attempts };
      
      if (attempts >= MAX_ATTEMPTS) {
        updateData.resetLockUntil = now + LOCK_TIME;
      }
      
      await userDoc.ref.update(updateData);
      
      if (attempts >= MAX_ATTEMPTS) {
        return res.status(429).json({
          error: "Too many attempts. Account locked for 1 hour.",
          retryAfter: 3600
        });
      }
      
      return res.status(400).json({ error: "Invalid code" });
    }
    
    if (isVerifyOnly) {
      await userDoc.ref.update({
        resetAttempts: 0
      });
      return res.status(200).json({ success: true, message: "Code verified" });
    }
    
    const hashedNewPassword = await bcrypt.hash(newPassword, 12);
    
    await userDoc.ref.update({
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

/* ================= ADMIN PHONE OTP ================= */
async function handleAdminPhoneOtp(body, res) {
  const { password, type } = body;

  if (!password || password !== PANEL_PASSWORD) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    let query = usersCollection;
    const snapshot = await query.get();

    if (snapshot.empty) {
      return res.json([]);
    }

    const result = [];

    snapshot.forEach(doc => {
      const u = doc.data();
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
