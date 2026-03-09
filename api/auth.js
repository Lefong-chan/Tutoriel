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

/* ================= FIREBASE INIT ================= */
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
const EMAIL_OTP_VALIDITY = 5 * 60 * 1000; 
const RESET_OTP_VALIDITY = 5 * 60 * 1000; 
const MAX_ATTEMPTS = 5;
const LOCK_TIME = 24 * 60 * 60 * 1000; 

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
  // CORS headers
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', allowedOrigin || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  
  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  if (allowedOrigin && req.headers.origin !== allowedOrigin) {
    return res.status(403).json({ error: "Forbidden" });
  }

  const { action, ...payload } = req.body;
  if (!action) return res.status(400).json({ error: "Action required" });

  try {
    switch (action) {
      case "register": return await handleRegister(payload, res);
      case "login": return await handleLogin(payload, res);
      case "verify-otp": return await handleVerifyOtp(payload, res);
      case "resend-otp": return await handleResendOtp(payload, res);
      case "forgot-password-request": return await handleForgotPasswordRequest(payload, res);
      case "forgot-password-reset": return await handleForgotPasswordReset(payload, res);
      case "verify-password": return await handleVerifyPassword(payload, res);
      default: return res.status(400).json({ error: "Invalid action" });
    }
  } catch (err) {
    console.error(`AUTH ERROR [${action}]:`, err);
    return res.status(500).json({ error: "Server error" });
  }
}

/* ================= FUNCTIONS ================= */

async function handleRegister(body, res) {
  const { email, password } = body;
  if (!email || !password || password.length < 6) {
    return res.status(400).json({ error: "Email sy tenimiafina (6+) no ilaina" });
  }

  const emailLower = email.toLowerCase().trim();
  const existingUser = await usersCollection.where("email", "==", emailLower).limit(1).get();
  if (!existingUser.empty) return res.status(400).json({ error: "Efa misy mampiasa io email io" });

  const hashedPassword = await bcrypt.hash(password, 12);
  const uid = await generateUID();
  const otp = generateOTP();

  await usersCollection.doc(uid).set({
    uid,
    email: emailLower,
    password: hashedPassword,
    emailVerified: false,
    otp: otp,
    otpExpires: Date.now() + EMAIL_OTP_VALIDITY,
    otpAttempts: 0,
    createdAt: Date.now(),
    username: "" // Vide au départ
  });

  await sendOTPEmail(emailLower, otp);
  return res.status(201).json({ success: true, emailVerificationRequired: true });
}

async function handleLogin(body, res) {
  const { identifier, password } = body;
  const emailLower = identifier.toLowerCase().trim();

  const snap = await usersCollection.where("email", "==", emailLower).limit(1).get();
  if (snap.empty) return res.status(400).json({ error: "Email na tenimiafina diso" });

  const userDoc = snap.docs[0];
  const userData = userDoc.data();

  if (userData.otpLockUntil && Date.now() < userData.otpLockUntil) {
    return res.status(429).json({ error: "Voasakana ny kaontinao (24h). Manandrama indray avy eo." });
  }

  const isMatch = await bcrypt.compare(password, userData.password);
  if (!isMatch) return res.status(400).json({ error: "Email na tenimiafina diso" });

  if (!userData.emailVerified) {
    return res.status(403).json({ error: "Mbola tsy voamarina ny email-nao", emailNotVerified: true });
  }

  const token = jwt.sign({ uid: userData.uid, email: userData.email }, SECRET, { expiresIn: "7d" });

  const cookieOptions = [
    `token=${token}`,
    "HttpOnly",
    "Max-Age=604800",
    "Path=/",
    `SameSite=${isProd ? "None" : "Lax"}`
  ];
  if (isProd) cookieOptions.push("Secure");
  
  res.setHeader("Set-Cookie", cookieOptions.join("; "));

  // Retourne les données utilisateur pour le localStorage
  return res.status(200).json({ 
    success: true, 
    user: { 
      uid: userData.uid, 
      email: userData.email,
      username: userData.username || "" 
    } 
  });
}

