import admin from "firebase-admin";
import bcrypt from "bcryptjs";

const allowedOrigin = process.env.ALLOWED_ORIGIN;

if (!process.env.FIREBASE_KEY) {
  throw new Error("FIREBASE_KEY is not defined in environment variables");
}

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(
      JSON.parse(process.env.FIREBASE_KEY)
    ),
    databaseURL:
      "https://tutoriel-ff487-default-rtdb.firebaseio.com/"
  });
}

const db = admin.database();

function generateUID() {
  return Math.floor(100000000 + Math.random() * 900000000).toString();
}

export default async function handler(req, res) {

  // Allow only POST
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // Optional origin protection (remove if WebView causes issue)
  if (allowedOrigin && req.headers.origin !== allowedOrigin) {
    return res.status(403).json({ error: "Forbidden origin" });
  }

  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: "Missing email or password" });
  }

  // Basic validation
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) {
    return res.status(400).json({ error: "Invalid email format" });
  }

  if (password.length < 6) {
    return res.status(400).json({
      error: "Password must be at least 6 characters"
    });
  }

  try {

    // 🔥 Faster email check (no full scan)
    const snap = await db
      .ref("users")
      .orderByChild("email")
      .equalTo(email)
      .limitToFirst(1)
      .get();

    if (snap.exists()) {
      return res.status(400).json({
        error: "Email already registered"
      });
    }

    const hashed = await bcrypt.hash(password, 10);

    // Secure UID generation with collision check
    let uid;
    let exists = true;

    while (exists) {
      uid = generateUID();
      const check = await db.ref("users/" + uid).get();
      if (!check.exists()) exists = false;
    }

    await db.ref("users/" + uid).set({
      uid,
      email,
      password: hashed,
      provider: "local",
      createdAt: Date.now()
    });

    return res.status(201).json({
      success: true,
      message: "User registered successfully"
    });

  } catch (error) {
    console.error("Register error:", error);
    return res.status(500).json({
      error: "Server error"
    });
  }
}
