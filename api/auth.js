// ================================
// 🔐 AUTH API (Register + Login)
// ================================

import admin from "firebase-admin";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";

/* ================= ENV ================= */

const SECRET = process.env.JWT_SECRET;
const allowedOrigin = process.env.ALLOWED_ORIGIN;

if (!SECRET) throw new Error("JWT_SECRET not set");
if (!process.env.FIREBASE_KEY) throw new Error("FIREBASE_KEY not set");

/* ================= FIREBASE INIT ================= */

if (!admin.apps.length) {
  const serviceAccount = JSON.parse(process.env.FIREBASE_KEY);

  // Fix newline issue on Vercel
  if (serviceAccount.private_key) {
    serviceAccount.private_key =
      serviceAccount.private_key.replace(/\\n/g, "\n");
  }

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}

const db = admin.firestore();

/* ================= HELPER ================= */

function setCORS(res) {
  res.setHeader("Access-Control-Allow-Origin", allowedOrigin);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

/* ================= MAIN HANDLER ================= */

export default async function handler(req, res) {
  setCORS(res);

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { action } = req.body;

  if (action === "register") {
    return register(req, res);
  }

  if (action === "login") {
    return login(req, res);
  }

  return res.status(400).json({ error: "Invalid action" });
}

/* =========================================================
   📝 REGISTER
========================================================= */

async function register(req, res) {
  try {
    const { identifier, password } = req.body;

    if (!identifier || !password) {
      return res.status(400).json({
        error: "Email or phone and valid password required",
      });
    }

    const cleanIdentifier = identifier.trim().toLowerCase();

    const isEmail = cleanIdentifier.includes("@");

    // Check if already exists
    const existingUser = await db
      .collection("users")
      .where("identifier", "==", cleanIdentifier)
      .limit(1)
      .get();

    if (!existingUser.empty) {
      return res.status(400).json({
        error: "User already registered",
      });
    }

    // Hash password
    const hashedPassword = await bcrypt.hash(password, 10);

    // Save user
    const newUser = {
      identifier: cleanIdentifier,
      type: isEmail ? "email" : "phone",
      password: hashedPassword,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    const docRef = await db.collection("users").add(newUser);

    return res.status(201).json({
      message: "Account created successfully",
      userId: docRef.id,
    });
  } catch (err) {
    console.error("REGISTER ERROR:", err);
    return res.status(500).json({ error: "Server error" });
  }
}

/* =========================================================
   🔑 LOGIN
========================================================= */

async function login(req, res) {
  try {
    const { identifier, password } = req.body;

    if (!identifier || !password) {
      return res.status(400).json({
        error: "Invalid credentials",
      });
    }

    const cleanIdentifier = identifier.trim().toLowerCase();

    const userSnapshot = await db
      .collection("users")
      .where("identifier", "==", cleanIdentifier)
      .limit(1)
      .get();

    if (userSnapshot.empty) {
      return res.status(401).json({
        error: "Invalid credentials",
      });
    }

    const userDoc = userSnapshot.docs[0];
    const user = userDoc.data();

    const isMatch = await bcrypt.compare(password, user.password);

    if (!isMatch) {
      return res.status(401).json({
        error: "Invalid credentials",
      });
    }

    // Generate JWT
    const token = jwt.sign(
      {
        uid: userDoc.id,
        identifier: user.identifier,
      },
      SECRET,
      { expiresIn: "7d" }
    );

    return res.status(200).json({
      message: "Login successful",
      token,
    });
  } catch (err) {
    console.error("LOGIN ERROR:", err);
    return res.status(500).json({ error: "Server error" });
  }
}
