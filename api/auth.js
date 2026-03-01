// ================= IMPORTS =================

import admin from "firebase-admin";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { sendOTPEmail } from "./mailer.js";
import { sendPhoneOTP } from "./sms.js";

// ================= ENV =================

const SECRET = process.env.JWT_SECRET;
const isProd = process.env.NODE_ENV === "production";
const allowedOrigin = process.env.ALLOWED_ORIGIN;

if (!process.env.FIREBASE_KEY)
  throw new Error("FIREBASE_KEY not set");

if (!SECRET)
  throw new Error("JWT_SECRET not set");

// ================= FIREBASE INIT =================

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

// ================= CONFIG =================

const EMAIL_OTP_VALIDITY = 60 * 1000;
const PHONE_OTP_VALIDITY = 5 * 60 * 1000;

const MAX_ATTEMPTS = 5;
const LOGIN_MAX_ATTEMPTS = 10;
const LOCK_TIME = 60 * 60 * 1000;

const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const phoneRegex = /^(\+261|0)[0-9]{9}$/;

// ================= HELPERS =================

function generateOTP() {
  return Math.floor(
    100000 + Math.random() * 900000
  ).toString();
}

async function generateUID() {
  
  let uid;
  let snap;
  
  do {
    
    uid = Math.floor(
      100000000 + Math.random() * 900000000
    ).toString();
    
    snap = await db
      .ref("users/" + uid)
      .get();
    
  } while (snap.exists());
  
  return uid;
}

// ================= HANDLERS =================