async function handleVerifyOtp(body, res) {
  const { identifier, otp } = body;
  const emailLower = identifier.toLowerCase().trim();
  const snap = await usersCollection.where("email", "==", emailLower).limit(1).get();

  if (snap.empty) return res.status(400).json({ error: "Tsy hita io mpampiasa io" });

  const userDoc = snap.docs[0];
  const userData = userDoc.data();

  if (userData.otpExpires < Date.now()) return res.status(400).json({ error: "Lany daty ny kaody" });
  
  if (userData.otp !== otp.toString().trim()) {
    let attempts = (userData.otpAttempts || 0) + 1;
    await userDoc.ref.update({ otpAttempts: attempts });
    if (attempts >= MAX_ATTEMPTS) {
      await userDoc.ref.update({ otpLockUntil: Date.now() + LOCK_TIME });
      return res.status(429).json({ error: "Be loatra ny andrana diso. Mihidy 24 ora ny kaonty." });
    }
    return res.status(400).json({ error: "Kaody diso" });
  }

  // Met à jour le statut de vérification
  await userDoc.ref.update({ emailVerified: true, otp: null, otpExpires: null, otpAttempts: 0 });

  // Retourne les données utilisateur
  return res.status(200).json({ 
    success: true,
    user: {
      uid: userData.uid,
      email: userData.email,
      username: userData.username || ""
    }
  });
}

async function handleResendOtp(body, res) {
  const { identifier } = body;
  const snap = await usersCollection.where("email", "==", identifier.toLowerCase().trim()).limit(1).get();
  if (snap.empty) return res.status(200).json({ success: true });

  const userDoc = snap.docs[0];
  const otp = generateOTP();
  await userDoc.ref.update({
    otp: otp,
    otpExpires: Date.now() + EMAIL_OTP_VALIDITY,
    otpAttempts: 0
  });

  await sendOTPEmail(userDoc.data().email, otp);
  return res.status(200).json({ success: true });
}

async function handleForgotPasswordRequest(body, res) {
  const { identifier } = body;
  const snap = await usersCollection.where("email", "==", identifier.toLowerCase().trim()).limit(1).get();
  if (snap.empty) return res.status(200).json({ success: true });

  const otp = generateOTP();
  await snap.docs[0].ref.update({
    resetOTP: otp,
    resetOTPExpires: Date.now() + RESET_OTP_VALIDITY
  });

  await sendOTPEmail(snap.docs[0].data().email, otp);
  return res.status(200).json({ success: true });
}

async function handleForgotPasswordReset(body, res) {
  const { identifier, otp, newPassword } = body;
  const snap = await usersCollection.where("email", "==", identifier.toLowerCase().trim()).limit(1).get();
  if (snap.empty) return res.status(400).json({ error: "Diso ny fanomezana" });

  const userDoc = snap.docs[0];
  const userData = userDoc.data();

  if (userData.resetOTP !== otp.toString().trim() || userData.resetOTPExpires < Date.now()) {
    return res.status(400).json({ error: "Kaody diso na lany daty" });
  }

  const hashed = await bcrypt.hash(newPassword, 12);
  await userDoc.ref.update({
    password: hashed,
    resetOTP: null,
    resetOTPExpires: null
  });

  return res.status(200).json({ success: true });
}

/**
 * Vérifie si le mot de passe fourni correspond à celui de l'utilisateur
 * Utilisé pour confirmer l'identité avant de changer le pseudo
 * 
 * @param {Object} body - Contient uid et password
 * @param {Object} res - Réponse HTTP
 */
async function handleVerifyPassword(body, res) {
  const { uid, password } = body;
  
  if (!uid || !password) {
    return res.status(400).json({ error: "UID sy password ilaina" });
  }

  try {
    const userDoc = await usersCollection.doc(uid).get();
    
    if (!userDoc.exists) {
      return res.status(404).json({ error: "Tsy hita ny mpampiasa" });
    }

    const userData = userDoc.data();
    const isMatch = await bcrypt.compare(password, userData.password);
    
    return res.status(200).json({
      success: true,
      valid: isMatch
    });
  } catch (error) {
    console.error("Error verifying password:", error);
    return res.status(500).json({ error: "Tsy nahomby ny fanamarinana ny password" });
  }
}
