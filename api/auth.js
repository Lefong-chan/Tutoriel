import admin from "firebase-admin";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { sendVerificationEmail } from "./mailer.js";

/* ================= ENV ================= */

const SECRET = process.env.JWT_SECRET;
const NODE_ENV = process.env.NODE_ENV || "development";
const allowedOrigin =
  NODE_ENV === "production"
    ? process.env.ALLOWED_ORIGIN
    : "*";

if (!SECRET) throw new Error("JWT_SECRET not set");
if (!process.env.FIREBASE_KEY) throw new Error("FIREBASE_KEY not set");

/* ================= FIREBASE INIT ================= */

if (!admin.apps.length) {
  const serviceAccount = JSON.parse(process.env.FIREBASE_KEY);

  if (serviceAccount.private_key) {
    serviceAccount.private_key =
      serviceAccount.private_key.replace(/\\n/g, "\n");
  }

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}

const db = admin.firestore();

/* ================= HELPERS ================= */

function setCORS(res) {
  res.setHeader("Access-Control-Allow-Origin", allowedOrigin);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function normalizeIdentifier(identifier = "") {
  if (typeof identifier !== "string") return null;

  const raw = identifier.trim();
  if (!raw) return null;

  if (raw.includes("@")) {
    return { clean: raw.toLowerCase(), type: "email" };
  }

  const phone = raw.replace(/\s+/g, "");
  const malagasyRegex = /^03\d{8}$/;

  if (!malagasyRegex.test(phone)) return null;

  return { clean: phone, type: "phone" };
}

function generateCode() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

/* ================= MAIN ================= */

export default async function handler(req, res) {
  setCORS(res);

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST")
    return res.status(405).json({ error: "Method not allowed" });

  const { action } = req.body || {};
  if (!action)
    return res.status(400).json({ error: "Missing action" });

  try {
    if (action === "register") return await register(req, res);
    if (action === "verify") return await verify(req, res);
    if (action === "login") return await login(req, res);

    return res.status(400).json({ error: "Invalid action" });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Server error" });
  }
}

/* ================= REGISTER ================= */

async function register(req, res) {
  const { identifier, password } = req.body || {};

  if (!identifier || !password)
    return res.status(400).json({ error: "All fields required" });

  if (password.length < 6)
    return res.status(400).json({ error: "Password too short" });

  const normalized = normalizeIdentifier(identifier);
  if (!normalized)
    return res.status(400).json({ error: "Invalid identifier" });

  const { clean, type } = normalized;
  const docRef = db.collection("users").doc(clean);

  const existing = await docRef.get();
  if (existing.exists)
    return res.status(400).json({ error: "User already registered" });

  const hashedPassword = await bcrypt.hash(password, 12);
  const code = generateCode();
  const hashedCode = await bcrypt.hash(code, 10);

  await docRef.set({
    identifier: clean,
    type,
    password: hashedPassword,
    isVerified: false,
    verificationCode: hashedCode,
    verificationExpires: Date.now() + 10 * 60 * 1000,
    verificationAttempts: 0,
    loginAttempts: 0,
    loginBlockedUntil: null,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  /* === MANDEFA EMAIL === */
  if (type === "email") {
    await sendVerificationEmail(clean, code);
  }

  return res.status(201).json({
    message: "Account created. Enter verification code.",
  });
}

/* ================= VERIFY ================= */

async function verify(req, res) {
  const { identifier, code } = req.body || {};

  if (!identifier || !code)
    return res.status(400).json({ error: "Invalid request" });

  const normalized = normalizeIdentifier(identifier);
  if (!normalized)
    return res.status(400).json({ error: "Invalid identifier" });

  const docRef = db.collection("users").doc(normalized.clean);
  const snapshot = await docRef.get();

  if (!snapshot.exists)
    return res.status(400).json({ error: "User not found" });

  const user = snapshot.data();

  if (user.isVerified)
    return res.status(400).json({ error: "Already verified" });

  if (!user.verificationExpires || Date.now() > user.verificationExpires)
    return res.status(400).json({ error: "Code expired" });

  if (user.verificationAttempts >= 5)
    return res.status(429).json({ error: "Too many attempts" });

  const match = await bcrypt.compare(code, user.verificationCode);

  if (!match) {
    await docRef.update({
      verificationAttempts: user.verificationAttempts + 1,
    });
    return res.status(400).json({ error: "Invalid code" });
  }

  await docRef.update({
    isVerified: true,
    verificationCode: admin.firestore.FieldValue.delete(),
    verificationExpires: admin.firestore.FieldValue.delete(),
    verificationAttempts: admin.firestore.FieldValue.delete(),
  });

  return res.status(200).json({ message: "Account verified" });
}

/* ================= LOGIN ================= */

async function login(req, res) {
  const { identifier, password } = req.body || {};

  if (!identifier || !password)
    return res.status(400).json({ error: "All fields required" });

  const normalized = normalizeIdentifier(identifier);
  if (!normalized)
    return res.status(400).json({ error: "Invalid identifier" });

  const docRef = db.collection("users").doc(normalized.clean);
  const snapshot = await docRef.get();

  if (!snapshot.exists)
    return res.status(401).json({ error: "Invalid credentials" });

  const user = snapshot.data();

  if (!user.isVerified)
    return res.status(403).json({ error: "Account not verified" });

  if (user.loginBlockedUntil && Date.now() < user.loginBlockedUntil)
    return res.status(429).json({ error: "Account locked" });

  const match = await bcrypt.compare(password, user.password);

  if (!match) {
    const attempts = (user.loginAttempts || 0) + 1;

    await docRef.update({
      loginAttempts: attempts,
      loginBlockedUntil:
        attempts >= 5 ? Date.now() + 15 * 60 * 1000 : null,
    });

    return res.status(401).json({ error: "Invalid credentials" });
  }

  await docRef.update({
    loginAttempts: 0,
    loginBlockedUntil: null,
  });

  const token = jwt.sign(
    { uid: snapshot.id },
    SECRET,
    { expiresIn: "7d" }
  );

  return res.status(200).json({
    message: "Login successful",
    token,
  });
}
