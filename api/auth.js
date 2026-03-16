// auth.js
import admin from "firebase-admin";
import { sendOTPEmail } from "./mailer.js";

const allowedOrigin = process.env.ALLOWED_ORIGIN;
const isProd        = process.env.NODE_ENV === "production";

if (!process.env.FIREBASE_KEY) throw new Error("FIREBASE_KEY not set");

if (!admin.apps.length) {
  const serviceAccount = JSON.parse(process.env.FIREBASE_KEY);
  if (serviceAccount.private_key) {
    serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, "\n");
  }
  admin.initializeApp({
    credential:  admin.credential.cert(serviceAccount),
    databaseURL: process.env.FIREBASE_DATABASE_URL
  });
}

const db              = admin.firestore();
const usersCollection = db.collection("users");
const auth            = admin.auth();

// ── Constants ──────────────────────────────────────────────────────────────
const EMAIL_OTP_VALIDITY = 5 * 60 * 1000;
const RESET_OTP_VALIDITY = 5 * 60 * 1000;
const MAX_ATTEMPTS       = 5;
const LOCK_TIME          = 24 * 60 * 60 * 1000;

// ── UID generator ──────────────────────────────────────────────────────────
async function generateUID() {
  let uid, doc;
  do {
    uid = Math.floor(100000000 + Math.random() * 900000000).toString();
    doc = await usersCollection.doc(uid).get();
  } while (doc.exists);
  return uid;
}

function generateOTP() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

// ── Handler ────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Credentials", true);
  res.setHeader("Access-Control-Allow-Origin", allowedOrigin || "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");

  if (req.method === "OPTIONS") { res.status(200).end(); return; }
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed." });
  if (allowedOrigin && req.headers.origin !== allowedOrigin) return res.status(403).json({ error: "Forbidden." });

  const { action, ...payload } = req.body;
  if (!action) return res.status(400).json({ error: "Action required." });

  try {
    switch (action) {
      case "register":                 return await handleRegister(payload, res);
      case "login":                    return await handleLogin(payload, res);
      case "verify-otp":               return await handleVerifyOtp(payload, res);
      case "resend-otp":               return await handleResendOtp(payload, res);
      case "forgot-password-request":  return await handleForgotPasswordRequest(payload, res);
      case "forgot-password-verify":   return await handleForgotPasswordVerify(payload, res);
      case "forgot-password-reset":    return await handleForgotPasswordReset(payload, res);
      case "verify-password":          return await handleVerifyPassword(payload, res);
      default: return res.status(400).json({ error: "Invalid action." });
    }
  } catch (err) {
    console.error(`AUTH ERROR [${action}]:`, err);
    return res.status(500).json({ error: "An unexpected server error occurred." });
  }
}

// ── Register ───────────────────────────────────────────────────────────────
/**
 * 1. Crée l'utilisateur dans Firebase Auth (email + password)
 * 2. Crée le profil dans Firestore (sans champ password)
 * 3. emailVerified géré par Auth (false au départ)
 */
async function handleRegister(body, res) {
  const { email, password } = body;
  if (!email || !password || password.length < 6) {
    return res.status(400).json({
      error: "A valid email and a password of at least 6 characters are required."
    });
  }

  const emailLower = email.toLowerCase().trim();

  // Vérifier si email déjà utilisé dans Firestore (double sécurité)
  const existing = await usersCollection.where("email", "==", emailLower).limit(1).get();
  if (!existing.empty) {
    return res.status(400).json({ error: "An account with this email already exists." });
  }

  // Générer UID custom (9 chiffres) — utilisé comme documentId Firestore ET uid Auth
  const uid = await generateUID();
  const otp = generateOTP();

  // 1) Créer dans Firebase Auth avec l'uid custom
  //    emailVerified = false (Auth gère cet état)
  //    password stocké dans Auth (plus dans Firestore)
  try {
    await auth.createUser({
      uid:           uid,
      email:         emailLower,
      password:      password,
      emailVerified: false
    });
  } catch (authErr) {
    if (authErr.code === "auth/email-already-exists") {
      return res.status(400).json({ error: "An account with this email already exists." });
    }
    throw authErr;
  }

  // 2) Créer le profil Firestore (sans password, sans emailVerified)
  await usersCollection.doc(uid).set({
    uid,
    email:          emailLower,
    // ← password: supprimé (stocké dans Firebase Auth)
    // ← emailVerified: supprimé (géré par Firebase Auth)
    otp,
    otpExpires:     Date.now() + EMAIL_OTP_VALIDITY,
    otpAttempts:    0,
    createdAt:      Date.now(),
    username:       "",
    usernameLower:  "",
    friends:        [],
    friendRequests: [],
    sentRequests:   []
  });

  await sendOTPEmail(emailLower, otp);
  return res.status(201).json({ success: true, emailVerificationRequired: true });
}

