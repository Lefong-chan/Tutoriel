import admin from "firebase-admin";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";

const SECRET = process.env.JWT_SECRET;

if (!SECRET) {
  throw new Error("JWT_SECRET not set");
}

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

  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: "Invalid credentials" });
  }

  try {

    const snap = await db
      .ref("users")
      .orderByChild("email")
      .equalTo(email)
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

    return res.status(200).json({ token });

  } catch (err) {
    return res.status(500).json({ error: "Server error" });
  }
}
