import admin from "firebase-admin";
import bcrypt from "bcryptjs";
import { v4 as uuidv4 } from "uuid";

const allowedOrigin = process.env.ALLOWED_ORIGIN;

if (!process.env.FIREBASE_KEY) {
  throw new Error("FIREBASE_KEY not set");
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

export default async function handler(req, res) {

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  if (allowedOrigin && req.headers.origin !== allowedOrigin) {
    return res.status(403).json({ error: "Forbidden" });
  }

  const { email, password } = req.body;

  if (!email || !password || password.length < 6) {
    return res.status(400).json({
      error: "Invalid email or password"
    });
  }

  try {

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

    const hashed = await bcrypt.hash(password, 12);

    const uid = uuidv4();

    await db.ref("users/" + uid).set({
      uid,
      email,
      password: hashed,
      provider: "local",
      createdAt: Date.now()
    });

    return res.status(201).json({ success: true });

  } catch (err) {
    return res.status(500).json({ error: "Server error" });
  }
      }
