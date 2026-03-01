import admin from "firebase-admin";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { sendVerificationEmail } from "./mailer.js";

const SECRET = process.env.JWT_SECRET;

if (!SECRET) throw new Error("JWT_SECRET not set");
if (!process.env.FIREBASE_KEY) throw new Error("FIREBASE_KEY not set");

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

/* ================= MAIN ================= */

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { action } = req.body;

  if (action === "register") return register(req, res);
  if (action === "verify") return verifyCode(req, res);
  if (action === "login") return login(req, res);

  return res.status(400).json({ error: "Invalid action" });
}

/* ================= REGISTER ================= */

async function register(req, res) {
  try {
    const { identifier, password } = req.body;

    const clean = identifier.trim().toLowerCase();

    const existing = await db
      .collection("users")
      .where("identifier", "==", clean)
      .limit(1)
      .get();

    if (!existing.empty)
      return res.status(400).json({ error: "User already exists" });

    const hashed = await bcrypt.hash(password, 10);

    const code = Math.floor(100000 + Math.random() * 900000).toString();

    await db.collection("users").add({
      identifier: clean,
      password: hashed,
      verified: false,
      verificationCode: code,
      codeExpires: Date.now() + 10 * 60 * 1000,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    await sendVerificationEmail(clean, code);

    return res.json({
      message: "Verification code sent",
    });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Server error" });
  }
}

/* ================= VERIFY ================= */

async function verifyCode(req, res) {
  try {
    const { identifier, code } = req.body;

    const snapshot = await db
      .collection("users")
      .where("identifier", "==", identifier.toLowerCase())
      .limit(1)
      .get();

    if (snapshot.empty)
      return res.status(400).json({ error: "User not found" });

    const doc = snapshot.docs[0];
    const user = doc.data();

    if (user.verified)
      return res.status(400).json({ error: "Already verified" });

    if (user.verificationCode !== code)
      return res.status(400).json({ error: "Invalid code" });

    if (Date.now() > user.codeExpires)
      return res.status(400).json({ error: "Code expired" });

    await doc.ref.update({
      verified: true,
      verificationCode: null,
      codeExpires: null,
    });

    return res.json({ message: "Account verified!" });

  } catch (err) {
    return res.status(500).json({ error: "Server error" });
  }
}

/* ================= LOGIN ================= */

async function login(req, res) {
  try {
    const { identifier, password } = req.body;

    const snapshot = await db
      .collection("users")
      .where("identifier", "==", identifier.toLowerCase())
      .limit(1)
      .get();

    if (snapshot.empty)
      return res.status(401).json({ error: "Invalid credentials" });

    const doc = snapshot.docs[0];
    const user = doc.data();

    if (!user.verified)
      return res.status(403).json({
        error: "Please verify your account first",
      });

    const match = await bcrypt.compare(password, user.password);

    if (!match)
      return res.status(401).json({ error: "Invalid credentials" });

    const token = jwt.sign(
      { uid: doc.id },
      SECRET,
      { expiresIn: "7d" }
    );

    return res.json({ token });

  } catch (err) {
    return res.status(500).json({ error: "Server error" });
  }
}
