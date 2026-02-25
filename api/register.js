import admin from "firebase-admin";
import bcrypt from "bcryptjs";
import { v4 as uuidv4 } from "uuid";

const allowedOrigin = process.env.ALLOWED_ORIGIN;

// ✅ Check FIREBASE_KEY
if (!process.env.FIREBASE_KEY) {
  throw new Error("FIREBASE_KEY is not defined in environment variables");
}

// ✅ Initialize Firebase safely
if (!admin.apps.length) {
  const serviceAccount = JSON.parse(process.env.FIREBASE_KEY);

  // 🔥 Fix newline issue (very important on Vercel)
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

export default async function handler(req, res) {

  // ✅ Only POST allowed
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // ✅ Optional origin check (raha tianao)
  if (allowedOrigin && req.headers.origin !== allowedOrigin) {
    return res.status(403).json({ error: "Forbidden" });
  }

  const { email, password } = req.body;

  // ✅ Basic validation
  if (!email || !password || password.length < 6) {
    return res.status(400).json({
      error: "Invalid email or password"
    });
  }

  try {

    // 🔎 Check if email already exists
    const existing = await db
      .ref("users")
      .orderByChild("email")
      .equalTo(email)
      .limitToFirst(1)
      .get();

    if (existing.exists()) {
      return res.status(400).json({
        error: "Email already registered"
      });
    }

    // 🔐 Hash password
    const hashed = await bcrypt.hash(password, 12);

    const uid = uuidv4();

    // 💾 Save user
    await db.ref("users/" + uid).set({
      uid,
      email,
      password: hashed,
      provider: "local",
      createdAt: Date.now()
    });

    return res.status(201).json({
      success: true
    });

  } catch (err) {

    // 🔥 Show real error in logs
    console.error("REGISTER ERROR:", err);

    return res.status(500).json({
      error: err.message
    });
  }
      }
