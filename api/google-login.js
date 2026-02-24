import admin from "firebase-admin";
import jwt from "jsonwebtoken";

/* ================= ENV ================= */

const SECRET = process.env.JWT_SECRET;

/* ================= FIREBASE ADMIN INIT ================= */

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(
      JSON.parse(process.env.FIREBASE_KEY)
    ),
    databaseURL: "https://tutoriel-ff487-default-rtdb.firebaseio.com/"
  });
}

const db = admin.database();

/* ================= HANDLER ================= */

export default async function handler(req, res) {

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {

    /* ---------- FIX BODY PARSE ---------- */

    let body = req.body;

    if (typeof body === "string") {
      body = JSON.parse(body);
    }

    const idToken = body?.idToken;

    if (!idToken) {
      return res.status(400).json({ error: "Missing data" });
    }

    /* ---------- VERIFY GOOGLE TOKEN ---------- */

    const decoded = await admin.auth().verifyIdToken(idToken);

    const uid = decoded.uid;
    const email = decoded.email;
    const name = decoded.name || "Google User";

    if (!uid || !email) {
      return res.status(400).json({ error: "Invalid token data" });
    }

    /* ---------- SAVE USER IF NOT EXISTS ---------- */

    const userRef = db.ref("users/" + uid);
    const snap = await userRef.get();

    if (!snap.exists()) {

      await userRef.set({
        uid,
        username: name,
        email,
        provider: "google",
        createdAt: Date.now()
      });

    }

    /* ---------- CREATE JWT ---------- */

    const token = jwt.sign(
      { uid },
      SECRET,
      { expiresIn: "7d" }
    );

    return res.status(200).json({ token });

  } catch (error) {

    console.error("Google Login Error:", error);

    return res.status(401).json({
      error: "Invalid Google token"
    });
  }
  }