// REGISTER
async function handleRegister(req, res) {
  
  const { email, phone, password } = req.body || {};
  
  if ((!email && !phone) || !password || password.length < 6)
    return res.status(400).json({
      error: "Email or phone and valid password required"
    });
  
  try {
    
    const now = Date.now();
    
    let emailLower = null;
    let phoneClean = null;
    
    /* ===============================
       EMAIL VALIDATION
    =============================== */
    
    if (email) {
      
      emailLower = email.toLowerCase().trim();
      
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
    
    /* ===============================
       PHONE VALIDATION
    =============================== */
    
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
    
    /* ===============================
       PASSWORD HASH
    =============================== */
    
    const hashedPassword = await bcrypt.hash(password, 12);
    
    const uid = await generateUID();
    
    /* ===============================
       OTP GENERATION
    =============================== */
    
    const emailOTP = emailLower ? generateOTP() : null;
    const emailOTPExpires = emailLower ?
      now + EMAIL_OTP_VALIDITY :
      null;
    
    const phoneOTP = phoneClean ? generateOTP() : null;
    const phoneOTPExpires = phoneClean ?
      now + PHONE_OTP_VALIDITY :
      null;
    
    /* ===============================
       SAVE USER
    =============================== */
    
    await db.ref("users/" + uid).set({
      
      uid,
      provider: "local",
      createdAt: now,
      
      email: emailLower,
      phone: phoneClean,
      password: hashedPassword,
      
      /* ===== EMAIL ===== */
      
      emailVerified: emailLower ? false : true,
      otp: emailOTP,
      otpExpires: emailOTPExpires,
      otpAttempts: 0,
      otpLockUntil: null,
      
      resendCount: 0,
      resendWindowStart: now,
      
      /* ===== PHONE ===== */
      
      phoneVerified: phoneClean ? false : true,
      phoneOTP,
      phoneOTPExpires,
      phoneOtpAttempts: 0,
      phoneOtpBlockUntil: null,
      
      phoneResendCount: 0,
      phoneResendWindowStart: now,
      
      /* ===== LOGIN RATE LIMIT ===== */
      
      loginAttempts: 0,
      loginWindowStart: null
    });
    
    /* ===============================
       SEND OTPs (non blocking safe)
    =============================== */
    
    if (emailLower) {
      try {
        await sendOTPEmail(emailLower, emailOTP);
      } catch (err) {
        console.error("EMAIL SEND ERROR:", err);
      }
    }
    
    if (phoneClean) {
      try {
        await sendPhoneOTP(phoneClean, phoneOTP);
      } catch (err) {
        console.error("SMS SEND ERROR:", err);
      }
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





// LOGIN
async function handleLogin(req, res) {

  const { identifier, password } = req.body || {};

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

    /* == ACCOUNT EXISTS CHECK == */

    if (!snap.exists()) {
      await new Promise(r => setTimeout(r, 300));
      return res.status(400).json({
        error: "Invalid credentials"
      });
    }

    const userData = Object.values(snap.val())[0];

    /* == OTP LOCK CHECK == */

    if (
      loginType === "email" &&
      userData.otpLockUntil &&
      now < userData.otpLockUntil
    ) {
      return res.status(429).json({
        error:
          "Too many verification attempts. Try again later.",
        retryAfter: Math.ceil(
          (userData.otpLockUntil - now) / 1000
        )
      });
    }

    if (
      loginType === "phone" &&
      userData.phoneOtpBlockUntil &&
      now < userData.phoneOtpBlockUntil
    ) {
      return res.status(429).json({
        error:
          "Too many verification attempts. Try again later.",
        retryAfter: Math.ceil(
          (userData.phoneOtpBlockUntil - now) / 1000
        )
      });
    }

    /* == LOGIN RATE LIMIT == */

    const WINDOW_MS = 10 * 60 * 1000;

    let attempts = userData.loginAttempts || 0;
    let windowStart = userData.loginWindowStart;

    if (!windowStart) {
      windowStart = now;
    }

    // Reset raha lany window
    if (now - windowStart > WINDOW_MS) {
      attempts = 0;
      windowStart = now;
    }

    if (attempts >= LOGIN_MAX_ATTEMPTS) {
      return res.status(429).json({
        error: "Too many login attempts. Try later."
      });
    }

    /* == PROVIDER CHECK == */

    if (userData.provider !== "local")
      return res.status(400).json({
        error: "Use correct login method"
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





// VERIFY EMAIL OTP
async function handleVerifyEmailOtp(req, res) {

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

    /* ===== ANTI ENUMERATION ===== */

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

    /* ===== PROVIDER CHECK ===== */

    if (userData.provider !== "local")
      return res.status(400).json({
        error: "Invalid account type"
      });

    /* ===== ALREADY VERIFIED ===== */

    if (userData.emailVerified)
      return res.status(400).json({
        error: "Email already verified"
      });

    /* ===== LOCK CHECK ===== */

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

    /* ===== EXPIRATION CHECK ===== */

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

    /* ===== WRONG OTP ===== */

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
          retryAfter:
            Math.ceil(LOCK_TIME / 1000)
        });
      }

      return res.status(400).json({
        error: "Invalid code"
      });
    }

    /* ===== SUCCESS ===== */

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





// RESEND EMAIL OTP
async function handleResendEmailOtp(req, res) {

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

    /* ===== ANTI ENUMERATION ===== */

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

    /* ===== ACCOUNT TYPE CHECK ===== */

    if (userData.provider !== "local")
      return res.status(400).json({
        error: "OTP not required for this account"
      });

    if (userData.emailVerified)
      return res.status(400).json({
        error: "Email already verified"
      });

    /* ===== 1 MINUTE COOLDOWN ===== */

    if (
      userData.otpExpires &&
      now < userData.otpExpires
    ) {

      const retryAfter = Math.ceil(
        (userData.otpExpires - now) / 1000
      );

      return res.status(429).json({
        error:
          "Please wait before requesting a new OTP",
        retryAfter
      });
    }

    /* ===== 5 PER HOUR LIMIT ===== */

    const MAX_RESEND_PER_HOUR = 5;
    const ONE_HOUR = 60 * 60 * 1000;

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

    /* ===== GENERATE NEW OTP ===== */

    const newOTP = generateOTP();
    const newExpiry = now + EMAIL_OTP_VALIDITY;

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
      "RESEND EMAIL OTP ERROR:",
      err
    );

    return res.status(500).json({
      error: "Server error"
    });
  }
}





// VERIFY PHONE OTP
async function handleVerifyPhoneOtp(req, res) {

  const { phone, otp } = req.body;

  if (!phone || !otp)
    return res.status(400).json({
      error: "Invalid code"
    });

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

    /* ===============================
       ANTI ENUMERATION
    =============================== */

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

    /* ===== PROVIDER + VERIFIED CHECK ===== */

    if (
      userData.provider !== "local" ||
      userData.phoneVerified
    ) {
      return res.status(400).json({
        error: "Invalid code"
      });
    }

    /* ===== LOCK CHECK ===== */

    if (
      userData.phoneOtpBlockUntil &&
      now < userData.phoneOtpBlockUntil
    ) {

      const retryAfter = Math.ceil(
        (userData.phoneOtpBlockUntil - now) / 1000
      );

      return res.status(429).json({
        error:
          "Too many attempts. Try again later.",
        retryAfter
      });
    }

    /* ===== EXPIRATION CHECK ===== */

    if (
      !userData.phoneOTPExpires ||
      now > userData.phoneOTPExpires
    ) {

      await userRef.update({
        phoneOtpAttempts: 0
      });

      return res.status(400).json({
        error: "Invalid code"
      });
    }

    /* ===== WRONG OTP ===== */

    if (
      !userData.phoneOTP ||
      userData.phoneOTP !== cleanOtp
    ) {

      let attempts =
        (userData.phoneOtpAttempts || 0) + 1;

      const updateData = {
        phoneOtpAttempts: attempts
      };

      if (attempts >= MAX_ATTEMPTS) {
        updateData.phoneOtpBlockUntil =
          now + LOCK_TIME;
      }

      await userRef.update(updateData);

      if (attempts >= MAX_ATTEMPTS) {
        return res.status(429).json({
          error:
            "Too many attempts. Account locked for 1 hour.",
          retryAfter:
            Math.ceil(LOCK_TIME / 1000)
        });
      }

      return res.status(400).json({
        error: "Invalid code"
      });
    }

    /* ===============================
       ✅ SUCCESS
    =============================== */

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

    res.setHeader(
      "Set-Cookie",
      cookieOptions.join("; ")
    );

    return res.status(200).json({
      success: true
    });

  } catch (err) {

    console.error(
      "VERIFY PHONE OTP ERROR:",
      err
    );

    return res.status(500).json({
      error: "Server error"
    });
  }
}






// RESEND PHONE OTP
async function handleResendPhoneOtp(req, res) {

  const { phone } = req.body;

  if (!phone)
    return res.status(400).json({
      error: "Phone required"
    });

  try {

    const cleanPhone = phone.trim();
    const now = Date.now();

    /* ===== FORMAT CHECK ===== */

    if (!phoneRegex.test(cleanPhone)) {
      return res.status(400).json({
        error: "Invalid phone format"
      });
    }

    /* ===== FIND USER ===== */

    const snap = await db
      .ref("users")
      .orderByChild("phone")
      .equalTo(cleanPhone)
      .limitToFirst(1)
      .get();

    /* ===== ANTI ENUMERATION ===== */

    if (!snap.exists()) {
      return res.status(200).json({
        success: true,
        message: "If the account exists, a code was sent."
      });
    }

    const userData = Object.values(snap.val())[0];
    const userRef = db.ref("users/" + userData.uid);

    /* ===== ACCOUNT TYPE CHECK ===== */

    if (userData.provider !== "local")
      return res.status(400).json({
        error: "OTP not required for this account"
      });

    if (userData.phoneVerified)
      return res.status(400).json({
        error: "Phone already verified"
      });

    /* ===== 5 MINUTE COOLDOWN ===== */

    if (
      userData.phoneOTPExpires &&
      now < userData.phoneOTPExpires
    ) {

      const retryAfter = Math.ceil(
        (userData.phoneOTPExpires - now) / 1000
      );

      return res.status(429).json({
        error: "Please wait before requesting a new code",
        retryAfter
      });
    }

    /* ===== 5 PER HOUR LIMIT ===== */

    const MAX_RESEND_PER_HOUR = 5;
    const ONE_HOUR = 60 * 60 * 1000;

    let resendCount = userData.phoneResendCount || 0;
    let resendWindowStart =
      userData.phoneResendWindowStart || now;

    if (now - resendWindowStart >= ONE_HOUR) {
      resendCount = 0;
      resendWindowStart = now;
    }

    if (resendCount >= MAX_RESEND_PER_HOUR) {

      const retryAfter = Math.ceil(
        (ONE_HOUR - (now - resendWindowStart)) / 1000
      );

      return res.status(429).json({
        error: "Too many OTP requests. Try again later.",
        retryAfter
      });
    }

    /* ===== GENERATE NEW OTP ===== */

    const newOTP = generateOTP();
    const newExpiry = now + PHONE_OTP_VALIDITY;

    await userRef.update({
      phoneOTP: newOTP,
      phoneOTPExpires: newExpiry,
      phoneResendCount: resendCount + 1,
      phoneResendWindowStart: resendWindowStart,
      phoneOtpAttempts: 0,
      phoneOtpBlockUntil: null
    });

    /* ===== SEND SMS ===== */

    await sendPhoneOTP(cleanPhone, newOTP);

    return res.status(200).json({
      success: true,
      message: "New OTP sent",
      remainingResends:
        MAX_RESEND_PER_HOUR - (resendCount + 1)
    });

  } catch (err) {

    console.error("RESEND PHONE OTP ERROR:", err);

    return res.status(500).json({
      error: "Server error"
    });
  }
}






// ================= ACTION MAP =================

const actions = {
  register: handleRegister,
  login: handleLogin,
  verifyEmailOtp: handleVerifyEmailOtp,
  resendEmailOtp: handleResendEmailOtp,
  verifyPhoneOtp: handleVerifyPhoneOtp,
  resendPhoneOtp: handleResendPhoneOtp,
};

// ================= MAIN HANDLER =================

export default async function handler(req, res) {
  
  /* ===== CORS HEADERS ===== */
  
  if (allowedOrigin) {
    res.setHeader(
      "Access-Control-Allow-Origin",
      allowedOrigin
    );
    res.setHeader(
      "Access-Control-Allow-Credentials",
      "true"
    );
  }
  
  /* ===== HANDLE PREFLIGHT ===== */
  
  if (req.method === "OPTIONS") {
    res.setHeader(
      "Access-Control-Allow-Methods",
      "POST"
    );
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Content-Type"
    );
    return res.status(200).end();
  }
  
  /* ===== METHOD CHECK ===== */
  
  if (req.method !== "POST")
    return res.status(405).json({
      error: "Method not allowed"
    });
  
  /* ===== ORIGIN CHECK ===== */
  
  if (
    allowedOrigin &&
    req.headers.origin !== allowedOrigin
  )
    return res.status(403).json({
      error: "Forbidden"
    });
  
  /* ===== ACTION ROUTING ===== */
  
  const { action } = req.body || {};
  
  const fn = actions[action];
  
  if (!fn)
    return res.status(400).json({
      error: "Invalid action"
    });
  
  return fn(req, res);
}
