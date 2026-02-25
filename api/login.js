import admin from "firebase-admin";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";

const SECRET = process.env.JWT_SECRET;
const allowedOrigin = process.env.ALLOWED_ORIGIN;

if (!SECRET) {
  throw new Error("JWT_SECRET not set");
}

if (!process.env.FIREBASE_KEY) {
  throw new Error("FIREBASE_KEY not set");
}

if (!admin.apps.length) {

  const serviceAccount = JSON.parse(process.env.FIREBASE_KEY);

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

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  if (allowedOrigin && req.headers.origin !== allowedOrigin) {
    return res.status(403).json({ error: "Forbidden" });
  }

  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: "Invalid credentials" });
  }

  try {

    const emailLower = email.toLowerCase();

    const snap = await db
      .ref("users")
      .orderByChild("email")
      .equalTo(emailLower)
      .limitToFirst(1)
      .get();

    if (!snap.exists()) {
      return res.status(400).json({ error: "Invalid credentials" });
    }

    const userData = Object.values(snap.val())[0];

    if (userData.provider !== "local") {
      return res.status(400).json({
        error: "Use Google login"
      });
    }

    const isMatch = await bcrypt.compare(
      password,
      userData.password
    );

    if (!isMatch) {
      return res.status(400).json({ error: "Invalid credentials" });
    }

    const token = jwt.sign(
      {
        uid: userData.uid,
        email: userData.email
      },
      SECRET,
      { expiresIn: "2h" }
    );

    return res.status(200).json({
      success: true,
      token
    });

  } catch (err) {

    console.error("LOGIN ERROR:", err);

    return res.status(500).json({
      error: "Server error"
    });
  }
  }