// ── Login ──────────────────────────────────────────────────────────────────
/**
 * 1. Vérification email + password via Firebase Auth (signInWithEmailAndPassword côté Admin SDK)
 *    → On utilise auth.getUserByEmail() + firebase-admin ne supporte pas signIn direct
 *    → Solution: on vérifie via la REST API Firebase Auth (identitytoolkit)
 * 2. Vérifie emailVerified depuis Auth
 * 3. Retourne les infos utilisateur
 */
async function handleLogin(body, res) {
  const { identifier, password } = body;
  if (!identifier || !password)
    return res.status(400).json({ error: "Email and password are required." });

  const emailLower = identifier.toLowerCase().trim();

  // Récupérer l'utilisateur Auth par email
  let authUser;
  try {
    authUser = await auth.getUserByEmail(emailLower);
  } catch (e) {
    // Utilisateur inexistant dans Auth
    return res.status(400).json({ error: "Incorrect email or password." });
  }

  // Vérifier le mot de passe via Firebase Auth REST API
  const apiKey = process.env.FIREBASE_API_KEY;
  if (!apiKey) throw new Error("FIREBASE_API_KEY not set");

  const signInRes = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${apiKey}`,
    {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ email: emailLower, password, returnSecureToken: false })
    }
  );
  const signInData = await signInRes.json();
  if (!signInRes.ok || signInData.error) {
    return res.status(400).json({ error: "Incorrect email or password." });
  }

  // Vérifier le verrou OTP (stocké dans Firestore)
  const snap = await usersCollection.where("email", "==", emailLower).limit(1).get();
  if (snap.empty) return res.status(400).json({ error: "Incorrect email or password." });

  const userDoc  = snap.docs[0];
  const userData = userDoc.data();

  if (userData.otpLockUntil && Date.now() < userData.otpLockUntil) {
    return res.status(429).json({
      error: "Your account is temporarily locked. Please try again in 24 hours."
    });
  }

  // emailVerified vient de Firebase Auth (plus de Firestore)
  if (!authUser.emailVerified) {
    return res.status(403).json({
      error: "Your email address has not been verified.",
      emailNotVerified: true
    });
  }

  // Générer un Custom Token Firebase pour le client (optionnel mais propre)
  // On retourne simplement les infos user — le client utilise localStorage
  return res.status(200).json({
    success: true,
    user: {
      uid:      userData.uid,
      email:    userData.email,
      username: userData.username || ""
    }
  });
}

// ── Verify OTP ─────────────────────────────────────────────────────────────
/**
 * Vérifie le code OTP + marque emailVerified = true dans Firebase Auth
 * (plus de champ emailVerified dans Firestore)
 */
async function handleVerifyOtp(body, res) {
  const { identifier, otp } = body;
  if (!identifier || !otp)
    return res.status(400).json({ error: "Email and code are required." });

  const emailLower = identifier.toLowerCase().trim();
  const snap       = await usersCollection.where("email", "==", emailLower).limit(1).get();
  if (snap.empty) return res.status(400).json({ error: "User not found." });

  const userDoc  = snap.docs[0];
  const userData = userDoc.data();

  if (!userData.otpExpires || userData.otpExpires < Date.now()) {
    return res.status(400).json({ error: "This code has expired. Please request a new one." });
  }

  if (userData.otp !== otp.toString().trim()) {
    const attempts = (userData.otpAttempts || 0) + 1;
    if (attempts >= MAX_ATTEMPTS) {
      await userDoc.ref.update({ otpAttempts: attempts, otpLockUntil: Date.now() + LOCK_TIME });
      return res.status(429).json({
        error: "Too many incorrect attempts. Your account has been locked for 24 hours."
      });
    }
    await userDoc.ref.update({ otpAttempts: attempts });
    return res.status(400).json({
      error: `Incorrect code. ${MAX_ATTEMPTS - attempts} attempt(s) remaining.`
    });
  }

  // Marquer emailVerified = true dans Firebase Auth
  await auth.updateUser(userData.uid, { emailVerified: true });

  // Nettoyer les champs OTP dans Firestore (garder otpLockUntil si existant)
  await userDoc.ref.update({
    otp:         null,
    otpExpires:  null,
    otpAttempts: 0
    // emailVerified supprimé de Firestore → Auth le gère
  });

  return res.status(200).json({
    success: true,
    user: {
      uid:      userData.uid,
      email:    userData.email,
      username: userData.username || ""
    }
  });
}

// ── Resend OTP ─────────────────────────────────────────────────────────────
async function handleResendOtp(body, res) {
  const { identifier } = body;
  if (!identifier) return res.status(400).json({ error: "Email is required." });

  const snap = await usersCollection
    .where("email", "==", identifier.toLowerCase().trim())
    .limit(1)
    .get();
  if (snap.empty) return res.status(200).json({ success: true }); // silencieux

  const userDoc = snap.docs[0];
  const otp     = generateOTP();
  await userDoc.ref.update({
    otp,
    otpExpires:  Date.now() + EMAIL_OTP_VALIDITY,
    otpAttempts: 0
  });
  await sendOTPEmail(userDoc.data().email, otp);
  return res.status(200).json({ success: true });
}

// ── Forgot Password Request ────────────────────────────────────────────────
async function handleForgotPasswordRequest(body, res) {
  const { identifier } = body;
  if (!identifier) return res.status(400).json({ error: "Email is required." });

  const snap = await usersCollection
    .where("email", "==", identifier.toLowerCase().trim())
    .limit(1)
    .get();
  if (snap.empty) return res.status(200).json({ success: true }); // silencieux

  const otp = generateOTP();
  await snap.docs[0].ref.update({
    resetOTP:        otp,
    resetOTPExpires: Date.now() + RESET_OTP_VALIDITY
  });
  await sendOTPEmail(snap.docs[0].data().email, otp);
  return res.status(200).json({ success: true });
}

// ── Forgot Password Verify ─────────────────────────────────────────────────
async function handleForgotPasswordVerify(body, res) {
  const { identifier, otp } = body;
  if (!identifier || !otp)
    return res.status(400).json({ error: "Email and code are required." });

  const snap = await usersCollection
    .where("email", "==", identifier.toLowerCase().trim())
    .limit(1)
    .get();
  if (snap.empty) return res.status(400).json({ error: "User not found." });

  const userData = snap.docs[0].data();
  if (!userData.resetOTP || !userData.resetOTPExpires) {
    return res.status(400).json({ error: "No reset code found. Please request a new one." });
  }
  if (userData.resetOTPExpires < Date.now()) {
    return res.status(400).json({ error: "This code has expired. Please request a new one." });
  }
  if (userData.resetOTP !== otp.toString().trim()) {
    return res.status(400).json({ error: "Incorrect code. Please try again." });
  }

  return res.status(200).json({ success: true });
}

// ── Forgot Password Reset ──────────────────────────────────────────────────
/**
 * Reset le mot de passe directement dans Firebase Auth
 * (plus de bcrypt, plus de champ password dans Firestore)
 */
async function handleForgotPasswordReset(body, res) {
  const { identifier, otp, newPassword } = body;
  if (!identifier || !otp || !newPassword)
    return res.status(400).json({ error: "All fields are required." });
  if (newPassword.length < 6)
    return res.status(400).json({ error: "Password must be at least 6 characters." });

  const snap = await usersCollection
    .where("email", "==", identifier.toLowerCase().trim())
    .limit(1)
    .get();
  if (snap.empty) return res.status(400).json({ error: "Invalid request." });

  const userDoc  = snap.docs[0];
  const userData = userDoc.data();

  if (
    userData.resetOTP !== otp.toString().trim() ||
    !userData.resetOTPExpires ||
    userData.resetOTPExpires < Date.now()
  ) {
    return res.status(400).json({ error: "Invalid or expired code. Please start the process again." });
  }

  // Mettre à jour le mot de passe dans Firebase Auth
  await auth.updateUser(userData.uid, { password: newPassword });

  // Nettoyer les champs reset dans Firestore
  await userDoc.ref.update({
    resetOTP:        null,
    resetOTPExpires: null
    // password supprimé de Firestore → Auth le gère
  });

  return res.status(200).json({ success: true });
}

// ── Verify Password ────────────────────────────────────────────────────────
/**
 * Vérifie le mot de passe actuel via Firebase Auth REST API
 * (plus de bcrypt.compare sur le hash Firestore)
 */
async function handleVerifyPassword(body, res) {
  const { uid, password } = body;
  if (!uid || !password)
    return res.status(400).json({ error: "UID and password are required." });

  const userDoc = await usersCollection.doc(uid).get();
  if (!userDoc.exists) return res.status(404).json({ error: "User not found." });

  const email  = userDoc.data().email;
  const apiKey = process.env.FIREBASE_API_KEY;
  if (!apiKey) throw new Error("FIREBASE_API_KEY not set");

  const verifyRes = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${apiKey}`,
    {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ email, password, returnSecureToken: false })
    }
  );
  const verifyData = await verifyRes.json();
  const valid      = verifyRes.ok && !verifyData.error;

  return res.status(200).json({ success: true, valid });
}
